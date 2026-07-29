use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fmt};
use time::OffsetDateTime;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    #[must_use]
    pub fn namespaced(adapter: &str, native_id: &str) -> Self {
        Self(format!("{adapter}:{native_id}"))
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Partial,
    Unsupported,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureLevel {
    None,
    Metadata,
    Redacted,
    Full,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionSource {
    ClaudeCode,
    Codex,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
    Cli,
    Desktop,
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionLineage {
    pub previous_session_id: Option<SessionId>,
    pub parent_session_id: Option<SessionId>,
    pub forked_from_session_id: Option<SessionId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceAttribution {
    pub path: String,
    pub first_observed_at: OffsetDateTime,
    pub last_observed_at: OffsetDateTime,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    pub id: String,
    pub started_at: Option<OffsetDateTime>,
    pub ended_at: Option<OffsetDateTime>,
    pub completed: bool,
    pub tool_calls: u32,
    pub assistant_output: Option<String>,
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpanStatus {
    Ok,
    Error,
    Incomplete,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpanDocument {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub operation_name: String,
    pub name: String,
    pub started_at: Option<OffsetDateTime>,
    pub ended_at: Option<OffsetDateTime>,
    pub status: SpanStatus,
    pub attributes: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentTrace {
    pub trace_id: String,
    pub conversation_id: SessionId,
    pub turn_id: String,
    pub spans: Vec<SpanDocument>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectionMetadata {
    pub observation_count: u64,
    pub last_observation_id: Option<String>,
    pub parser_version: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionDocument {
    pub schema_version: u32,
    pub id: SessionId,
    pub source: SessionSource,
    pub surface: Option<Surface>,
    pub lineage: SessionLineage,
    pub workspaces: Vec<WorkspaceAttribution>,
    pub started_at: Option<OffsetDateTime>,
    pub ended_at: Option<OffsetDateTime>,
    pub usage: Usage,
    pub turns: Vec<Turn>,
    pub traces: Vec<AgentTrace>,
    pub metadata: BTreeMap<String, Value>,
    pub projection: ProjectionMetadata,
}
