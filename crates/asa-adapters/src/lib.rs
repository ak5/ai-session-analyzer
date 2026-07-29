mod context_fork;
mod migration;

use asa_core::{AttributeValue, CaptureLevel, Observation, ObservationKind, Support};
use asa_semconv::{asa, gen_ai, session};
use directories::BaseDirs;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::SystemTime,
};
use thiserror::Error;
use time::OffsetDateTime;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterName {
    ClaudeCode,
    Codex,
}

impl AdapterName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }
}

impl std::str::FromStr for AdapterName {
    type Err = AdapterError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude" | "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            _ => Err(AdapterError::UnsupportedAdapter(value.to_owned())),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct AdapterCapabilities {
    pub session_lifecycle: Support,
    pub stable_session_ids: Support,
    pub prompt_observation: CaptureLevel,
    pub assistant_output: CaptureLevel,
    pub tool_start: Support,
    pub tool_completion: Support,
    pub tool_results: CaptureLevel,
    pub subagents: Support,
    pub compaction: Support,
    pub usage: Support,
    pub transcript_discovery: Support,
    pub artifacts: Support,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct NativeSessionReference {
    pub id: String,
    pub adapter: String,
    pub path: PathBuf,
    pub title: Option<String>,
    pub updated_at_unix_ms: Option<u128>,
    pub size_bytes: u64,
}

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("unsupported adapter {0:?}")]
    UnsupportedAdapter(String),
    #[error("native hook input is not a JSON object")]
    NotAnObject,
    #[error("native hook is missing a session identifier")]
    MissingSessionId,
    #[error("native hook is missing an event name")]
    MissingEventName,
    #[error("invalid hook JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("the platform does not provide a user home directory")]
    NoHomeDirectory,
    #[error("session {0} does not contain step {1}")]
    StepNotFound(String, String),
    #[error("native session path has no parent: {0}")]
    InvalidSessionPath(PathBuf),
    #[error("workspace migration failed: {0}")]
    Migration(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForkAtStepResult {
    pub new_session_id: String,
    pub new_path: PathBuf,
    pub kept_records: usize,
    pub dropped_records: usize,
    pub copied_subagents: usize,
}

pub use context_fork::{ContextForkOptions, ContextForkResult, craft_context_fork};
pub use migration::{
    MigrationConfig, MigrationOperation, MigrationOperationSummary, MigrationPlan, MigrationReport,
    migrate_workspace_path, plan_workspace_path_migration,
};

#[must_use]
pub fn capabilities(adapter: AdapterName) -> AdapterCapabilities {
    match adapter {
        AdapterName::ClaudeCode | AdapterName::Codex => AdapterCapabilities {
            session_lifecycle: Support::Supported,
            stable_session_ids: Support::Supported,
            prompt_observation: CaptureLevel::Metadata,
            assistant_output: CaptureLevel::Full,
            tool_start: Support::Supported,
            tool_completion: Support::Supported,
            tool_results: CaptureLevel::Metadata,
            subagents: Support::Supported,
            compaction: Support::Supported,
            usage: Support::Supported,
            transcript_discovery: Support::Supported,
            artifacts: Support::Unknown,
        },
    }
}

pub fn discover_sessions(
    adapter: AdapterName,
) -> Result<Vec<NativeSessionReference>, AdapterError> {
    let home = BaseDirs::new()
        .ok_or(AdapterError::NoHomeDirectory)?
        .home_dir()
        .to_path_buf();
    match adapter {
        AdapterName::ClaudeCode => {
            let config = std::env::var_os("CLAUDE_CONFIG_DIR")
                .map_or_else(|| home.join(".claude"), PathBuf::from);
            discover_claude_sessions(&config.join("projects"))
        }
        AdapterName::Codex => {
            let config =
                std::env::var_os("CODEX_HOME").map_or_else(|| home.join(".codex"), PathBuf::from);
            discover_codex_sessions(
                &config.join("sessions"),
                &config.join("session_index.jsonl"),
            )
        }
    }
}

pub fn discover_claude_sessions(
    projects: &Path,
) -> Result<Vec<NativeSessionReference>, AdapterError> {
    let mut sessions = Vec::new();
    if !projects.exists() {
        return Ok(sessions);
    }
    for project in fs::read_dir(projects)? {
        let project = project?;
        if !project.file_type()?.is_dir() {
            continue;
        }
        for entry in fs::read_dir(project.path())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type()?.is_file() || !is_uuid_jsonl(&name) {
                continue;
            }
            sessions.push(reference(
                AdapterName::ClaudeCode,
                name.trim_end_matches(".jsonl"),
                entry.path(),
                None,
            )?);
        }
    }
    newest_first(&mut sessions);
    Ok(sessions)
}

pub fn discover_codex_sessions(
    sessions_root: &Path,
    index_file: &Path,
) -> Result<Vec<NativeSessionReference>, AdapterError> {
    let titles = read_codex_titles(index_file);
    let mut files = Vec::new();
    visit_files(sessions_root, &mut files)?;
    let mut sessions = files
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?;
            let id = rollout_session_id(name)?;
            Some(reference(
                AdapterName::Codex,
                &id,
                path,
                titles.get(&id).cloned(),
            ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    newest_first(&mut sessions);
    Ok(sessions)
}

/// Convert a native hook invocation into privacy-conscious immutable evidence.
///
/// Unknown fields are accepted but not copied. Full tool inputs/outputs,
/// prompts, and environment values are intentionally omitted.
pub fn native_hook_to_observation(
    adapter: AdapterName,
    input: &[u8],
) -> Result<Observation, AdapterError> {
    native_hook_to_observation_with_policy(
        adapter,
        input,
        CaptureLevel::Full,
        CaptureLevel::Full,
        usize::MAX,
    )
}

#[allow(clippy::too_many_lines)]
pub fn native_hook_to_observation_with_policy(
    adapter: AdapterName,
    input: &[u8],
    prompt_capture: CaptureLevel,
    assistant_capture: CaptureLevel,
    maximum_content_bytes: usize,
) -> Result<Observation, AdapterError> {
    let value: Value = serde_json::from_slice(input)?;
    let object = value.as_object().ok_or(AdapterError::NotAnObject)?;
    let event = string_field(object, &["hook_event_name", "event_name", "event"])
        .ok_or(AdapterError::MissingEventName)?;
    let native_session = string_field(object, &["session_id", "sessionId", "conversation_id"])
        .ok_or(AdapterError::MissingSessionId)?;
    let turn_id = string_field(object, &["turn_id", "turnId"]);
    let invocation_id = string_field(
        object,
        &[
            "tool_use_id",
            "tool_call_id",
            "invocation_id",
            "call_id",
            "agent_id",
            "subagent_id",
        ],
    );
    let observed_at = OffsetDateTime::now_utc();
    let mut attributes = BTreeMap::new();
    attributes.insert(
        asa::ADAPTER_NAME.to_owned(),
        AttributeValue::String(adapter.as_str().to_owned()),
    );
    attributes.insert(
        asa::NATIVE_EVENT_NAME.to_owned(),
        AttributeValue::String(event.clone()),
    );
    attributes.insert(
        asa::NATIVE_SESSION_ID.to_owned(),
        AttributeValue::String(native_session.clone()),
    );
    attributes.insert(
        session::ID.to_owned(),
        AttributeValue::String(format!("{}:{native_session}", adapter.as_str())),
    );
    attributes.insert(
        gen_ai::CONVERSATION_ID.to_owned(),
        AttributeValue::String(format!("{}:{native_session}", adapter.as_str())),
    );
    if let Some(cwd) = string_field(object, &["cwd"]) {
        attributes.insert(asa::WORKSPACE_PATH.to_owned(), AttributeValue::String(cwd));
    }
    if let Some(path) = string_field(object, &["transcript_path"]) {
        attributes.insert(
            asa::TRANSCRIPT_PATH.to_owned(),
            AttributeValue::String(path),
        );
    }
    if let Some(tool_name) = string_field(object, &["tool_name", "toolName"]) {
        attributes.insert(
            gen_ai::TOOL_NAME.to_owned(),
            AttributeValue::String(tool_name),
        );
    }
    if let Some(id) = invocation_id.as_ref() {
        let key = if matches!(event.as_str(), "SubagentStart" | "SubagentStop") {
            gen_ai::AGENT_ID
        } else {
            gen_ai::TOOL_CALL_ID
        };
        attributes.insert(key.to_owned(), AttributeValue::String(id.clone()));
    }
    if let Some(agent_type) = string_field(object, &["agent_type", "subagent_type"]) {
        attributes.insert(
            gen_ai::AGENT_NAME.to_owned(),
            AttributeValue::String(agent_type),
        );
    }
    capture_content_attributes(
        &mut attributes,
        object,
        &event,
        prompt_capture,
        assistant_capture,
        maximum_content_bytes,
    );

    let kind = event_kind(&event);
    let id = observation_id(
        adapter.as_str(),
        &native_session,
        &event,
        turn_id.as_deref(),
        invocation_id.as_deref(),
        object,
    );
    attributes.insert(
        asa::OBSERVATION_ID.to_owned(),
        AttributeValue::String(id.clone()),
    );
    Ok(Observation {
        schema_version: 1,
        id,
        adapter: adapter.as_str().to_owned(),
        native_event: event,
        kind,
        observed_at,
        session_id: format!("{}:{native_session}", adapter.as_str()),
        turn_id,
        invocation_id,
        attributes,
    })
}

fn capture_content_attributes(
    attributes: &mut BTreeMap<String, AttributeValue>,
    object: &Map<String, Value>,
    event: &str,
    prompt_capture: CaptureLevel,
    assistant_capture: CaptureLevel,
    maximum_content_bytes: usize,
) {
    if let Some(message) = assistant_message(object, event) {
        capture_text(
            attributes,
            "asa.assistant.response",
            &message,
            assistant_capture,
            maximum_content_bytes,
        );
    }
    if event == "UserPromptSubmit"
        && let Some(prompt) = string_field(object, &["prompt", "user_prompt"])
    {
        capture_text(
            attributes,
            "asa.user.prompt",
            &prompt,
            prompt_capture,
            maximum_content_bytes,
        );
    }
    capture_json_metadata(attributes, "asa.tool.input", object.get("tool_input"));
    capture_json_metadata(
        attributes,
        "asa.tool.output",
        object
            .get("tool_response")
            .or_else(|| object.get("tool_output")),
    );
    let capture = if event == "UserPromptSubmit" {
        prompt_capture
    } else {
        assistant_capture
    };
    attributes.insert(
        asa::CAPTURE_LEVEL.to_owned(),
        AttributeValue::String(capture_name(capture).to_owned()),
    );
}

fn capture_text(
    attributes: &mut BTreeMap<String, AttributeValue>,
    key: &str,
    value: &str,
    level: CaptureLevel,
    maximum_content_bytes: usize,
) {
    attributes.insert(
        format!("{key}.size"),
        AttributeValue::Integer(i64::try_from(value.len()).unwrap_or(i64::MAX)),
    );
    attributes.insert(
        format!("{key}.sha256"),
        AttributeValue::String(hex::encode(Sha256::digest(value.as_bytes()))),
    );
    match level {
        CaptureLevel::Full => {
            let mut end = value.len().min(maximum_content_bytes);
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            attributes.insert(
                key.to_owned(),
                AttributeValue::String(value[..end].to_owned()),
            );
        }
        CaptureLevel::Redacted => {
            attributes.insert(
                key.to_owned(),
                AttributeValue::String("[redacted]".to_owned()),
            );
        }
        CaptureLevel::None | CaptureLevel::Metadata => {}
    }
}

fn capture_json_metadata(
    attributes: &mut BTreeMap<String, AttributeValue>,
    key: &str,
    value: Option<&Value>,
) {
    let Some(value) = value else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(value) else {
        return;
    };
    attributes.insert(
        format!("{key}.size"),
        AttributeValue::Integer(i64::try_from(bytes.len()).unwrap_or(i64::MAX)),
    );
    attributes.insert(
        format!("{key}.sha256"),
        AttributeValue::String(hex::encode(Sha256::digest(&bytes))),
    );
}

const fn capture_name(level: CaptureLevel) -> &'static str {
    match level {
        CaptureLevel::None => "none",
        CaptureLevel::Metadata => "metadata",
        CaptureLevel::Redacted => "redacted",
        CaptureLevel::Full => "full",
    }
}

/// Agent-native neutral output. Empty output is neutral for all Claude events
/// and ordinary Codex lifecycle hooks; Codex Stop requires structured JSON.
#[must_use]
pub fn neutral_hook_response(adapter: AdapterName, event: &str) -> &'static str {
    match (adapter, event) {
        (AdapterName::Codex, "Stop") => "{\"continue\":true}\n",
        _ => "",
    }
}

fn string_field(object: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| object.get(*name)?.as_str().map(ToOwned::to_owned))
}

fn assistant_message(object: &Map<String, Value>, event: &str) -> Option<String> {
    if event != "Stop" {
        return None;
    }
    string_field(object, &["last_assistant_message"])
}

fn event_kind(event: &str) -> ObservationKind {
    match event {
        "SessionStart" => ObservationKind::SessionStart,
        "UserPromptSubmit" => ObservationKind::PromptSubmitted,
        "PreToolUse" => ObservationKind::ToolStarted,
        "PostToolUse" | "PostToolUseFailure" => ObservationKind::ToolCompleted,
        "Stop" => ObservationKind::AgentStopped,
        "SubagentStart" => ObservationKind::SubagentStarted,
        "SubagentStop" => ObservationKind::SubagentStopped,
        "PreCompact" => ObservationKind::PreCompact,
        "PostCompact" => ObservationKind::PostCompact,
        "SessionEnd" => ObservationKind::SessionEnd,
        _ => ObservationKind::Unknown,
    }
}

fn observation_id(
    adapter: &str,
    session_id: &str,
    event: &str,
    turn_id: Option<&str>,
    invocation_id: Option<&str>,
    object: &Map<String, Value>,
) -> String {
    if let Some(native_id) = string_field(object, &["event_id", "hook_id", "uuid"]) {
        return format!("{adapter}:{native_id}");
    }
    let mut digest = Sha256::new();
    for part in [
        adapter,
        session_id,
        event,
        turn_id.unwrap_or(""),
        invocation_id.unwrap_or(""),
    ] {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    // Timestamps distinguish repeated lifecycle events while stable native IDs
    // keep retries idempotent when runtimes provide them.
    if let Some(timestamp) = string_field(object, &["timestamp"]) {
        digest.update(timestamp);
    } else if event == "Stop"
        && let Some(message) = assistant_message(object, event)
    {
        digest.update(message.as_bytes());
    }
    format!("{adapter}:{}", hex::encode(digest.finalize()))
}

fn reference(
    adapter: AdapterName,
    id: &str,
    path: PathBuf,
    title: Option<String>,
) -> Result<NativeSessionReference, AdapterError> {
    let metadata = fs::metadata(&path)?;
    let updated_at_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    Ok(NativeSessionReference {
        id: format!("{}:{id}", adapter.as_str()),
        adapter: adapter.as_str().to_owned(),
        path,
        title,
        updated_at_unix_ms,
        size_bytes: metadata.len(),
    })
}

fn newest_first(sessions: &mut [NativeSessionReference]) {
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at_unix_ms));
}

fn is_uuid_jsonl(name: &str) -> bool {
    name.strip_suffix(".jsonl").is_some_and(is_uuid)
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            })
}

fn rollout_session_id(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".jsonl")?;
    let parts = stem.rsplit('-').take(5).collect::<Vec<_>>();
    if parts.len() != 5 {
        return None;
    }
    let candidate = parts.into_iter().rev().collect::<Vec<_>>().join("-");
    is_uuid(&candidate).then_some(candidate)
}

fn visit_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), AdapterError> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            visit_files(&entry.path(), output)?;
        } else if entry.file_type()?.is_file() {
            output.push(entry.path());
        }
    }
    Ok(())
}

fn read_codex_titles(path: &Path) -> BTreeMap<String, String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    contents
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|entry| {
            Some((
                entry.get("id")?.as_str()?.to_owned(),
                entry.get("thread_name")?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

/// Create a disposable native-transcript fork ending after `step_id`.
///
/// The source is never modified. The new transcript is created exclusively,
/// flushed before return, and can then be resumed by the native CLI.
pub fn fork_native_session_at_step(
    reference: &NativeSessionReference,
    step_id: &str,
) -> Result<ForkAtStepResult, AdapterError> {
    let records = parse_jsonl_values(&fs::read_to_string(&reference.path)?);
    match reference.adapter.as_str() {
        "claude-code" => fork_claude_at_step(reference, step_id, &records),
        "codex" => fork_codex_at_step(reference, step_id, &records),
        other => Err(AdapterError::UnsupportedAdapter(other.to_owned())),
    }
}

fn fork_claude_at_step(
    reference: &NativeSessionReference,
    step_id: &str,
    records: &[Value],
) -> Result<ForkAtStepResult, AdapterError> {
    let anchor = records
        .iter()
        .position(|record| record.get("uuid").and_then(Value::as_str) == Some(step_id))
        .ok_or_else(|| AdapterError::StepNotFound(reference.id.clone(), step_id.to_owned()))?;
    let cut = records
        .iter()
        .enumerate()
        .skip(anchor + 1)
        .find_map(|(index, record)| is_claude_prompt(record).then_some(index))
        .unwrap_or(records.len());
    let new_session_id = uuid::Uuid::now_v7().to_string();
    let kept = records[..cut]
        .iter()
        .filter(|record| record.get("type").and_then(Value::as_str) != Some("last-prompt"))
        .cloned()
        .map(|mut record| {
            rewrite_session_ids(&mut record, &new_session_id);
            record
        })
        .collect::<Vec<_>>();
    let parent = reference
        .path
        .parent()
        .ok_or_else(|| AdapterError::InvalidSessionPath(reference.path.clone()))?;
    let new_path = parent.join(format!("{new_session_id}.jsonl"));
    write_new_jsonl(&new_path, &kept)?;
    let copied_subagents =
        copy_claude_sidecars(&reference.path, &new_session_id).inspect_err(|_| {
            let _ = fs::remove_file(&new_path);
        })?;
    sync_directory(parent)?;
    Ok(ForkAtStepResult {
        new_session_id,
        new_path,
        kept_records: kept.len(),
        dropped_records: records.len().saturating_sub(cut),
        copied_subagents,
    })
}

fn fork_codex_at_step(
    reference: &NativeSessionReference,
    step_id: &str,
    records: &[Value],
) -> Result<ForkAtStepResult, AdapterError> {
    let mut target = None;
    let mut cut = records.len();
    let mut ordinal = 0_usize;
    for (index, record) in records.iter().enumerate() {
        if record.pointer("/type").and_then(Value::as_str) != Some("event_msg")
            || record.pointer("/payload/type").and_then(Value::as_str) != Some("task_started")
        {
            continue;
        }
        if target.is_some() {
            cut = index;
            break;
        }
        let native = record
            .pointer("/payload/turn_id")
            .and_then(Value::as_str)
            .map_or_else(|| format!("turn-{ordinal}"), ToOwned::to_owned);
        if native == step_id || format!("turn-{ordinal}") == step_id {
            target = Some(index);
        }
        ordinal += 1;
    }
    if target.is_none() {
        return Err(AdapterError::StepNotFound(
            reference.id.clone(),
            step_id.to_owned(),
        ));
    }

    let new_session_id = uuid::Uuid::now_v7().to_string();
    let original_id = rollout_session_id(
        reference
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
    );
    let mut kept = records[..cut].to_vec();
    for record in &mut kept {
        if record.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) else {
            continue;
        };
        payload.insert("id".to_owned(), Value::String(new_session_id.clone()));
        if payload.contains_key("session_id") {
            payload.insert(
                "session_id".to_owned(),
                Value::String(new_session_id.clone()),
            );
        }
        if let Some(original_id) = &original_id {
            payload.insert(
                "forked_from_id".to_owned(),
                Value::String(original_id.clone()),
            );
        }
    }
    let parent = reference
        .path
        .parent()
        .ok_or_else(|| AdapterError::InvalidSessionPath(reference.path.clone()))?;
    let now = OffsetDateTime::now_utc();
    let stamp = format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    let new_path = parent.join(format!("rollout-{stamp}-{new_session_id}.jsonl"));
    write_new_jsonl(&new_path, &kept)?;
    sync_directory(parent)?;
    Ok(ForkAtStepResult {
        new_session_id,
        new_path,
        kept_records: kept.len(),
        dropped_records: records.len().saturating_sub(cut),
        copied_subagents: 0,
    })
}

fn parse_jsonl_values(contents: &str) -> Vec<Value> {
    contents
        .lines()
        .filter_map(|line| serde_json::from_str(line.trim()).ok())
        .collect()
}

fn is_claude_prompt(record: &Value) -> bool {
    if record.get("type").and_then(Value::as_str) != Some("user")
        || ["isMeta", "isCompactSummary", "isSidechain"]
            .iter()
            .any(|field| record.get(field).and_then(Value::as_bool) == Some(true))
    {
        return false;
    }
    let Some(content) = record.pointer("/message/content") else {
        return false;
    };
    if content.as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
    }) {
        return false;
    }
    let text = content.as_str().or_else(|| {
        content.as_array().and_then(|blocks| {
            blocks.iter().find_map(|block| {
                (block.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
            })
        })
    });
    let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) else {
        return false;
    };
    !text.starts_with("[Request interrupted")
        && !text.starts_with("<local-command-stdout>")
        && ![
            "<system-reminder",
            "<task-notification",
            "<background-task",
            "<tool-reminder",
        ]
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

fn rewrite_session_ids(record: &mut Value, new_session_id: &str) {
    let Some(object) = record.as_object_mut() else {
        return;
    };
    for field in ["sessionId", "session_id"] {
        if object.contains_key(field) {
            object.insert(field.to_owned(), Value::String(new_session_id.to_owned()));
        }
    }
}

fn write_new_jsonl(path: &Path, records: &[Value]) -> Result<(), AdapterError> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    for record in records {
        serde_json::to_writer(&mut file, record)?;
        file.write_all(b"\n")?;
    }
    file.sync_all()?;
    Ok(())
}

fn copy_claude_sidecars(
    source_transcript: &Path,
    new_session_id: &str,
) -> Result<usize, AdapterError> {
    let parent = source_transcript
        .parent()
        .ok_or_else(|| AdapterError::InvalidSessionPath(source_transcript.to_path_buf()))?;
    let source_id = source_transcript
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| AdapterError::InvalidSessionPath(source_transcript.to_path_buf()))?;
    let source_root = parent.join(source_id);
    let destination_root = parent.join(new_session_id);
    let categories = ["subagents", "tool-results"]
        .into_iter()
        .filter(|category| source_root.join(category).is_dir())
        .collect::<Vec<_>>();
    if categories.is_empty() {
        return Ok(0);
    }
    // Exclusive root creation makes cleanup safe even under an ID collision.
    fs::create_dir(&destination_root)?;
    let mut copied_subagents = 0;
    let copy_result = (|| -> Result<(), AdapterError> {
        for category in categories {
            let source = source_root.join(category);
            let destination = destination_root.join(category);
            fs::create_dir(&destination)?;
            for entry in fs::read_dir(source)? {
                let entry = entry?;
                if !entry.file_type()?.is_file() {
                    continue;
                }
                let target = destination.join(entry.file_name());
                if category == "subagents"
                    && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
                {
                    let mut records = parse_jsonl_values(&fs::read_to_string(entry.path())?);
                    for record in &mut records {
                        rewrite_session_ids(record, new_session_id);
                    }
                    write_new_jsonl(&target, &records)?;
                    copied_subagents += 1;
                } else {
                    let mut source_file = fs::File::open(entry.path())?;
                    let mut target_file = OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(target)?;
                    std::io::copy(&mut source_file, &mut target_file)?;
                    target_file.sync_all()?;
                }
            }
            sync_directory(&destination)?;
        }
        sync_directory(&destination_root)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_dir_all(&destination_root);
        let _ = sync_directory(parent);
        return Err(error);
    }
    Ok(copied_subagents)
}

fn sync_directory(path: &Path) -> Result<(), AdapterError> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn claude_stop_preserves_direct_message_but_not_unknown_content() {
        let input = br#"{
          "session_id":"abc",
          "hook_event_name":"Stop",
          "last_assistant_message":"finished",
          "tool_input":{"password":"secret"},
          "future_field":true
        }"#;
        let observation = native_hook_to_observation(AdapterName::ClaudeCode, input).unwrap();
        assert_eq!(observation.kind, ObservationKind::AgentStopped);
        assert_eq!(
            observation.attributes.get("asa.assistant.response"),
            Some(&AttributeValue::String("finished".to_owned()))
        );
        let serialized = serde_json::to_string(&observation).unwrap();
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn codex_stop_is_neutral() {
        assert_eq!(
            neutral_hook_response(AdapterName::Codex, "Stop"),
            "{\"continue\":true}\n"
        );
    }

    #[test]
    fn metadata_capture_hashes_content_without_retaining_it() {
        let input = br#"{
          "session_id":"abc",
          "hook_event_name":"Stop",
          "last_assistant_message":"sensitive response",
          "tool_input":{"token":"sensitive tool input"}
        }"#;
        let observation = native_hook_to_observation_with_policy(
            AdapterName::Codex,
            input,
            CaptureLevel::Metadata,
            CaptureLevel::Metadata,
            1024,
        )
        .unwrap();
        let serialized = serde_json::to_string(&observation).unwrap();
        assert!(!serialized.contains("sensitive response"));
        assert!(!serialized.contains("sensitive tool input"));
        assert!(
            observation
                .attributes
                .contains_key("asa.assistant.response.sha256")
        );
        assert!(observation.attributes.contains_key("asa.tool.input.sha256"));
    }

    #[test]
    fn prompt_capture_obeys_metadata_redacted_and_size_limited_full_modes() {
        let input = br#"{
          "session_id":"abc",
          "hook_event_name":"UserPromptSubmit",
          "prompt":"sensitive prompt"
        }"#;
        let metadata = native_hook_to_observation_with_policy(
            AdapterName::Codex,
            input,
            CaptureLevel::Metadata,
            CaptureLevel::Metadata,
            1024,
        )
        .unwrap();
        assert!(!metadata.attributes.contains_key("asa.user.prompt"));
        assert!(metadata.attributes.contains_key("asa.user.prompt.sha256"));
        let redacted = native_hook_to_observation_with_policy(
            AdapterName::Codex,
            input,
            CaptureLevel::Redacted,
            CaptureLevel::Metadata,
            1024,
        )
        .unwrap();
        assert_eq!(
            redacted.attributes["asa.user.prompt"],
            AttributeValue::String("[redacted]".to_owned())
        );
        let full = native_hook_to_observation_with_policy(
            AdapterName::Codex,
            input,
            CaptureLevel::Full,
            CaptureLevel::Metadata,
            9,
        )
        .unwrap();
        assert_eq!(
            full.attributes["asa.user.prompt"],
            AttributeValue::String("sensitive".to_owned())
        );
    }

    #[test]
    fn retries_with_native_event_id_deduplicate() {
        let input = br#"{"session_id":"abc","hook_event_name":"Stop","event_id":"evt-1"}"#;
        let one = native_hook_to_observation(AdapterName::Codex, input).unwrap();
        let two = native_hook_to_observation(AdapterName::Codex, input).unwrap();
        assert_eq!(one.id, two.id);
    }

    #[test]
    fn sanitized_native_fixtures_decode_without_capturing_tool_content() {
        for (adapter, fixture) in [
            (
                AdapterName::ClaudeCode,
                include_bytes!("../../../fixtures/v2/hooks/claude-stop.json").as_slice(),
            ),
            (
                AdapterName::ClaudeCode,
                include_bytes!("../../../fixtures/v2/hooks/claude-post-tool-use.json").as_slice(),
            ),
            (
                AdapterName::Codex,
                include_bytes!("../../../fixtures/v2/hooks/codex-stop.json").as_slice(),
            ),
            (
                AdapterName::Codex,
                include_bytes!("../../../fixtures/v2/hooks/codex-post-tool-use.json").as_slice(),
            ),
        ] {
            let observation = native_hook_to_observation(adapter, fixture).unwrap();
            let serialized = serde_json::to_string(&observation).unwrap();
            assert!(!serialized.contains("\"cmd\""));
            assert!(!serialized.contains("tool_output"));
            assert!(!serialized.contains("tool_response"));
        }
    }

    #[test]
    fn discovers_native_session_layouts_and_codex_titles() {
        let temp = TempDir::new().unwrap();
        let claude_id = "11111111-1111-1111-1111-111111111111";
        let claude_project = temp.path().join("claude/projects/-sanitized-project");
        fs::create_dir_all(&claude_project).unwrap();
        fs::write(claude_project.join(format!("{claude_id}.jsonl")), "{}\n").unwrap();
        fs::write(claude_project.join("not-a-session.jsonl"), "{}\n").unwrap();
        let claude = discover_claude_sessions(&temp.path().join("claude/projects")).unwrap();
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].id, format!("claude-code:{claude_id}"));

        let codex_id = "22222222-2222-2222-2222-222222222222";
        let codex_sessions = temp.path().join("codex/sessions/2026/07/29");
        fs::create_dir_all(&codex_sessions).unwrap();
        fs::write(
            codex_sessions.join(format!("rollout-2026-07-29T00-00-00-{codex_id}.jsonl")),
            "{}\n",
        )
        .unwrap();
        let index = temp.path().join("codex/session_index.jsonl");
        fs::write(
            &index,
            format!(r#"{{"id":"{codex_id}","thread_name":"Sanitized title"}}"#),
        )
        .unwrap();
        let codex = discover_codex_sessions(&temp.path().join("codex/sessions"), &index).unwrap();
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].id, format!("codex:{codex_id}"));
        assert_eq!(codex[0].title.as_deref(), Some("Sanitized title"));
    }

    #[test]
    fn forks_claude_at_step_without_mutating_source_and_rewrites_sidecars() {
        let temp = TempDir::new().unwrap();
        let source_id = "11111111-1111-1111-1111-111111111111";
        let source = temp.path().join(format!("{source_id}.jsonl"));
        let contents = [
            serde_json::json!({"type":"user","uuid":"step-one","sessionId":source_id,"message":{"content":"one"}}),
            serde_json::json!({"type":"assistant","uuid":"reply-one","sessionId":source_id}),
            serde_json::json!({"type":"last-prompt","sessionId":source_id}),
            serde_json::json!({"type":"user","uuid":"step-two","sessionId":source_id,"message":{"content":"two"}}),
            serde_json::json!({"type":"assistant","uuid":"reply-two","sessionId":source_id}),
        ];
        write_new_jsonl(&source, &contents).unwrap();
        let subagents = temp.path().join(source_id).join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        write_new_jsonl(
            &subagents.join("agent-one.jsonl"),
            &[serde_json::json!({"sessionId":source_id,"type":"assistant"})],
        )
        .unwrap();
        let before = fs::read(&source).unwrap();
        let reference =
            reference(AdapterName::ClaudeCode, source_id, source.clone(), None).unwrap();

        let fork = fork_native_session_at_step(&reference, "step-one").unwrap();

        assert_eq!(fs::read(&source).unwrap(), before);
        assert_eq!(fork.kept_records, 2);
        assert_eq!(fork.dropped_records, 2);
        assert_eq!(fork.copied_subagents, 1);
        let forked = fs::read_to_string(&fork.new_path).unwrap();
        assert!(forked.contains(&fork.new_session_id));
        assert!(!forked.contains(source_id));
        assert!(!forked.contains("step-two"));
        let sidecar = fs::read_to_string(
            temp.path()
                .join(&fork.new_session_id)
                .join("subagents/agent-one.jsonl"),
        )
        .unwrap();
        assert!(sidecar.contains(&fork.new_session_id));
    }

    #[test]
    fn claude_sidecar_collision_never_removes_existing_destination() {
        let temp = TempDir::new().unwrap();
        let source_id = "11111111-1111-1111-1111-111111111111";
        let source = temp.path().join(format!("{source_id}.jsonl"));
        fs::write(&source, "{}\n").unwrap();
        let source_sidecars = temp.path().join(source_id).join("subagents");
        fs::create_dir_all(&source_sidecars).unwrap();
        fs::write(source_sidecars.join("agent.jsonl"), "{}\n").unwrap();
        let destination_id = "22222222-2222-2222-2222-222222222222";
        let destination = temp.path().join(destination_id);
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("owned-by-someone-else"), "keep").unwrap();

        assert!(copy_claude_sidecars(&source, destination_id).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("owned-by-someone-else")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn forks_codex_at_step_with_native_lineage_and_next_turn_cut() {
        let temp = TempDir::new().unwrap();
        let source_id = "22222222-2222-2222-2222-222222222222";
        let source = temp
            .path()
            .join(format!("rollout-2026-07-29T00-00-00-{source_id}.jsonl"));
        let contents = [
            serde_json::json!({"type":"session_meta","payload":{"id":source_id}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-one"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","text":"one"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-two"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","text":"two"}}),
        ];
        write_new_jsonl(&source, &contents).unwrap();
        let before = fs::read(&source).unwrap();
        let reference = reference(AdapterName::Codex, source_id, source.clone(), None).unwrap();

        let fork = fork_native_session_at_step(&reference, "turn-one").unwrap();

        assert_eq!(fs::read(&source).unwrap(), before);
        assert_eq!(fork.kept_records, 3);
        assert_eq!(fork.dropped_records, 2);
        let forked = fs::read_to_string(fork.new_path).unwrap();
        assert!(forked.contains(&fork.new_session_id));
        assert!(forked.contains(&format!(r#""forked_from_id":"{source_id}""#)));
        assert!(!forked.contains("turn-two"));
    }
}
