use crate::{AppendOutcome, SegmentStore};
use asa_core::{AsaPaths, Observation};
use std::{
    fs,
    io::{self, Write},
    path::PathBuf,
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum SpoolError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("spool encoding failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn spool_observation(
    paths: &AsaPaths,
    observation: &Observation,
) -> Result<PathBuf, SpoolError> {
    fs::create_dir_all(paths.spool_pending())?;
    let final_path = paths.spool_pending().join(format!(
        "{}-{}.json",
        Uuid::now_v7(),
        safe_id(&observation.id)
    ));
    let temporary = final_path.with_extension("tmp");
    let mut file = fs::File::create(&temporary)?;
    serde_json::to_writer(&mut file, observation)?;
    file.flush()?;
    file.sync_data()?;
    fs::rename(&temporary, &final_path)?;
    sync_directory(&paths.spool_pending())?;
    Ok(final_path)
}

pub fn drain_spool(paths: &AsaPaths, store: &SegmentStore) -> Result<usize, SpoolError> {
    fs::create_dir_all(paths.spool_pending())?;
    fs::create_dir_all(paths.spool_rejected())?;
    let mut entries = fs::read_dir(paths.spool_pending())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    entries.sort();
    let mut drained = 0;
    for path in entries {
        if let Ok(observation) = fs::read(&path)
            .map_err(SpoolError::from)
            .and_then(|bytes| serde_json::from_slice::<Observation>(&bytes).map_err(Into::into))
        {
            match store.append(&observation) {
                Ok(AppendOutcome::Appended | AppendOutcome::Duplicate) => {
                    fs::remove_file(path)?;
                    sync_directory(&paths.spool_pending())?;
                    drained += 1;
                }
                Err(error) => {
                    return Err(io::Error::other(error.to_string()).into());
                }
            }
        } else if let Some(file_name) = path.file_name() {
            fs::rename(&path, paths.spool_rejected().join(file_name))?;
            sync_directory(&paths.spool_pending())?;
            sync_directory(&paths.spool_rejected())?;
        }
    }
    Ok(drained)
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(80)
        .collect()
}

fn sync_directory(path: &std::path::Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use asa_core::{AttributeValue, ObservationKind};
    use std::collections::BTreeMap;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;
    use time::OffsetDateTime;

    fn observation() -> Observation {
        Observation {
            schema_version: 1,
            id: "spool:id".to_owned(),
            adapter: "codex".to_owned(),
            native_event: "Stop".to_owned(),
            kind: ObservationKind::AgentStopped,
            observed_at: OffsetDateTime::UNIX_EPOCH,
            session_id: "codex:spool".to_owned(),
            turn_id: Some("turn".to_owned()),
            invocation_id: None,
            attributes: BTreeMap::from([(
                "asa.capture.level".to_owned(),
                AttributeValue::String("metadata".to_owned()),
            )]),
        }
    }

    #[test]
    fn drain_is_duplicate_safe_and_quarantines_invalid_entries() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let store = SegmentStore::open(&paths).unwrap();
        let observation = observation();
        store.append(&observation).unwrap();
        spool_observation(&paths, &observation).unwrap();
        fs::write(paths.spool_pending().join("invalid.json"), b"not-json").unwrap();
        assert_eq!(drain_spool(&paths, &store).unwrap(), 1);
        assert_eq!(crate::recover_observations(&paths).unwrap().len(), 1);
        assert!(paths.spool_rejected().join("invalid.json").exists());
        assert_eq!(fs::read_dir(paths.spool_pending()).unwrap().count(), 0);
    }

    #[test]
    fn restart_during_spool_drain_deduplicates_append_before_unlink() {
        let temp = TempDir::new().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "spool::tests::spool_drain_crash_helper"])
            .env("ASA_SPOOL_CRASH_ROOT", temp.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "helper must terminate abruptly");

        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        assert_eq!(crate::recover_observations(&paths).unwrap().len(), 1);
        assert_eq!(fs::read_dir(paths.spool_pending()).unwrap().count(), 1);
        let store = SegmentStore::open(&paths).unwrap();
        assert_eq!(drain_spool(&paths, &store).unwrap(), 1);
        assert_eq!(crate::recover_observations(&paths).unwrap().len(), 1);
        assert_eq!(fs::read_dir(paths.spool_pending()).unwrap().count(), 0);
    }

    #[test]
    fn spool_drain_crash_helper() {
        let Some(root) = std::env::var_os("ASA_SPOOL_CRASH_ROOT") else {
            return;
        };
        let paths = AsaPaths::discover(Some(std::path::Path::new(&root))).unwrap();
        let observation = observation();
        spool_observation(&paths, &observation).unwrap();
        let store = SegmentStore::open(&paths).unwrap();
        store.append(&observation).unwrap();
        std::process::abort();
    }
}
