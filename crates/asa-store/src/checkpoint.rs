use asa_core::AsaPaths;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::Path};
use thiserror::Error;
use uuid::Uuid;

pub const PARSER_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NativeCheckpoint {
    pub session_id: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_unix_ms: Option<u128>,
    pub parser_version: u32,
}

impl NativeCheckpoint {
    #[must_use]
    pub fn matches(
        &self,
        session_id: &str,
        path: &Path,
        size_bytes: u64,
        modified_unix_ms: Option<u128>,
    ) -> bool {
        self.session_id == session_id
            && self.path == path.to_string_lossy()
            && self.size_bytes == size_bytes
            && self.modified_unix_ms == modified_unix_ms
            && self.parser_version == PARSER_VERSION
    }
}

#[derive(Debug, Error)]
pub enum CheckpointError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("checkpoint JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn load_checkpoints(
    paths: &AsaPaths,
) -> Result<BTreeMap<String, NativeCheckpoint>, CheckpointError> {
    if !paths.reconciliation_checkpoints().exists() {
        return Ok(BTreeMap::new());
    }
    Ok(serde_json::from_slice(&fs::read(
        paths.reconciliation_checkpoints(),
    )?)?)
}

pub fn save_checkpoints(
    paths: &AsaPaths,
    checkpoints: &BTreeMap<String, NativeCheckpoint>,
) -> Result<(), CheckpointError> {
    fs::create_dir_all(paths.root())?;
    let temporary = paths
        .reconciliation_checkpoints()
        .with_extension(format!("{}.tmp", Uuid::now_v7()));
    let mut file = fs::File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, checkpoints)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    fs::rename(temporary, paths.reconciliation_checkpoints())?;
    fs::File::open(paths.root())?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn checkpoints_round_trip_and_parser_version_participates_in_match() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let checkpoint = NativeCheckpoint {
            session_id: "codex:one".to_owned(),
            path: "/native/one.jsonl".to_owned(),
            size_bytes: 42,
            modified_unix_ms: Some(7),
            parser_version: PARSER_VERSION,
        };
        save_checkpoints(
            &paths,
            &BTreeMap::from([("codex:one".to_owned(), checkpoint.clone())]),
        )
        .unwrap();
        let loaded = load_checkpoints(&paths).unwrap();
        assert_eq!(loaded["codex:one"], checkpoint);
        assert!(checkpoint.matches("codex:one", Path::new("/native/one.jsonl"), 42, Some(7)));
    }
}
