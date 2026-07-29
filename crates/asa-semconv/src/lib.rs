//! Semantic-convention constants used by every ASA adapter.
//!
//! Standard names are centralized here so adapter code cannot accidentally
//! drift onto an ASA-specific telemetry dialect.

/// Pinned OpenTelemetry semantic-convention schema.
///
/// `GenAI` conventions are still developing. Updating this value and its
/// mappings is explicit migration work, never an incidental dependency bump.
pub const SCHEMA_URL: &str = "https://opentelemetry.io/schemas/1.37.0";

pub mod gen_ai {
    pub const CONVERSATION_ID: &str = "gen_ai.conversation.id";
    pub const AGENT_ID: &str = "gen_ai.agent.id";
    pub const AGENT_NAME: &str = "gen_ai.agent.name";
    pub const AGENT_VERSION: &str = "gen_ai.agent.version";
    pub const PROVIDER_NAME: &str = "gen_ai.provider.name";
    pub const OPERATION_NAME: &str = "gen_ai.operation.name";
    pub const TOOL_CALL_ID: &str = "gen_ai.tool.call.id";
    pub const TOOL_NAME: &str = "gen_ai.tool.name";
    pub const USAGE_INPUT_TOKENS: &str = "gen_ai.usage.input_tokens";
    pub const USAGE_OUTPUT_TOKENS: &str = "gen_ai.usage.output_tokens";
    pub const USAGE_CACHE_READ_INPUT_TOKENS: &str = "gen_ai.usage.cache_read.input_tokens";
    pub const USAGE_CACHE_CREATION_INPUT_TOKENS: &str = "gen_ai.usage.cache_creation.input_tokens";
}

pub mod session {
    pub const ID: &str = "session.id";
    pub const PREVIOUS_ID: &str = "session.previous_id";
}

pub mod error {
    pub const TYPE: &str = "error.type";
}

pub mod asa {
    pub const ADAPTER_NAME: &str = "asa.adapter.name";
    pub const ADAPTER_VERSION: &str = "asa.adapter.version";
    pub const SURFACE: &str = "asa.surface";
    pub const NATIVE_SESSION_ID: &str = "asa.native.session_id";
    pub const NATIVE_EVENT_NAME: &str = "asa.native.event_name";
    pub const NATIVE_EVENT_ID: &str = "asa.native.event_id";
    pub const WORKSPACE_PATH: &str = "asa.workspace.path";
    pub const WORKSPACE_PREVIOUS_PATH: &str = "asa.workspace.previous_path";
    pub const REPOSITORY_ID: &str = "asa.repository.id";
    pub const GIT_COMMIT: &str = "asa.git.commit";
    pub const GIT_BRANCH: &str = "asa.git.branch";
    pub const GIT_DIRTY_FILES: &str = "asa.git.dirty_files";
    pub const TRANSCRIPT_PATH: &str = "asa.transcript.path";
    pub const CAPTURE_LEVEL: &str = "asa.capture.level";
    pub const IDENTITY_DERIVED: &str = "asa.identity.derived";
    pub const OBSERVATION_ID: &str = "asa.observation.id";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_names_never_use_reserved_otel_namespace() {
        for name in [
            asa::ADAPTER_NAME,
            asa::NATIVE_EVENT_NAME,
            asa::OBSERVATION_ID,
            asa::CAPTURE_LEVEL,
        ] {
            assert!(name.starts_with("asa."));
            assert!(!name.starts_with("otel."));
        }
    }
}
