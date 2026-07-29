use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

impl Usage {
    pub(crate) fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
    }

    pub(crate) fn difference(&self, before: &Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(before.input_tokens),
            output_tokens: self.output_tokens.saturating_sub(before.output_tokens),
            cache_read_tokens: self
                .cache_read_tokens
                .saturating_sub(before.cache_read_tokens),
            cache_creation_tokens: self
                .cache_creation_tokens
                .saturating_sub(before.cache_creation_tokens),
            reasoning_tokens: self
                .reasoning_tokens
                .saturating_sub(before.reasoning_tokens),
            total_tokens: self.total_tokens.saturating_sub(before.total_tokens),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub is_mcp: bool,
    pub mcp_server: Option<String>,
    pub is_error: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelUsage {
    pub api_calls: u64,
    pub output_tokens: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub index: usize,
    pub prompt_preview: Option<String>,
    pub model: Option<String>,
    pub api_calls: u64,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
    pub aborted: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct InteractionCounts {
    pub interruptions: u64,
    pub commands: u64,
    pub permission_mode_changes: u64,
    pub queued_prompts: u64,
    pub pr_links: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NormalizedSession {
    pub adapter: String,
    pub id: String,
    pub file_path: PathBuf,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub models: Vec<String>,
    pub model_usage: std::collections::BTreeMap<String, ModelUsage>,
    pub cli_version: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub forked_from_id: Option<String>,
    pub compactions: u64,
    pub steps: Vec<Step>,
    pub usage: Usage,
    pub subagents: u64,
    pub interactions: InteractionCounts,
    pub malformed_lines: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolStat {
    pub name: String,
    pub count: u64,
    pub errors: u64,
    pub is_mcp: bool,
    pub mcp_server: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct McpServerStat {
    pub server: String,
    pub calls: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnalysisReport {
    pub session: NormalizedSession,
    pub steps: usize,
    pub api_calls: u64,
    pub tool_calls: u64,
    pub mcp_calls: u64,
    pub tool_errors: u64,
    pub subagents: u64,
    pub duration_ms: Option<i128>,
    pub tool_stats: Vec<ToolStat>,
    pub mcp_servers: Vec<McpServerStat>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ComparisonRow {
    pub metric: String,
    pub a: i128,
    pub b: i128,
    pub delta: i128,
}
