use directories::ProjectDirs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PathError {
    #[error("the platform does not provide a user data directory")]
    NoProjectDirectory,
}

/// All ASA-owned files. Native agent paths deliberately do not belong here.
#[derive(Clone, Debug)]
pub struct AsaPaths {
    root: PathBuf,
}

impl AsaPaths {
    pub fn discover(override_root: Option<&Path>) -> Result<Self, PathError> {
        if let Some(root) = override_root {
            return Ok(Self {
                root: root.to_path_buf(),
            });
        }
        let dirs = ProjectDirs::from("com", "ak5", "asa").ok_or(PathError::NoProjectDirectory)?;
        Ok(Self {
            root: dirs.data_local_dir().to_path_buf(),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn segments_active(&self) -> PathBuf {
        self.root.join("segments/active")
    }

    #[must_use]
    pub fn segments_sealed(&self) -> PathBuf {
        self.root.join("segments/sealed")
    }

    #[must_use]
    pub fn segments_rejected(&self) -> PathBuf {
        self.root.join("segments/rejected")
    }

    #[must_use]
    pub fn spool_pending(&self) -> PathBuf {
        self.root.join("spool/pending")
    }

    #[must_use]
    pub fn spool_rejected(&self) -> PathBuf {
        self.root.join("spool/rejected")
    }

    #[must_use]
    pub fn sessions(&self) -> PathBuf {
        self.root.join("sessions")
    }

    #[must_use]
    pub fn token_file(&self) -> PathBuf {
        self.root.join("daemon.token")
    }

    #[must_use]
    pub fn analytics_database(&self) -> PathBuf {
        self.root.join("analytics.duckdb")
    }

    #[must_use]
    pub fn privacy_config(&self) -> PathBuf {
        self.root.join("privacy.json")
    }

    #[must_use]
    pub fn deletion_registry(&self) -> PathBuf {
        self.root.join("deleted-sessions.json")
    }

    #[must_use]
    pub fn reconciliation_checkpoints(&self) -> PathBuf {
        self.root.join("reconciliation-checkpoints.json")
    }

    #[must_use]
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
}
