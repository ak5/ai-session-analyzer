use crate::{NormalizedSession, parse_session};
use asa_adapters::NativeSessionReference;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

const INTERNAL_SENTINEL: &str = "[asa-internal]";
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "from", "into", "this", "that", "these", "those", "just", "also",
    "are", "was", "were", "been", "can", "could", "should", "would", "will", "does", "did", "our",
    "your", "you", "its", "but", "then", "else", "without",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DistillCluster {
    pub kind: String,
    pub representative: String,
    pub count: usize,
    pub sessions: Vec<String>,
    pub agents: Vec<String>,
    pub total_output_tokens: u64,
    pub total_tool_calls: usize,
    pub examples: Vec<String>,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ToolSequence {
    pub sequence: Vec<String>,
    pub count: usize,
    pub sessions: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CommandUsage {
    pub command: String,
    pub kind: String,
    pub count: usize,
    pub sessions: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DistillScope {
    pub sessions: usize,
    pub prompts: usize,
    pub per_agent: BTreeMap<String, usize>,
    pub cwds: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DistillReport {
    pub scope: DistillScope,
    pub procedures: Vec<DistillCluster>,
    pub questions: Vec<DistillCluster>,
    pub lessons: Vec<DistillCluster>,
    pub tool_sequences: Vec<ToolSequence>,
    pub command_usage: Vec<CommandUsage>,
}

#[derive(Clone, Debug)]
pub(crate) struct Signal {
    pub(crate) agent: String,
    pub(crate) session_id: String,
    pub(crate) step_id: String,
    pub(crate) text: String,
    pub(crate) kind: SignalKind,
    pub(crate) output_tokens: u64,
    pub(crate) tool_calls: usize,
    pub(crate) aborted: bool,
    pub(crate) timestamp: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SignalKind {
    Question,
    Correction,
    Directive,
    Command,
}

#[derive(Debug)]
struct WorkingCluster {
    kind: SignalKind,
    tokens: BTreeSet<String>,
    members: Vec<Signal>,
}

/// Mine recurring cross-session behavior locally without model or network calls.
pub fn distill_sessions(
    references: &[NativeSessionReference],
) -> Result<DistillReport, crate::ParseError> {
    let mut sessions = Vec::new();
    let mut signals = Vec::new();
    for reference in references {
        let session = parse_session(reference)?;
        let mut extracted = extract_signals(reference, &session)?;
        if extracted
            .first()
            .is_some_and(|signal| signal.text.starts_with(INTERNAL_SENTINEL))
        {
            continue;
        }
        signals.append(&mut extracted);
        sessions.push(session);
    }
    let mut seen = BTreeSet::new();
    signals.retain(|signal| seen.insert(format!("{}|{}", signal.step_id, signal.text)));
    let prompt_count = signals
        .iter()
        .filter(|signal| signal.kind != SignalKind::Command)
        .count();
    let clusters = cluster_signals(&signals);
    let command_usage = command_usage(&signals);
    let mut per_agent = BTreeMap::new();
    let mut cwds = BTreeSet::new();
    for session in &sessions {
        *per_agent.entry(session.adapter.clone()).or_insert(0) += 1;
        if let Some(cwd) = &session.cwd {
            cwds.insert(cwd.clone());
        }
    }
    Ok(DistillReport {
        scope: DistillScope {
            sessions: sessions.len(),
            prompts: prompt_count,
            per_agent,
            cwds: cwds.into_iter().collect(),
        },
        procedures: clusters
            .iter()
            .filter(|cluster| cluster.kind == "directive")
            .cloned()
            .collect(),
        questions: clusters
            .iter()
            .filter(|cluster| cluster.kind == "question")
            .cloned()
            .collect(),
        lessons: clusters
            .into_iter()
            .filter(|cluster| cluster.kind == "correction")
            .collect(),
        tool_sequences: mine_tool_sequences(&sessions),
        command_usage,
    })
}

pub(crate) fn extract_signals(
    reference: &NativeSessionReference,
    session: &NormalizedSession,
) -> Result<Vec<Signal>, crate::parser::ParseError> {
    let contents = fs::read_to_string(&reference.path)?;
    let records = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let prompts = if reference.adapter == "claude-code" {
        claude_prompts(&records)
    } else {
        codex_prompts(&records)
    };
    Ok(session
        .steps
        .iter()
        .filter_map(|step| {
            let text = prompts.get(&step.id)?.trim().to_owned();
            (!text.is_empty()).then(|| Signal {
                agent: session.adapter.clone(),
                session_id: session.id.clone(),
                step_id: step.id.clone(),
                kind: signal_kind(&text),
                text,
                output_tokens: step.usage.output_tokens,
                tool_calls: step.tool_calls.len(),
                aborted: step.aborted,
                timestamp: session.started_at.clone(),
            })
        })
        .collect())
}

fn claude_prompts(records: &[Value]) -> BTreeMap<String, String> {
    records
        .iter()
        .filter(|record| {
            record.get("type").and_then(Value::as_str) == Some("user")
                && record.get("isMeta").and_then(Value::as_bool) != Some(true)
                && record.get("isSidechain").and_then(Value::as_bool) != Some(true)
                && !record
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("tool_result")
                        })
                    })
        })
        .filter_map(|record| {
            let id = record.get("uuid").and_then(Value::as_str)?;
            let text = message_text(record);
            (!text.is_empty() && !is_harness(&text)).then(|| (id.to_owned(), text))
        })
        .collect()
}

fn codex_prompts(records: &[Value]) -> BTreeMap<String, String> {
    let mut pending = None;
    let mut prompts = BTreeMap::new();
    let mut ordinal = 0;
    for record in records {
        if record.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        match record.pointer("/payload/type").and_then(Value::as_str) {
            Some("user_message") => {
                pending = record
                    .pointer("/payload/message")
                    .or_else(|| record.pointer("/payload/text"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            Some("task_started") => {
                let id = record
                    .pointer("/payload/turn_id")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("turn-{ordinal}"), ToOwned::to_owned);
                ordinal += 1;
                if let Some(prompt) = pending.take() {
                    prompts.insert(id, prompt);
                }
            }
            _ => {}
        }
    }
    prompts
}

fn signal_kind(text: &str) -> SignalKind {
    let lower = text.trim().to_lowercase();
    if command_name(text).is_some() {
        return SignalKind::Command;
    }
    if [
        "no ",
        "no,",
        "no.",
        "no!",
        "nope",
        "wait ",
        "wait,",
        "actually ",
        "actually,",
        "not that",
        "not this",
        "that's not",
        "thats not",
        "wrong",
        "undo",
        "revert",
        "instead",
        "stop ",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
    {
        return SignalKind::Correction;
    }
    if lower.ends_with('?')
        || [
            "how ", "why ", "what ", "which ", "where ", "when ", "who ", "can ", "could ",
            "should ", "would ", "is ", "are ", "do ", "does ", "did ", "will ",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        SignalKind::Question
    } else {
        SignalKind::Directive
    }
}

fn command_name(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("<command-name>")
        && let Some((name, _)) = rest.split_once("</command-name>")
    {
        return Some(name.trim().to_owned());
    }
    let first = trimmed.split_whitespace().next()?;
    (first.starts_with('/') || first.starts_with('$')).then(|| first.to_owned())
}

fn cluster_signals(signals: &[Signal]) -> Vec<DistillCluster> {
    let mut eligible = signals
        .iter()
        .filter(|signal| signal.kind != SignalKind::Command && signal.text.chars().count() >= 15)
        .cloned()
        .collect::<Vec<_>>();
    eligible.sort_by_key(|signal| std::cmp::Reverse(signal.text.chars().count()));
    let mut working: Vec<WorkingCluster> = Vec::new();
    for signal in eligible {
        let tokens = tokenize(&signal.text);
        if tokens.is_empty() {
            continue;
        }
        if let Some(cluster) = working.iter_mut().find(|cluster| {
            cluster.kind == signal.kind && jaccard_at_least(&cluster.tokens, &tokens, 45)
        }) {
            cluster.members.push(signal);
        } else {
            working.push(WorkingCluster {
                kind: signal.kind,
                tokens,
                members: vec![signal],
            });
        }
    }
    let mut result = working
        .into_iter()
        .filter(|cluster| {
            cluster.members.len() >= 2
                && cluster
                    .members
                    .iter()
                    .map(|member| &member.session_id)
                    .collect::<BTreeSet<_>>()
                    .len()
                    >= 2
        })
        .map(|cluster| finalize_cluster(&cluster))
        .collect::<Vec<_>>();
    result.sort_by_key(|cluster| std::cmp::Reverse(cluster.count));
    result
}

fn finalize_cluster(cluster: &WorkingCluster) -> DistillCluster {
    let sessions = cluster
        .members
        .iter()
        .map(|member| member.session_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let agents = cluster
        .members
        .iter()
        .map(|member| member.agent.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut timestamps = cluster
        .members
        .iter()
        .filter_map(|member| member.timestamp.clone())
        .collect::<Vec<_>>();
    timestamps.sort();
    DistillCluster {
        kind: match cluster.kind {
            SignalKind::Question => "question",
            SignalKind::Correction => "correction",
            SignalKind::Directive | SignalKind::Command => "directive",
        }
        .to_owned(),
        representative: preview(&cluster.members[0].text, 90),
        count: cluster.members.len(),
        sessions,
        agents,
        total_output_tokens: cluster
            .members
            .iter()
            .map(|member| member.output_tokens)
            .sum(),
        total_tool_calls: cluster.members.iter().map(|member| member.tool_calls).sum(),
        examples: cluster
            .members
            .iter()
            .take(3)
            .map(|member| preview(&member.text, 90))
            .collect(),
        first_seen: timestamps.first().cloned(),
        last_seen: timestamps.last().cloned(),
    }
}

fn command_usage(signals: &[Signal]) -> Vec<CommandUsage> {
    let mut counts: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    for signal in signals
        .iter()
        .filter(|signal| signal.kind == SignalKind::Command)
    {
        let Some(command) = command_name(&signal.text) else {
            continue;
        };
        let entry = counts.entry(command).or_default();
        entry.0 += 1;
        entry.1.insert(signal.session_id.clone());
    }
    let mut usage = counts
        .into_iter()
        .map(|(command, (count, sessions))| CommandUsage {
            kind: if command.starts_with('$') {
                "unknown"
            } else {
                "builtin"
            }
            .to_owned(),
            command,
            count,
            sessions: sessions.len(),
        })
        .collect::<Vec<_>>();
    usage.sort_by_key(|entry| std::cmp::Reverse(entry.count));
    usage
}

fn mine_tool_sequences(sessions: &[NormalizedSession]) -> Vec<ToolSequence> {
    let mut stats: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    for session in sessions {
        for step in &session.steps {
            let labels = step
                .tool_calls
                .iter()
                .map(|call| call.name.clone())
                .collect::<Vec<_>>();
            for length in 2..=4 {
                for window in labels.windows(length) {
                    let key = window.join(" → ");
                    let entry = stats.entry(key).or_default();
                    entry.0 += 1;
                    entry.1.insert(session.id.clone());
                }
            }
        }
    }
    let generic = ["exec", "wait", "shell", "local_shell", "Bash"];
    let mut result = stats
        .into_iter()
        .filter(|(_, (count, sessions))| *count >= 3 && sessions.len() >= 2)
        .map(|(key, (count, sessions))| ToolSequence {
            sequence: key.split(" → ").map(ToOwned::to_owned).collect(),
            count,
            sessions: sessions.into_iter().collect(),
        })
        .filter(|entry| {
            entry
                .sequence
                .iter()
                .any(|label| !generic.contains(&label.as_str()))
        })
        .collect::<Vec<_>>();
    result.sort_by_key(|entry| std::cmp::Reverse(entry.count * entry.sequence.len()));
    result.truncate(12);
    result
}

fn tokenize(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| word.len() > 2 && !STOPWORDS.contains(word))
        .map(ToOwned::to_owned)
        .collect()
}

fn jaccard_at_least(a: &BTreeSet<String>, b: &BTreeSet<String>, percent: usize) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let intersection = a.intersection(b).count();
    let union = a.len() + b.len() - intersection;
    intersection.saturating_mul(100) >= union.saturating_mul(percent)
}

fn message_text(record: &Value) -> String {
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

fn is_harness(text: &str) -> bool {
    [
        "<system-reminder",
        "<task-notification",
        "<background-task",
        "<tool-reminder",
        "<local-command-stdout>",
        "[Request interrupted",
    ]
    .iter()
    .any(|prefix| text.trim_start().starts_with(prefix))
}

fn preview(text: &str, maximum: usize) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= maximum {
        clean
    } else {
        format!(
            "{}…",
            clean
                .chars()
                .take(maximum.saturating_sub(1))
                .collect::<String>()
        )
    }
}

#[must_use]
pub fn render_distill(report: &DistillReport) -> String {
    let agents = report
        .scope
        .per_agent
        .iter()
        .map(|(agent, count)| format!("{count} {agent}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut lines = vec![format!(
        "Distill — {} prompts across {} sessions ({}), {} projects",
        report.scope.prompts,
        report.scope.sessions,
        agents,
        report.scope.cwds.len()
    )];
    render_clusters(
        &mut lines,
        "Recurring procedures (skill candidates):",
        &report.procedures,
    );
    render_clusters(
        &mut lines,
        "Recurring questions (FAQ / flashcard candidates):",
        &report.questions,
    );
    render_clusters(
        &mut lines,
        "Recurring corrections (AGENTS.md rule candidates):",
        &report.lessons,
    );
    lines.extend([
        String::new(),
        "Recurring tool sequences (procedure evidence):".to_owned(),
    ]);
    if report.tool_sequences.is_empty() {
        lines.push("  none found".to_owned());
    } else {
        lines.extend(report.tool_sequences.iter().map(|entry| {
            format!(
                "  {}× / {} sessions  {}",
                entry.count,
                entry.sessions.len(),
                entry.sequence.join(" → ")
            )
        }));
    }
    lines.extend([
        String::new(),
        "Command usage (builtin/unknown until skill inventory is connected):".to_owned(),
    ]);
    if report.command_usage.is_empty() {
        lines.push("  none used in scope".to_owned());
    } else {
        lines.extend(report.command_usage.iter().map(|entry| {
            format!(
                "  {}  {}  {}× / {} sessions",
                entry.command, entry.kind, entry.count, entry.sessions
            )
        }));
    }
    lines.join("\n")
}

fn render_clusters(lines: &mut Vec<String>, title: &str, clusters: &[DistillCluster]) {
    lines.extend([String::new(), title.to_owned()]);
    if clusters.is_empty() {
        lines.push("  none found".to_owned());
    } else {
        lines.extend(clusters.iter().map(|cluster| {
            format!(
                "  {}× / {} sessions / {} / {} out-tokens  {}",
                cluster.count,
                cluster.sessions.len(),
                cluster.agents.join("+"),
                cluster.total_output_tokens,
                cluster.representative
            )
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn signal(text: &str, session: &str) -> Signal {
        Signal {
            agent: "claude-code".to_owned(),
            session_id: session.to_owned(),
            step_id: format!("{session}-{text}"),
            text: text.to_owned(),
            kind: signal_kind(text),
            output_tokens: 10,
            tool_calls: 1,
            aborted: false,
            timestamp: None,
        }
    }

    #[test]
    fn clustering_matches_cross_session_kind_and_ignores_noise() {
        let clusters = cluster_signals(&[
            signal("deploy the staging server and run smoke tests", "one"),
            signal("deploy staging server, run the smoke tests please", "two"),
            signal("how does the deploy pipeline work?", "one"),
            signal("how does the deploy pipeline actually work?", "three"),
            signal("ok", "one"),
            signal("ok", "two"),
        ]);
        assert_eq!(
            clusters
                .iter()
                .find(|cluster| cluster.kind == "directive")
                .unwrap()
                .count,
            2
        );
        assert_eq!(
            clusters
                .iter()
                .find(|cluster| cluster.kind == "question")
                .unwrap()
                .sessions
                .len(),
            2
        );
    }

    #[test]
    fn token_jaccard_and_command_classification_are_deterministic() {
        let a = tokenize("run the deploy script for the staging server");
        assert!(!a.contains("the"));
        assert!(a.contains("deploy"));
        assert!(jaccard_at_least(&a, &a, 100));
        assert!(!jaccard_at_least(&a, &tokenize("write unit tests"), 1));
        assert_eq!(
            command_name("<command-name>/verify</command-name>"),
            Some("/verify".to_owned())
        );
        assert_eq!(signal_kind("$session-closeout"), SignalKind::Command);
    }

    #[test]
    fn native_session_distill_excludes_internal_and_clusters_real_prompts() {
        let temp = TempDir::new().unwrap();
        let make = |id: &str, prompt: &str| {
            let path = temp.path().join(format!("{id}.jsonl"));
            let records = [
                serde_json::json!({"type":"user","uuid":format!("{id}-step"),"sessionId":id,"cwd":"/project","timestamp":"2026-07-01T00:00:00Z","message":{"content":prompt}}),
                serde_json::json!({"type":"assistant","uuid":format!("{id}-answer"),"sessionId":id,"message":{"id":format!("{id}-message"),"usage":{"output_tokens":10},"content":[{"type":"tool_use","id":format!("{id}-tool"),"name":"Read"}]}}),
            ];
            fs::write(
                &path,
                records
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
            NativeSessionReference {
                id: format!("claude-code:{id}"),
                adapter: "claude-code".to_owned(),
                path,
                title: None,
                updated_at_unix_ms: None,
                size_bytes: 0,
            }
        };
        let mut references = vec![
            make(
                "11111111-1111-1111-1111-111111111111",
                "deploy the staging server and run smoke tests",
            ),
            make(
                "22222222-2222-2222-2222-222222222222",
                "deploy staging server, run the smoke tests please",
            ),
            make(
                "33333333-3333-3333-3333-333333333333",
                "[asa-internal]\njudge these prompts",
            ),
        ];
        let copied_fork_path = temp
            .path()
            .join("44444444-4444-4444-4444-444444444444.jsonl");
        fs::copy(&references[0].path, &copied_fork_path).unwrap();
        references.push(NativeSessionReference {
            id: "claude-code:44444444-4444-4444-4444-444444444444".to_owned(),
            adapter: "claude-code".to_owned(),
            path: copied_fork_path,
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        });

        let report = distill_sessions(&references).unwrap();

        assert_eq!(report.scope.sessions, 3);
        assert_eq!(report.scope.prompts, 2);
        assert_eq!(report.procedures.len(), 1);
        assert_eq!(report.procedures[0].count, 2);
        assert_eq!(report.procedures[0].total_output_tokens, 20);
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("judge these")
        );
    }
}
