use asa_core::{AsaPaths, Observation};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use thiserror::Error;

const MAGIC: &[u8; 8] = b"ASASEG01";
const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;
#[cfg(not(test))]
const MAX_SEGMENT_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(test)]
const MAX_SEGMENT_BYTES: u64 = 1_024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppendOutcome {
    Appended,
    Duplicate,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("observation encoding failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("segment record exceeds {MAX_RECORD_BYTES} bytes")]
    Oversized,
    #[error("segment has an invalid header")]
    InvalidHeader,
    #[error("segment record checksum mismatch at byte {0}")]
    Checksum(u64),
}

/// One lock-protected append-only segment. `sync_data` completes before the
/// caller can acknowledge an observation.
pub struct SegmentStore {
    path: PathBuf,
    sealed_dir: PathBuf,
    file: Mutex<File>,
    seen: Mutex<HashSet<String>>,
}

impl SegmentStore {
    pub fn open(paths: &AsaPaths) -> Result<Self, StoreError> {
        fs::create_dir_all(paths.segments_active())?;
        fs::create_dir_all(paths.segments_sealed())?;
        let path = paths.segments_active().join("observations.seg");
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)?;
        file.lock_exclusive()?;
        if file.metadata()?.len() == 0 {
            file.write_all(MAGIC)?;
            file.sync_data()?;
        }
        let observations = recover_observations(paths)?;
        let seen = observations
            .into_iter()
            .map(|observation| observation.id)
            .collect();
        Ok(Self {
            path,
            sealed_dir: paths.segments_sealed(),
            file: Mutex::new(file),
            seen: Mutex::new(seen),
        })
    }

    pub fn append(&self, observation: &Observation) -> Result<AppendOutcome, StoreError> {
        // Keep the identity guard until the durable append has completed.
        // Otherwise two concurrent clients can both pass the lookup and append
        // the same at-least-once observation.
        let mut seen = self.seen.lock().expect("seen mutex poisoned");
        if seen.contains(&observation.id) {
            return Ok(AppendOutcome::Duplicate);
        }
        let frame = encode_frame(observation)?;

        let mut file = self.file.lock().expect("file mutex poisoned");
        if file.metadata()?.len().saturating_add(frame.len() as u64) > MAX_SEGMENT_BYTES
            && file.metadata()?.len() > MAGIC.len() as u64
        {
            file.sync_data()?;
            fs::create_dir_all(&self.sealed_dir)?;
            let sealed = self
                .sealed_dir
                .join(format!("observations-{}.seg", uuid::Uuid::now_v7()));
            fs::rename(&self.path, sealed)?;
            fs::File::open(
                self.path
                    .parent()
                    .expect("active segment always has a parent"),
            )?
            .sync_all()?;
            let mut replacement = OpenOptions::new()
                .create_new(true)
                .read(true)
                .append(true)
                .open(&self.path)?;
            replacement.lock_exclusive()?;
            replacement.write_all(MAGIC)?;
            replacement.sync_data()?;
            *file = replacement;
        }
        file.write_all(&frame)?;
        file.sync_data()?;
        seen.insert(observation.id.clone());
        Ok(AppendOutcome::Appended)
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn recover_observations(paths: &AsaPaths) -> Result<Vec<Observation>, StoreError> {
    let mut files = segment_paths(paths)?;
    files.sort();
    let active = paths.segments_active().join("observations.seg");
    if active.exists() {
        files.push(active);
    }
    let mut seen = HashSet::new();
    let mut observations = Vec::new();
    for path in files {
        for observation in recover_file(&path, path.starts_with(paths.segments_active()))? {
            if seen.insert(observation.id.clone()) {
                observations.push(observation);
            }
        }
    }
    Ok(observations)
}

pub fn remove_session_observations(
    paths: &AsaPaths,
    session_id: &str,
) -> Result<usize, StoreError> {
    fs::create_dir_all(paths.segments_active())?;
    let active = paths.segments_active().join("observations.seg");
    let active_lock = if active.exists() {
        let lock = OpenOptions::new().read(true).write(true).open(&active)?;
        lock.try_lock_exclusive()?;
        Some(lock)
    } else {
        None
    };
    let mut files = segment_paths(paths)?;
    if active.exists() {
        files.push(active);
    }
    let mut removed = 0;
    for path in files {
        let observations = recover_file(&path, path.starts_with(paths.segments_active()))?;
        let original_count = observations.len();
        let retained = observations
            .into_iter()
            .filter(|observation| observation.session_id != session_id)
            .collect::<Vec<_>>();
        let removed_here = original_count.saturating_sub(retained.len());
        if removed_here == 0 {
            continue;
        }
        let temporary = path.with_extension(format!("rewrite-{}.tmp", uuid::Uuid::now_v7()));
        write_segment(&temporary, &retained)?;
        fs::rename(&temporary, &path)?;
        fs::File::open(path.parent().expect("segment always has a parent"))?.sync_all()?;
        removed += removed_here;
    }
    drop(active_lock);
    Ok(removed)
}

fn segment_paths(paths: &AsaPaths) -> Result<Vec<PathBuf>, StoreError> {
    if !paths.segments_sealed().exists() {
        return Ok(Vec::new());
    }
    fs::read_dir(paths.segments_sealed())?
        .filter_map(|entry| match entry {
            Ok(entry)
                if entry.path().extension().and_then(|value| value.to_str()) == Some("seg") =>
            {
                Some(Ok(entry.path()))
            }
            Ok(_) => None,
            Err(error) => Some(Err(StoreError::Io(error))),
        })
        .collect()
}

fn write_segment(path: &Path, observations: &[Observation]) -> Result<(), StoreError> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(MAGIC)?;
    for observation in observations {
        file.write_all(&encode_frame(observation)?)?;
    }
    file.sync_data()?;
    Ok(())
}

fn encode_frame(observation: &Observation) -> Result<Vec<u8>, StoreError> {
    let payload = serde_json::to_vec(observation)?;
    if payload.len() > MAX_RECORD_BYTES {
        return Err(StoreError::Oversized);
    }
    let checksum = Sha256::digest(&payload);
    let mut frame = Vec::with_capacity(4 + payload.len() + checksum.len());
    let payload_length = u32::try_from(payload.len()).map_err(|_| StoreError::Oversized)?;
    frame.extend_from_slice(&payload_length.to_be_bytes());
    frame.extend_from_slice(&payload);
    frame.extend_from_slice(&checksum);
    Ok(frame)
}

fn recover_file(path: &Path, truncate_partial_tail: bool) -> Result<Vec<Observation>, StoreError> {
    let file = OpenOptions::new()
        .read(true)
        .write(truncate_partial_tail)
        .open(path)?;
    let mut reader = BufReader::new(file);
    let mut magic = [0_u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(StoreError::InvalidHeader);
    }
    let mut observations = Vec::new();
    let mut valid_end = MAGIC.len() as u64;
    loop {
        let frame_start = valid_end;
        let mut length = [0_u8; 4];
        match reader.read_exact(&mut length) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                if truncate_partial_tail {
                    reader.get_mut().set_len(valid_end)?;
                }
                break;
            }
            Err(error) => return Err(error.into()),
        }
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_RECORD_BYTES {
            return Err(StoreError::Oversized);
        }
        let mut payload = vec![0_u8; length];
        let mut checksum = [0_u8; 32];
        if reader.read_exact(&mut payload).is_err() || reader.read_exact(&mut checksum).is_err() {
            if truncate_partial_tail {
                reader.get_mut().set_len(valid_end)?;
            }
            break;
        }
        if Sha256::digest(&payload).as_slice() != checksum {
            return Err(StoreError::Checksum(frame_start));
        }
        observations.push(serde_json::from_slice(&payload)?);
        valid_end += 4 + length as u64 + 32;
    }
    reader.get_mut().seek(SeekFrom::End(0))?;
    Ok(observations)
}

#[cfg(test)]
mod tests {
    use super::*;
    use asa_core::{AsaPaths, ObservationKind};
    use std::collections::BTreeMap;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use tempfile::TempDir;
    use time::OffsetDateTime;

    fn observation(id: &str) -> Observation {
        Observation {
            schema_version: 1,
            id: id.to_owned(),
            adapter: "codex".to_owned(),
            native_event: "Stop".to_owned(),
            kind: ObservationKind::AgentStopped,
            observed_at: OffsetDateTime::UNIX_EPOCH,
            session_id: "codex:s1".to_owned(),
            turn_id: Some("t1".to_owned()),
            invocation_id: None,
            attributes: BTreeMap::new(),
        }
    }

    #[test]
    fn durable_append_is_idempotent_across_restart() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        {
            let store = SegmentStore::open(&paths).unwrap();
            assert_eq!(
                store.append(&observation("one")).unwrap(),
                AppendOutcome::Appended
            );
            assert_eq!(
                store.append(&observation("one")).unwrap(),
                AppendOutcome::Duplicate
            );
        }
        let store = SegmentStore::open(&paths).unwrap();
        assert_eq!(
            store.append(&observation("one")).unwrap(),
            AppendOutcome::Duplicate
        );
        assert_eq!(recover_observations(&paths).unwrap().len(), 1);
    }

    #[test]
    fn partial_tail_is_truncated_during_recovery() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let path;
        {
            let store = SegmentStore::open(&paths).unwrap();
            store.append(&observation("one")).unwrap();
            path = store.path().to_owned();
        }
        let valid_length = fs::metadata(&path).unwrap().len();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[0, 0, 0, 100, 1, 2])
            .unwrap();
        assert_eq!(recover_observations(&paths).unwrap().len(), 1);
        assert_eq!(fs::metadata(&path).unwrap().len(), valid_length);
    }

    #[test]
    fn simultaneous_duplicate_delivery_appends_once() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let store = Arc::new(SegmentStore::open(&paths).unwrap());
        let threads = (0..16)
            .map(|_| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || store.append(&observation("same")).unwrap())
            })
            .collect::<Vec<_>>();
        let outcomes = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == AppendOutcome::Appended)
                .count(),
            1
        );
        assert_eq!(recover_observations(&paths).unwrap().len(), 1);
    }

    #[test]
    fn active_segment_seals_at_the_bound_and_recovery_reads_all_segments() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        {
            let store = SegmentStore::open(&paths).unwrap();
            for index in 0..8 {
                store
                    .append(&observation(&format!("observation-{index}")))
                    .unwrap();
            }
        }
        assert!(segment_paths(&paths).unwrap().len() > 1);
        assert_eq!(recover_observations(&paths).unwrap().len(), 8);
    }

    #[test]
    fn restart_between_sealed_rename_and_active_replacement_recovers() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let mut count = 0;
        {
            let store = SegmentStore::open(&paths).unwrap();
            loop {
                let next = observation(&format!("pre-seal-{count}"));
                let current_length = fs::metadata(store.path()).unwrap().len();
                if current_length + encode_frame(&next).unwrap().len() as u64 > MAX_SEGMENT_BYTES {
                    break;
                }
                store.append(&next).unwrap();
                count += 1;
            }
        }
        assert!(count > 0);
        let active = paths.segments_active().join("observations.seg");
        fs::create_dir_all(paths.segments_sealed()).unwrap();
        fs::rename(
            &active,
            paths.segments_sealed().join("interrupted-seal.seg"),
        )
        .unwrap();
        fs::File::open(paths.segments_active())
            .unwrap()
            .sync_all()
            .unwrap();

        assert_eq!(recover_observations(&paths).unwrap().len(), count);
        let store = SegmentStore::open(&paths).unwrap();
        assert!(store.path().exists());
        assert_eq!(
            store.append(&observation("after-restart")).unwrap(),
            AppendOutcome::Appended
        );
        assert_eq!(recover_observations(&paths).unwrap().len(), count + 1);
    }

    #[test]
    fn process_crashes_recover_before_append_after_fsync_and_after_seal() {
        for (mode, expected) in [
            ("before-append", 0_usize),
            ("after-append", 1),
            ("after-seal", 8),
        ] {
            let temp = TempDir::new().unwrap();
            let status = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "segment::tests::crash_process_helper",
                    "--nocapture",
                ])
                .env("ASA_CRASH_TEST_ROOT", temp.path())
                .env("ASA_CRASH_TEST_MODE", mode)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(!status.success(), "{mode} helper must terminate abruptly");
            let paths = AsaPaths::discover(Some(temp.path())).unwrap();
            assert_eq!(
                recover_observations(&paths).unwrap().len(),
                expected,
                "recovery mismatch for {mode}"
            );
            let store = SegmentStore::open(&paths).unwrap();
            if expected > 0 {
                assert_eq!(
                    store.append(&observation("crash-0")).unwrap(),
                    AppendOutcome::Duplicate
                );
            }
        }
    }

    #[test]
    fn crash_process_helper() {
        let Some(root) = std::env::var_os("ASA_CRASH_TEST_ROOT") else {
            return;
        };
        let paths = AsaPaths::discover(Some(Path::new(&root))).unwrap();
        let mode = std::env::var("ASA_CRASH_TEST_MODE").unwrap();
        if mode == "before-append" {
            std::process::abort();
        }
        let store = SegmentStore::open(&paths).unwrap();
        let count = if mode == "after-seal" { 8 } else { 1 };
        for index in 0..count {
            store
                .append(&observation(&format!("crash-{index}")))
                .unwrap();
        }
        std::process::abort();
    }
}
