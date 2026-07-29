use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use time::OffsetDateTime;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AttributeValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Strings(Vec<String>),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    SessionStart,
    PromptSubmitted,
    ToolStarted,
    ToolCompleted,
    AgentStopped,
    SubagentStarted,
    SubagentStopped,
    PreCompact,
    PostCompact,
    WorkspacePathChanged,
    SessionEnd,
    Unknown,
}

/// Immutable native lifecycle evidence transported as an OTLP `LogRecord`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    pub schema_version: u32,
    pub id: String,
    pub adapter: String,
    pub native_event: String,
    pub kind: ObservationKind,
    pub observed_at: OffsetDateTime,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub invocation_id: Option<String>,
    pub attributes: BTreeMap<String, AttributeValue>,
}
