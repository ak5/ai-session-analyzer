use crate::{list_sessions, remove_session_observations, spawn_analytics};
use asa_core::{AsaPaths, Observation};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, io::Write};
use thiserror::Error;
use time::OffsetDateTime;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeletionReport {
    pub session_id: String,
    pub observations_removed: usize,
    pub spool_entries_removed: usize,
    pub projection_removed: bool,
}

#[derive(Debug, Error)]
pub enum DeletionError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("segment error: {0}")]
    Store(#[from] crate::segment::StoreError),
    #[error("projection error: {0}")]
    Projection(#[from] crate::projection::ProjectionError),
    #[error("analytics error: {0}")]
    Analytics(#[from] crate::analytics::AnalyticsError),
    #[error("session id must be namespaced, for example codex:abc")]
    InvalidSessionId,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Registry {
    deleted: BTreeSet<String>,
}

#[must_use]
pub fn is_session_deleted(paths: &AsaPaths, session_id: &str) -> bool {
    read_registry(paths)
        .map(|registry| registry.deleted.contains(session_id))
        .unwrap_or(false)
}

#[must_use]
pub fn retained_observations(paths: &AsaPaths, observations: Vec<Observation>) -> Vec<Observation> {
    let Ok(registry) = read_registry(paths) else {
        return observations;
    };
    observations
        .into_iter()
        .filter(|observation| !registry.deleted.contains(&observation.session_id))
        .collect()
}

pub fn delete_session(paths: &AsaPaths, session_id: &str) -> Result<DeletionReport, DeletionError> {
    let (adapter, native_id) = session_id
        .split_once(':')
        .ok_or(DeletionError::InvalidSessionId)?;
    // The segment lock makes deletion fail safely while the daemon is active.
    let observations_removed = remove_session_observations(paths, session_id)?;
    let spool_entries_removed = remove_spooled_session(paths, session_id)?;
    let projection = paths
        .sessions()
        .join(adapter)
        .join(format!("{native_id}.json.zst"));
    let projection_removed = if projection.exists() {
        fs::remove_file(projection)?;
        true
    } else {
        false
    };
    let mut registry = read_registry(paths)?;
    registry.deleted.insert(session_id.to_owned());
    write_registry(paths, &registry)?;
    let analytics = spawn_analytics(paths)?;
    analytics.rebuild(list_sessions(paths)?)?;
    Ok(DeletionReport {
        session_id: session_id.to_owned(),
        observations_removed,
        spool_entries_removed,
        projection_removed,
    })
}

fn remove_spooled_session(paths: &AsaPaths, session_id: &str) -> Result<usize, DeletionError> {
    let mut removed = 0;
    for directory in [paths.spool_pending(), paths.spool_rejected()] {
        if !directory.exists() {
            continue;
        }
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let matches = fs::read(entry.path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Observation>(&bytes).ok())
                .is_some_and(|observation| observation.session_id == session_id);
            if matches {
                fs::remove_file(entry.path())?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn read_registry(paths: &AsaPaths) -> Result<Registry, DeletionError> {
    if !paths.deletion_registry().exists() {
        return Ok(Registry::default());
    }
    Ok(serde_json::from_slice(&fs::read(
        paths.deletion_registry(),
    )?)?)
}

fn write_registry(paths: &AsaPaths, registry: &Registry) -> Result<(), DeletionError> {
    fs::create_dir_all(paths.root())?;
    let temporary = paths.deletion_registry().with_extension(format!(
        "{}.tmp",
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let mut file = fs::File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, registry)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    fs::rename(&temporary, paths.deletion_registry())?;
    fs::File::open(paths.root())?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SegmentStore, project_observations, recover_observations};
    use asa_core::{AttributeValue, ObservationKind};
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn observation(id: &str, session_id: &str) -> Observation {
        Observation {
            schema_version: 1,
            id: id.to_owned(),
            adapter: "codex".to_owned(),
            native_event: "Stop".to_owned(),
            kind: ObservationKind::AgentStopped,
            observed_at: OffsetDateTime::UNIX_EPOCH,
            session_id: session_id.to_owned(),
            turn_id: Some("turn".to_owned()),
            invocation_id: None,
            attributes: BTreeMap::from([(
                "asa.capture.level".to_owned(),
                AttributeValue::String("metadata".to_owned()),
            )]),
        }
    }

    #[test]
    fn deletion_removes_only_target_asa_data_and_registers_suppression() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        {
            let store = SegmentStore::open(&paths).unwrap();
            store.append(&observation("one", "codex:one")).unwrap();
            store.append(&observation("two", "codex:two")).unwrap();
        }
        project_observations(&paths, &recover_observations(&paths).unwrap()).unwrap();
        let report = delete_session(&paths, "codex:one").unwrap();
        assert_eq!(report.observations_removed, 1);
        assert!(report.projection_removed);
        assert!(is_session_deleted(&paths, "codex:one"));
        let retained = recover_observations(&paths).unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].session_id, "codex:two");
        assert!(!paths.sessions().join("codex/one.json.zst").exists());
        assert!(paths.sessions().join("codex/two.json.zst").exists());
    }
}
