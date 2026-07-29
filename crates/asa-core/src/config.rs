use crate::CaptureLevel;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AdapterPrivacy {
    pub prompt: CaptureLevel,
    pub assistant_response: CaptureLevel,
}

impl Default for AdapterPrivacy {
    fn default() -> Self {
        Self {
            prompt: CaptureLevel::Metadata,
            assistant_response: CaptureLevel::Metadata,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct PrivacyConfig {
    pub defaults: AdapterPrivacy,
    pub adapters: BTreeMap<String, AdapterPrivacy>,
    pub excluded_projects: Vec<String>,
    pub maximum_content_bytes: usize,
    pub retention_days: Option<u32>,
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            defaults: AdapterPrivacy::default(),
            adapters: BTreeMap::new(),
            excluded_projects: Vec::new(),
            maximum_content_bytes: 64 * 1024,
            retention_days: None,
        }
    }
}

impl PrivacyConfig {
    #[must_use]
    pub fn effective_for(&self, adapter: &str) -> &AdapterPrivacy {
        self.adapters.get(adapter).unwrap_or(&self.defaults)
    }

    #[must_use]
    pub fn excludes(&self, cwd: Option<&str>) -> bool {
        let Some(cwd) = cwd else {
            return false;
        };
        self.excluded_projects
            .iter()
            .any(|excluded| Path::new(cwd).starts_with(excluded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_capture_metadata_and_support_adapter_override_and_exclusion() {
        let mut config = PrivacyConfig::default();
        assert_eq!(
            config.effective_for("codex").assistant_response,
            CaptureLevel::Metadata
        );
        config.adapters.insert(
            "codex".to_owned(),
            AdapterPrivacy {
                prompt: CaptureLevel::None,
                assistant_response: CaptureLevel::Full,
            },
        );
        config
            .excluded_projects
            .push("/private/sensitive".to_owned());
        assert_eq!(
            config.effective_for("codex").assistant_response,
            CaptureLevel::Full
        );
        assert!(config.excludes(Some("/private/sensitive/project")));
        assert!(!config.excludes(Some("/private/other")));
    }
}
