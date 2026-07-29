use super::{
    AdapterError, NativeSessionReference, copy_claude_sidecars, is_claude_prompt,
    parse_jsonl_values, rollout_session_id, sync_directory, write_new_jsonl,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextForkOptions {
    pub keep_last_steps: usize,
    pub hint: Option<String>,
}

impl Default for ContextForkOptions {
    fn default() -> Self {
        Self {
            keep_last_steps: 2,
            hint: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextForkResult {
    pub new_session_id: String,
    pub new_path: PathBuf,
    pub digested_steps: usize,
    pub kept_steps: usize,
    pub digest_chars: usize,
    pub estimated_tokens: usize,
    pub copied_subagents: usize,
}

#[derive(Clone, Debug)]
struct DigestStep {
    id: String,
    prompt: String,
    response: String,
    files: Vec<String>,
    aborted: bool,
}

pub fn craft_context_fork(
    reference: &NativeSessionReference,
    options: &ContextForkOptions,
) -> Result<ContextForkResult, AdapterError> {
    let records = parse_jsonl_values(&fs::read_to_string(&reference.path)?);
    match reference.adapter.as_str() {
        "claude-code" => craft_claude(reference, &records, options),
        "codex" => craft_codex(reference, &records, options),
        other => Err(AdapterError::UnsupportedAdapter(other.to_owned())),
    }
}

// Kept as one transaction-shaped routine so create/copy/fsync/cleanup ordering is auditable.
#[allow(clippy::too_many_lines)]
fn craft_claude(
    reference: &NativeSessionReference,
    records: &[Value],
    options: &ContextForkOptions,
) -> Result<ContextForkResult, AdapterError> {
    let steps = claude_steps(records);
    if steps.is_empty() {
        return Err(AdapterError::StepNotFound(
            reference.id.clone(),
            "(no steps)".to_owned(),
        ));
    }
    let kept_count = options.keep_last_steps.min(steps.len());
    let split = steps.len() - kept_count;
    let digest = build_digest(
        reference,
        &steps[..split],
        steps.len(),
        options.hint.as_deref(),
    );
    let new_session_id = Uuid::now_v7().to_string();
    let summary_id = Uuid::now_v7().to_string();
    let now = OffsetDateTime::now_utc().to_string();
    let template = records
        .iter()
        .rev()
        .find(|record| record.get("type").and_then(Value::as_str) == Some("user"));
    let field = |name: &str| {
        template
            .and_then(|record| record.get(name))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let mut boundary = json!({
        "isSidechain": false,
        "userType": "external",
        "entrypoint": "cli",
        "cwd": field("cwd"),
        "version": field("version"),
        "gitBranch": field("gitBranch"),
        "sessionId": new_session_id,
        "session_id": new_session_id,
        "parentUuid": null,
        "type": "system",
        "subtype": "compact_boundary",
        "content": "Conversation compacted",
        "level": "info",
        "compactMetadata": {
            "trigger": "manual",
            "preTokens": claude_total_tokens(records),
            "postTokens": estimate_tokens(&digest)
        },
        "uuid": Uuid::now_v7().to_string(),
        "timestamp": now
    });
    remove_null_template_fields(&mut boundary);
    let mut summary = json!({
        "isSidechain": false,
        "userType": "external",
        "entrypoint": "cli",
        "cwd": field("cwd"),
        "version": field("version"),
        "gitBranch": field("gitBranch"),
        "sessionId": new_session_id,
        "session_id": new_session_id,
        "parentUuid": null,
        "type": "user",
        "isCompactSummary": true,
        "isVisibleInTranscriptOnly": true,
        "message": {"role": "user", "content": digest},
        "uuid": summary_id,
        "timestamp": now
    });
    remove_null_template_fields(&mut summary);

    let tail_start = if kept_count == 0 {
        records.len()
    } else {
        records
            .iter()
            .position(|record| {
                record.get("uuid").and_then(Value::as_str) == Some(steps[split].id.as_str())
            })
            .unwrap_or(records.len())
    };
    let mut tail = records[tail_start..]
        .iter()
        .filter(|record| record.get("type").and_then(Value::as_str) != Some("last-prompt"))
        .cloned()
        .collect::<Vec<_>>();
    for (index, record) in tail.iter_mut().enumerate() {
        super::rewrite_session_ids(record, &new_session_id);
        if index == 0
            && let Some(object) = record.as_object_mut()
        {
            object.insert("parentUuid".to_owned(), Value::String(summary_id.clone()));
        }
    }
    let tail_chars = serde_json::to_string(&tail)?.len();
    let mut crafted = vec![boundary, summary];
    crafted.extend(tail);
    let parent = parent(&reference.path)?;
    let new_path = parent.join(format!("{new_session_id}.jsonl"));
    write_new_jsonl(&new_path, &crafted)?;
    let copied_subagents =
        copy_claude_sidecars(&reference.path, &new_session_id).inspect_err(|_| {
            let _ = fs::remove_file(&new_path);
        })?;
    sync_directory(parent)?;
    Ok(ContextForkResult {
        new_session_id,
        new_path,
        digested_steps: split,
        kept_steps: kept_count,
        digest_chars: digest.len(),
        estimated_tokens: estimate_tokens(&digest) + tail_chars.div_ceil(4),
        copied_subagents,
    })
}

// Kept together because ordering is the adapter's native transcript contract.
#[allow(clippy::too_many_lines)]
fn craft_codex(
    reference: &NativeSessionReference,
    records: &[Value],
    options: &ContextForkOptions,
) -> Result<ContextForkResult, AdapterError> {
    let steps = codex_steps(records);
    if steps.is_empty() {
        return Err(AdapterError::StepNotFound(
            reference.id.clone(),
            "(no turns)".to_owned(),
        ));
    }
    let kept_count = options.keep_last_steps.min(steps.len());
    let split = steps.len() - kept_count;
    let digest = build_digest(
        reference,
        &steps[..split],
        steps.len(),
        options.hint.as_deref(),
    );
    let new_session_id = Uuid::now_v7().to_string();
    let original_id = reference
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(rollout_session_id);
    let meta = records
        .iter()
        .find(|record| record.get("type").and_then(Value::as_str) == Some("session_meta"))
        .ok_or_else(|| {
            AdapterError::StepNotFound(reference.id.clone(), "session_meta".to_owned())
        })?;
    let mut meta = meta.clone();
    if let Some(payload) = meta.get_mut("payload").and_then(Value::as_object_mut) {
        payload.insert("id".to_owned(), Value::String(new_session_id.clone()));
        if payload.contains_key("session_id") {
            payload.insert(
                "session_id".to_owned(),
                Value::String(new_session_id.clone()),
            );
        }
        if let Some(original_id) = original_id {
            payload.insert("forked_from_id".to_owned(), Value::String(original_id));
        }
    }
    let turn_context = records
        .iter()
        .rev()
        .find(|record| record.get("type").and_then(Value::as_str) == Some("turn_context"))
        .cloned();
    let first_environment = records
        .iter()
        .find(|record| {
            record.get("type").and_then(Value::as_str) == Some("response_item")
                && record.pointer("/payload/type").and_then(Value::as_str) == Some("message")
                && record.pointer("/payload/role").and_then(Value::as_str) == Some("user")
                && serde_json::to_string(record.pointer("/payload/content").unwrap_or(&Value::Null))
                    .is_ok_and(|content| content.contains("<environment_context>"))
        })
        .cloned();
    let now = OffsetDateTime::now_utc().to_string();
    let user_item = |text: String| {
        json!({
            "timestamp": now,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": text}]
            }
        })
    };
    let mut crafted = vec![meta];
    if let Some(context) = turn_context {
        crafted.push(context);
    }
    if let Some(environment) = first_environment {
        crafted.push(environment);
    }
    for step in &steps[..split] {
        crafted.push(user_item(step.prompt.clone()));
    }
    crafted.push(user_item(digest.clone()));

    let mut tail_start = if kept_count == 0 {
        records.len()
    } else {
        records
            .iter()
            .position(|record| {
                record.get("type").and_then(Value::as_str) == Some("event_msg")
                    && record.pointer("/payload/type").and_then(Value::as_str)
                        == Some("task_started")
                    && record.pointer("/payload/turn_id").and_then(Value::as_str)
                        == Some(steps[split].id.as_str())
            })
            .unwrap_or(records.len())
    };
    while tail_start > 0
        && records[tail_start - 1].get("type").and_then(Value::as_str) == Some("event_msg")
        && records[tail_start - 1]
            .pointer("/payload/type")
            .and_then(Value::as_str)
            == Some("user_message")
    {
        tail_start -= 1;
    }
    let tail = &records[tail_start..];
    let tail_chars = serde_json::to_string(tail)?.len();
    crafted.extend_from_slice(tail);
    let parent = parent(&reference.path)?;
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
    write_new_jsonl(&new_path, &crafted)?;
    sync_directory(parent)?;
    Ok(ContextForkResult {
        new_session_id,
        new_path,
        digested_steps: split,
        kept_steps: kept_count,
        digest_chars: digest.len(),
        estimated_tokens: estimate_tokens(&digest) + tail_chars.div_ceil(4),
        copied_subagents: 0,
    })
}

fn claude_steps(records: &[Value]) -> Vec<DigestStep> {
    let starts = records
        .iter()
        .enumerate()
        .filter_map(|(index, record)| is_claude_prompt(record).then_some(index))
        .collect::<Vec<_>>();
    starts
        .iter()
        .enumerate()
        .map(|(ordinal, start)| {
            let end = starts.get(ordinal + 1).copied().unwrap_or(records.len());
            let record = &records[*start];
            let prompt = claude_message_text(record);
            let mut responses = Vec::new();
            let mut files = BTreeSet::new();
            let mut aborted = false;
            for item in &records[*start + 1..end] {
                if item.get("type").and_then(Value::as_str) == Some("assistant") {
                    for block in item
                        .pointer("/message/content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = block.get("text").and_then(Value::as_str) {
                                    responses.push(text.to_owned());
                                }
                            }
                            Some("tool_use") => collect_file_touch(block, &mut files),
                            _ => {}
                        }
                    }
                }
                aborted |= claude_message_text(item).starts_with("[Request interrupted");
            }
            DigestStep {
                id: record
                    .get("uuid")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("step-{ordinal}"), ToOwned::to_owned),
                prompt,
                response: responses.join("\n").trim().to_owned(),
                files: files.into_iter().collect(),
                aborted,
            }
        })
        .collect()
}

fn codex_steps(records: &[Value]) -> Vec<DigestStep> {
    let starts = records
        .iter()
        .enumerate()
        .filter(|(_, record)| {
            record.get("type").and_then(Value::as_str) == Some("event_msg")
                && record.pointer("/payload/type").and_then(Value::as_str) == Some("task_started")
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    starts
        .iter()
        .enumerate()
        .map(|(ordinal, start)| {
            let end = starts.get(ordinal + 1).copied().unwrap_or(records.len());
            let prompt = (0..*start)
                .rev()
                .take_while(|index| {
                    records[*index].get("type").and_then(Value::as_str) == Some("event_msg")
                        && records[*index]
                            .pointer("/payload/type")
                            .and_then(Value::as_str)
                            == Some("user_message")
                })
                .filter_map(|index| {
                    records[index]
                        .pointer("/payload/message")
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            let mut responses = Vec::new();
            let mut files = BTreeSet::new();
            for item in &records[*start + 1..end] {
                if item.get("type").and_then(Value::as_str) == Some("event_msg")
                    && item.pointer("/payload/type").and_then(Value::as_str)
                        == Some("agent_message")
                    && let Some(message) = item.pointer("/payload/message").and_then(Value::as_str)
                {
                    responses.push(message.to_owned());
                }
                if item.get("type").and_then(Value::as_str) == Some("response_item")
                    && item.pointer("/payload/type").and_then(Value::as_str)
                        == Some("function_call")
                {
                    collect_codex_file_touch(item, &mut files);
                }
            }
            DigestStep {
                id: records[*start]
                    .pointer("/payload/turn_id")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("turn-{ordinal}"), ToOwned::to_owned),
                prompt,
                response: responses.join("\n").trim().to_owned(),
                files: files.into_iter().collect(),
                aborted: false,
            }
        })
        .collect()
}

fn build_digest(
    reference: &NativeSessionReference,
    steps: &[DigestStep],
    total_steps: usize,
    hint: Option<&str>,
) -> String {
    let mut output = vec![
        format!(
            "This session continues an earlier conversation, forked with a crafted context (asa fork --context) from session {}.",
            reference.id
        ),
        format!("Original session: {total_steps} steps."),
        "Below is the verbatim record of what the human asked and how each step concluded — trust it over memory, and re-read files before editing them: tool outputs were dropped.".to_owned(),
    ];
    let hint = hint.map(str::trim).filter(|value| !value.is_empty());
    if let Some(hint) = hint {
        output.extend([
            String::new(),
            format!("Focus for this continuation (per the fork's hint): {hint}"),
        ]);
    }
    output.extend([String::new(), "## The prompts, verbatim".to_owned()]);
    for (index, step) in steps.iter().enumerate() {
        let interrupted = if step.aborted { " [interrupted]" } else { "" };
        output.push(format!(
            "{}.{} {}",
            index + 1,
            interrupted,
            cap(&step.prompt, 2_000)
        ));
    }
    output.extend([String::new(), "## How each step concluded".to_owned()]);
    let hint_tokens = hint.map(hint_tokens).unwrap_or_default();
    for (index, step) in steps.iter().enumerate() {
        if step.response.is_empty() {
            continue;
        }
        let budget = if hint_tokens.is_empty() {
            600
        } else if matches_hint(&hint_tokens, &step.prompt, &step.response) {
            2_400
        } else {
            300
        };
        output.push(format!("{}. {}", index + 1, cap(&step.response, budget)));
    }
    let files = steps
        .iter()
        .flat_map(|step| step.files.iter())
        .collect::<BTreeSet<_>>();
    if !files.is_empty() {
        output.extend([
            String::new(),
            "## Files created or edited (re-read before touching)".to_owned(),
        ]);
        output.extend(files.into_iter().map(|file| format!("- {file}")));
    }
    output.join("\n")
}

fn claude_message_text(record: &Value) -> String {
    let content = record.pointer("/message/content").unwrap_or(&Value::Null);
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_file_touch(block: &Value, files: &mut BTreeSet<String>) {
    let Some(name) = block.get("name").and_then(Value::as_str) else {
        return;
    };
    if !["Edit", "Write", "NotebookEdit", "apply_patch"].contains(&name) {
        return;
    }
    if let Some(path) = block
        .pointer("/input/file_path")
        .or_else(|| block.pointer("/input/path"))
        .and_then(Value::as_str)
    {
        files.insert(path.to_owned());
    }
}

fn collect_codex_file_touch(item: &Value, files: &mut BTreeSet<String>) {
    let Some(name) = item.pointer("/payload/name").and_then(Value::as_str) else {
        return;
    };
    if !["Edit", "Write", "NotebookEdit", "apply_patch"].contains(&name) {
        return;
    }
    let arguments = item
        .pointer("/payload/arguments")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    if let Some(path) = arguments
        .as_ref()
        .and_then(|value| value.get("file_path").or_else(|| value.get("path")))
        .and_then(Value::as_str)
    {
        files.insert(path.to_owned());
    }
}

fn claude_total_tokens(records: &[Value]) -> u64 {
    records
        .iter()
        .filter_map(|record| record.pointer("/message/usage"))
        .map(|usage| {
            [
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ]
            .iter()
            .filter_map(|field| usage.get(field).and_then(Value::as_u64))
            .sum::<u64>()
        })
        .sum()
}

fn hint_tokens(hint: &str) -> Vec<String> {
    hint.to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric() && !"_./-".contains(character))
        .filter(|token| token.len() > 2)
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn matches_hint(tokens: &[String], prompt: &str, response: &str) -> bool {
    let haystack = format!("{prompt} {response}").to_lowercase();
    tokens.iter().any(|token| haystack.contains(token))
}

fn cap(text: &str, maximum: usize) -> String {
    let clean = text.trim();
    if clean.chars().count() <= maximum {
        return clean.to_owned();
    }
    let mut value = clean
        .chars()
        .take(maximum.saturating_sub(1))
        .collect::<String>();
    value.push('…');
    value
}

fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(4)
}

fn remove_null_template_fields(record: &mut Value) {
    let Some(object) = record.as_object_mut() else {
        return;
    };
    for field in ["cwd", "version", "gitBranch"] {
        if object.get(field) == Some(&Value::Null) {
            object.remove(field);
        }
    }
}

fn parent(path: &Path) -> Result<&Path, AdapterError> {
    path.parent()
        .ok_or_else(|| AdapterError::InvalidSessionPath(path.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdapterName, reference};
    use tempfile::TempDir;

    #[test]
    fn claude_context_fork_uses_native_compaction_shape_and_verbatim_tail() {
        let temp = TempDir::new().unwrap();
        let source_id = "11111111-1111-1111-1111-111111111111";
        let source = temp.path().join(format!("{source_id}.jsonl"));
        let records = vec![
            json!({"type":"user","uuid":"one","sessionId":source_id,"cwd":"/project","message":{"role":"user","content":"first prompt"}}),
            json!({"type":"assistant","uuid":"one-a","sessionId":source_id,"message":{"content":[{"type":"text","text":"first conclusion"}]}}),
            json!({"type":"user","uuid":"two","sessionId":source_id,"cwd":"/project","message":{"role":"user","content":"second prompt"}}),
            json!({"type":"assistant","uuid":"two-a","sessionId":source_id,"message":{"content":[{"type":"text","text":"second conclusion"}]}}),
        ];
        write_new_jsonl(&source, &records).unwrap();
        let reference =
            reference(AdapterName::ClaudeCode, source_id, source.clone(), None).unwrap();
        let before = fs::read(&source).unwrap();

        let fork = craft_context_fork(
            &reference,
            &ContextForkOptions {
                keep_last_steps: 1,
                hint: None,
            },
        )
        .unwrap();

        assert_eq!(fork.digested_steps, 1);
        assert_eq!(fork.kept_steps, 1);
        assert_eq!(fs::read(source).unwrap(), before);
        let crafted = parse_jsonl_values(&fs::read_to_string(fork.new_path).unwrap());
        assert_eq!(
            crafted[0].get("subtype").and_then(Value::as_str),
            Some("compact_boundary")
        );
        let digest = crafted[1]
            .pointer("/message/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(digest.contains("first prompt"));
        assert!(digest.contains("first conclusion"));
        assert!(!digest.contains("second prompt"));
        assert_eq!(crafted[2].get("uuid").and_then(Value::as_str), Some("two"));
        assert_eq!(
            crafted[2].get("parentUuid").and_then(Value::as_str),
            crafted[1].get("uuid").and_then(Value::as_str)
        );
        assert!(crafted.iter().all(|record| {
            record.get("sessionId").and_then(Value::as_str) == Some(fork.new_session_id.as_str())
        }));
    }

    #[test]
    fn codex_context_fork_emits_literal_history_lineage_and_verbatim_tail() {
        let temp = TempDir::new().unwrap();
        let source_id = "22222222-2222-2222-2222-222222222222";
        let source = temp
            .path()
            .join(format!("rollout-2026-07-29T00-00-00-{source_id}.jsonl"));
        let records = vec![
            json!({"timestamp":"2026-07-29T00:00:00Z","type":"session_meta","payload":{"id":source_id,"cwd":"/project"}}),
            json!({"type":"turn_context","payload":{"model":"gpt-test"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"first prompt"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-one"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"first conclusion"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"second prompt"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-two"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"second conclusion"}}),
        ];
        write_new_jsonl(&source, &records).unwrap();
        let reference = reference(AdapterName::Codex, source_id, source.clone(), None).unwrap();
        let before = fs::read(&source).unwrap();

        let fork = craft_context_fork(
            &reference,
            &ContextForkOptions {
                keep_last_steps: 1,
                hint: Some("first".to_owned()),
            },
        )
        .unwrap();

        assert_eq!(fork.digested_steps, 1);
        assert_eq!(fork.kept_steps, 1);
        assert_eq!(fs::read(source).unwrap(), before);
        let crafted = parse_jsonl_values(&fs::read_to_string(fork.new_path).unwrap());
        assert_eq!(
            crafted[0]
                .pointer("/payload/forked_from_id")
                .and_then(Value::as_str),
            Some(source_id)
        );
        let serialized = serde_json::to_string(&crafted).unwrap();
        assert!(serialized.contains("first prompt"));
        assert!(serialized.contains("first conclusion"));
        let tail = crafted
            .iter()
            .position(|record| {
                record.pointer("/payload/type").and_then(Value::as_str) == Some("user_message")
            })
            .unwrap();
        assert_eq!(
            crafted[tail]
                .pointer("/payload/message")
                .and_then(Value::as_str),
            Some("second prompt")
        );
        assert_eq!(
            crafted[tail + 1]
                .pointer("/payload/turn_id")
                .and_then(Value::as_str),
            Some("turn-two")
        );
    }

    #[test]
    fn hint_weights_matching_conclusions_and_default_keeps_two_steps() {
        assert_eq!(ContextForkOptions::default().keep_last_steps, 2);
        let long = "x".repeat(1_000);
        let steps = vec![
            DigestStep {
                id: "one".to_owned(),
                prompt: "database migrations".to_owned(),
                response: long.clone(),
                files: Vec::new(),
                aborted: false,
            },
            DigestStep {
                id: "two".to_owned(),
                prompt: "css colors".to_owned(),
                response: long,
                files: Vec::new(),
                aborted: false,
            },
        ];
        let reference = NativeSessionReference {
            id: "codex:test".to_owned(),
            adapter: "codex".to_owned(),
            path: PathBuf::from("/test"),
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        };
        let digest = build_digest(&reference, &steps, 2, Some("database migrations"));
        let lines = digest.lines().collect::<Vec<_>>();
        assert!(
            lines
                .iter()
                .find(|line| line.starts_with("1. x"))
                .unwrap()
                .len()
                > 900
        );
        assert!(
            lines
                .iter()
                .find(|line| line.starts_with("2. x"))
                .unwrap()
                .len()
                < 310
        );
    }
}
