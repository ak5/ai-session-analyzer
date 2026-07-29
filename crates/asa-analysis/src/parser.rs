use crate::{InteractionCounts, NormalizedSession, Step, ToolCall, Usage};
use asa_adapters::{AdapterName, NativeSessionReference};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn parse_session(reference: &NativeSessionReference) -> Result<NormalizedSession, ParseError> {
    let contents = fs::read_to_string(&reference.path)?;
    let mut malformed = 0_u64;
    let records = contents
        .lines()
        .filter_map(|line| {
            if line.trim().is_empty() {
                return None;
            }
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                Some(value)
            } else {
                malformed = malformed.saturating_add(1);
                None
            }
        })
        .collect::<Vec<_>>();
    let mut session = match reference.adapter.as_str() {
        "claude-code" => parse_claude(reference, &records),
        _ => parse_codex(reference, &records),
    };
    session.malformed_lines = malformed;
    Ok(session)
}

fn empty_session(reference: &NativeSessionReference) -> NormalizedSession {
    NormalizedSession {
        adapter: reference.adapter.clone(),
        id: reference.id.clone(),
        file_path: reference.path.clone(),
        cwd: None,
        title: reference.title.clone(),
        models: Vec::new(),
        model_usage: BTreeMap::new(),
        cli_version: None,
        started_at: None,
        ended_at: None,
        forked_from_id: None,
        compactions: 0,
        steps: Vec::new(),
        usage: Usage::default(),
        subagents: 0,
        interactions: InteractionCounts::default(),
        malformed_lines: 0,
    }
}

fn parse_claude(reference: &NativeSessionReference, records: &[Value]) -> NormalizedSession {
    let mut session = empty_session(reference);
    let mut models = BTreeSet::new();
    let mut seen_api = BTreeSet::new();
    let mut tool_locations: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut current_step: Option<usize> = None;
    for record in records {
        update_common_claude(&mut session, record);
        if record.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
            session.compactions = session.compactions.saturating_add(1);
        }
        match record.get("type").and_then(Value::as_str) {
            Some("user") => {
                if record.get("isMeta").and_then(Value::as_bool) == Some(true)
                    || record.get("isSidechain").and_then(Value::as_bool) == Some(true)
                {
                    continue;
                }
                let blocks = content_blocks(record);
                if blocks
                    .iter()
                    .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                {
                    apply_claude_tool_results(&mut session, &tool_locations, record);
                    if record
                        .get("toolUseResult")
                        .and_then(|result| result.get("agentId"))
                        .and_then(Value::as_str)
                        .is_some()
                    {
                        session.subagents = session.subagents.saturating_add(1);
                    }
                    continue;
                }
                let prompt = message_text(record);
                if prompt.trim().is_empty() || is_claude_harness_prompt(&prompt) {
                    continue;
                }
                if prompt.starts_with("[Request interrupted") {
                    session.interactions.interruptions =
                        session.interactions.interruptions.saturating_add(1);
                    if let Some(index) = current_step {
                        session.steps[index].aborted = true;
                    }
                    continue;
                }
                if prompt.contains("<command-name>") {
                    session.interactions.commands = session.interactions.commands.saturating_add(1);
                }
                let id = record.get("uuid").and_then(Value::as_str).map_or_else(
                    || format!("step-{}", session.steps.len()),
                    ToOwned::to_owned,
                );
                let index = open_step(&mut session, id, Some(&prompt));
                session.steps[index].aborted = false;
                current_step = Some(index);
            }
            Some("assistant") => {
                let index = if let Some(index) = current_step {
                    index
                } else {
                    let ordinal = session.steps.len();
                    open_step(&mut session, format!("step-{ordinal}"), None)
                };
                current_step = Some(index);
                session.steps[index].aborted = false;
                parse_claude_assistant(
                    &mut session,
                    index,
                    record,
                    &mut models,
                    &mut seen_api,
                    &mut tool_locations,
                );
            }
            Some("permission-mode") => {
                session.interactions.permission_mode_changes = session
                    .interactions
                    .permission_mode_changes
                    .saturating_add(1);
            }
            Some("queue-operation")
                if record.get("operation").and_then(Value::as_str) == Some("enqueue") =>
            {
                session.interactions.queued_prompts =
                    session.interactions.queued_prompts.saturating_add(1);
            }
            Some("pr-link") => {
                session.interactions.pr_links = session.interactions.pr_links.saturating_add(1);
            }
            Some("ai-title") => {
                session.title = record
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            _ => {}
        }
    }
    session.models = models.into_iter().collect();
    session
}

fn update_common_claude(session: &mut NormalizedSession, record: &Value) {
    if let Some(id) = record.get("sessionId").and_then(Value::as_str) {
        session.id = format!("claude-code:{id}");
    }
    session.cwd = session.cwd.take().or_else(|| {
        record
            .get("cwd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    });
    session.cli_version = session.cli_version.take().or_else(|| {
        record
            .get("version")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    });
    if let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) {
        session
            .started_at
            .get_or_insert_with(|| timestamp.to_owned());
        session.ended_at = Some(timestamp.to_owned());
    }
}

fn parse_claude_assistant(
    session: &mut NormalizedSession,
    step_index: usize,
    record: &Value,
    models: &mut BTreeSet<String>,
    seen_api: &mut BTreeSet<String>,
    tool_locations: &mut BTreeMap<String, (usize, usize)>,
) {
    let message = record.get("message").unwrap_or(&Value::Null);
    let api_id = message
        .get("id")
        .or_else(|| record.get("requestId"))
        .or_else(|| record.get("uuid"))
        .and_then(Value::as_str)
        .map_or_else(
            || format!("anonymous-{}", seen_api.len()),
            ToOwned::to_owned,
        );
    let model = message.get("model").and_then(Value::as_str);
    if let Some(model) = model {
        models.insert(model.to_owned());
        session.steps[step_index].model = Some(model.to_owned());
    }
    if seen_api.insert(api_id) {
        session.steps[step_index].api_calls = session.steps[step_index].api_calls.saturating_add(1);
        let usage = claude_usage(message.get("usage"));
        session.steps[step_index].usage.add(&usage);
        session.usage.add(&usage);
        if let Some(model) = model {
            let model_usage = session.model_usage.entry(model.to_owned()).or_default();
            model_usage.api_calls = model_usage.api_calls.saturating_add(1);
            model_usage.output_tokens = model_usage
                .output_tokens
                .saturating_add(usage.output_tokens);
        }
    }
    for block in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(id) = block.get("id").and_then(Value::as_str) else {
            continue;
        };
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("(unknown)");
        let (is_mcp, mcp_server) = classify_tool(AdapterName::ClaudeCode, name);
        let call_index = session.steps[step_index].tool_calls.len();
        session.steps[step_index].tool_calls.push(ToolCall {
            id: id.to_owned(),
            name: name.to_owned(),
            is_mcp,
            mcp_server,
            is_error: false,
        });
        tool_locations.insert(id.to_owned(), (step_index, call_index));
    }
}

fn apply_claude_tool_results(
    session: &mut NormalizedSession,
    locations: &BTreeMap<String, (usize, usize)>,
    record: &Value,
) {
    for block in content_blocks(record) {
        let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
            continue;
        };
        let Some((step, call)) = locations.get(id) else {
            continue;
        };
        session.steps[*step].tool_calls[*call].is_error =
            block.get("is_error").and_then(Value::as_bool) == Some(true);
    }
}

fn parse_codex(reference: &NativeSessionReference, records: &[Value]) -> NormalizedSession {
    let mut session = empty_session(reference);
    let mut models = BTreeSet::new();
    let mut current_step: Option<usize> = None;
    let mut current_model = None;
    let mut pending_prompt = None;
    let mut cumulative = Usage::default();
    let mut step_start = Usage::default();
    let mut tool_locations: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for record in records {
        update_codex_time(&mut session, record);
        let payload = record.get("payload").unwrap_or(&Value::Null);
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => parse_codex_meta(&mut session, payload),
            Some("turn_context") => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    models.insert(model.to_owned());
                    current_model = Some(model.to_owned());
                }
            }
            Some("compacted") => {
                session.compactions = session.compactions.saturating_add(1);
            }
            Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    pending_prompt = payload
                        .get("message")
                        .or_else(|| payload.get("text"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                }
                Some("task_started") => {
                    close_codex_step(&mut session, current_step, &cumulative, &step_start);
                    step_start = cumulative.clone();
                    let id = payload.get("turn_id").and_then(Value::as_str).map_or_else(
                        || format!("turn-{}", session.steps.len()),
                        ToOwned::to_owned,
                    );
                    current_step = Some(open_step(&mut session, id, pending_prompt.as_deref()));
                    if let Some(index) = current_step {
                        session.steps[index].model.clone_from(&current_model);
                    }
                    pending_prompt = None;
                }
                Some("task_complete") => {
                    if let Some(index) = current_step {
                        session.steps[index].aborted = false;
                    }
                }
                Some("token_count") => {
                    if let Some(total) = payload
                        .get("info")
                        .and_then(|info| info.get("total_token_usage"))
                    {
                        cumulative = codex_usage(Some(total));
                    }
                    if let Some(index) = current_step {
                        session.steps[index].api_calls =
                            session.steps[index].api_calls.saturating_add(1);
                    }
                }
                _ => {}
            },
            Some("response_item") => parse_codex_response_item(
                &mut session,
                &mut current_step,
                &mut tool_locations,
                payload,
            ),
            _ => {}
        }
    }
    close_codex_step(&mut session, current_step, &cumulative, &step_start);
    session.usage = cumulative;
    session.models = models.into_iter().collect();
    session
}

fn parse_codex_meta(session: &mut NormalizedSession, payload: &Value) {
    if let Some(id) = payload.get("id").and_then(Value::as_str) {
        session.id = format!("codex:{id}");
    }
    session.cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| session.cwd.take());
    session.cli_version = payload
        .get("cli_version")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| session.cli_version.take());
    session.forked_from_id = payload
        .get("forked_from_id")
        .and_then(Value::as_str)
        .map(|id| format!("codex:{id}"));
}

fn parse_codex_response_item(
    session: &mut NormalizedSession,
    current_step: &mut Option<usize>,
    locations: &mut BTreeMap<String, (usize, usize)>,
    payload: &Value,
) {
    match payload.get("type").and_then(Value::as_str) {
        Some("function_call" | "custom_tool_call") => {
            let Some(id) = payload.get("call_id").and_then(Value::as_str) else {
                return;
            };
            let index = current_step.unwrap_or_else(|| {
                let index = open_step(session, format!("turn-{}", session.steps.len()), None);
                *current_step = Some(index);
                index
            });
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("(unknown)");
            let (is_mcp, mcp_server) = classify_tool(AdapterName::Codex, name);
            let call_index = session.steps[index].tool_calls.len();
            session.steps[index].tool_calls.push(ToolCall {
                id: id.to_owned(),
                name: name.to_owned(),
                is_mcp,
                mcp_server,
                is_error: false,
            });
            locations.insert(id.to_owned(), (index, call_index));
        }
        Some("function_call_output" | "custom_tool_call_output") => {
            let Some(id) = payload.get("call_id").and_then(Value::as_str) else {
                return;
            };
            if let Some((step, call)) = locations.get(id) {
                let output = payload.get("output").and_then(Value::as_str).unwrap_or("");
                session.steps[*step].tool_calls[*call].is_error =
                    output.contains("\"is_error\":true") || output.contains("exit code 1");
            }
        }
        _ => {}
    }
}

fn close_codex_step(
    session: &mut NormalizedSession,
    current: Option<usize>,
    cumulative: &Usage,
    start: &Usage,
) {
    if let Some(index) = current {
        session.steps[index].usage = cumulative.difference(start);
        if let Some(model) = session.steps[index].model.clone() {
            let api_calls = session.steps[index].api_calls;
            let output_tokens = session.steps[index].usage.output_tokens;
            let model_usage = session.model_usage.entry(model).or_default();
            model_usage.api_calls = model_usage.api_calls.saturating_add(api_calls);
            model_usage.output_tokens = model_usage.output_tokens.saturating_add(output_tokens);
        }
        if session.steps[index].aborted {
            session.interactions.interruptions =
                session.interactions.interruptions.saturating_add(1);
        }
    }
}

fn update_codex_time(session: &mut NormalizedSession, record: &Value) {
    if let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) {
        session
            .started_at
            .get_or_insert_with(|| timestamp.to_owned());
        session.ended_at = Some(timestamp.to_owned());
    }
}

fn open_step(session: &mut NormalizedSession, id: String, prompt: Option<&str>) -> usize {
    let index = session.steps.len();
    session.steps.push(Step {
        id,
        index,
        prompt_preview: prompt.map(preview),
        model: None,
        api_calls: 0,
        tool_calls: Vec::new(),
        usage: Usage::default(),
        aborted: true,
    });
    index
}

fn message_text(record: &Value) -> String {
    let content = record
        .get("message")
        .and_then(|message| message.get("content"));
    if let Some(text) = content.and_then(Value::as_str) {
        return text.to_owned();
    }
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn content_blocks(record: &Value) -> &[Value] {
    record
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn claude_usage(value: Option<&Value>) -> Usage {
    let input = value
        .and_then(|usage| number(usage, "input_tokens"))
        .unwrap_or(0);
    let output = value
        .and_then(|usage| number(usage, "output_tokens"))
        .unwrap_or(0);
    let cache_read = value
        .and_then(|usage| number(usage, "cache_read_input_tokens"))
        .unwrap_or(0);
    let cache_creation = value
        .and_then(|usage| number(usage, "cache_creation_input_tokens"))
        .unwrap_or(0);
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_creation,
        reasoning_tokens: 0,
        total_tokens: input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_creation),
    }
}

fn codex_usage(value: Option<&Value>) -> Usage {
    let input = value
        .and_then(|usage| number(usage, "input_tokens"))
        .unwrap_or(0);
    let output = value
        .and_then(|usage| number(usage, "output_tokens"))
        .unwrap_or(0);
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: value
            .and_then(|usage| number(usage, "cached_input_tokens"))
            .unwrap_or(0),
        cache_creation_tokens: 0,
        reasoning_tokens: value
            .and_then(|usage| number(usage, "reasoning_output_tokens"))
            .unwrap_or(0),
        total_tokens: value
            .and_then(|usage| number(usage, "total_tokens"))
            .unwrap_or_else(|| input.saturating_add(output)),
    }
}

fn number(value: &Value, name: &str) -> Option<u64> {
    value.get(name).and_then(Value::as_u64)
}

fn classify_tool(adapter: AdapterName, name: &str) -> (bool, Option<String>) {
    match adapter {
        AdapterName::ClaudeCode => {
            let server = name
                .strip_prefix("mcp__")
                .and_then(|rest| rest.split("__").next())
                .map(ToOwned::to_owned);
            (server.is_some(), server)
        }
        AdapterName::Codex => {
            let built_in = [
                "exec",
                "exec_command",
                "shell",
                "local_shell",
                "apply_patch",
                "update_plan",
                "view_image",
                "web_search",
                "read_file",
                "list_dir",
            ];
            if built_in.contains(&name) {
                return (false, None);
            }
            let server = name
                .split_once("__")
                .or_else(|| name.split_once('.'))
                .map(|(server, _)| server.to_owned());
            (server.is_some(), server)
        }
    }
}

fn preview(value: &str) -> String {
    let line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= 64 {
        return line;
    }
    format!("{}…", line.chars().take(63).collect::<String>())
}

fn is_claude_harness_prompt(value: &str) -> bool {
    [
        "<system-reminder",
        "<task-notification",
        "<background-task",
        "<tool-reminder",
        "<local-command-stdout>",
    ]
    .iter()
    .any(|prefix| value.trim_start().starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{analyze, compare};
    use std::path::PathBuf;

    fn reference(adapter: &str, id: &str, path: &str) -> NativeSessionReference {
        NativeSessionReference {
            id: format!("{adapter}:{id}"),
            adapter: adapter.to_owned(),
            path: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path),
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        }
    }

    #[test]
    fn parses_claude_usage_tools_and_truncated_tail() {
        let session = parse_session(&reference(
            "claude-code",
            "11111111-1111-1111-1111-111111111111",
            "../../fixtures/v2/transcripts/claude-session.jsonl",
        ))
        .unwrap();
        assert_eq!(session.steps.len(), 1);
        assert_eq!(session.steps[0].api_calls, 2);
        assert_eq!(session.steps[0].tool_calls.len(), 1);
        assert!(session.steps[0].tool_calls[0].is_mcp);
        assert_eq!(session.usage.input_tokens, 220);
        assert_eq!(session.usage.output_tokens, 50);
        assert_eq!(session.model_usage["claude-test"].api_calls, 2);
        assert_eq!(session.model_usage["claude-test"].output_tokens, 50);
        assert_eq!(session.malformed_lines, 1);
    }

    #[test]
    fn parses_codex_cumulative_usage_and_completed_turn() {
        let session = parse_session(&reference(
            "codex",
            "22222222-2222-2222-2222-222222222222",
            "../../fixtures/v2/transcripts/codex-session.jsonl",
        ))
        .unwrap();
        assert_eq!(session.steps.len(), 1);
        assert!(!session.steps[0].aborted);
        assert_eq!(session.steps[0].tool_calls.len(), 1);
        assert_eq!(session.usage.total_tokens, 240);
        assert_eq!(session.models, vec!["gpt-test"]);
        assert_eq!(session.model_usage["gpt-test"].api_calls, 1);
        assert_eq!(session.model_usage["gpt-test"].output_tokens, 40);
        assert_eq!(session.interactions.interruptions, 0);
    }

    #[test]
    fn sanitized_fixture_comparison_matches_retained_typescript_metrics() {
        let claude = analyze(
            parse_session(&reference(
                "claude-code",
                "11111111-1111-1111-1111-111111111111",
                "../../fixtures/v2/transcripts/claude-session.jsonl",
            ))
            .unwrap(),
        );
        let codex = analyze(
            parse_session(&reference(
                "codex",
                "22222222-2222-2222-2222-222222222222",
                "../../fixtures/v2/transcripts/codex-session.jsonl",
            ))
            .unwrap(),
        );
        let rows = compare(&claude, &codex)
            .into_iter()
            .map(|row| (row.metric, (row.a, row.b)))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(rows["steps"], (1, 1));
        assert_eq!(rows["api calls"], (2, 1));
        assert_eq!(rows["tool calls"], (1, 1));
        assert_eq!(rows["mcp calls"], (1, 0));
        assert_eq!(rows["duration (s)"], (3, 7));
        assert_eq!(rows["input tokens"], (220, 200));
        assert_eq!(rows["total tokens"], (330, 240));
    }
}
