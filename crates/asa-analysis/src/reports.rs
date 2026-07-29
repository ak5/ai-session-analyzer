use crate::{
    ParseError, Usage,
    distill::{SignalKind, extract_signals},
    parse_session,
};
use asa_adapters::NativeSessionReference;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SessionIntent {
    pub session_id: String,
    pub adapter: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub started_at: Option<String>,
    pub first_prompt: String,
    pub intent: String,
    pub pr_links: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RepoIntent {
    pub cwd: String,
    pub sessions: usize,
    pub dominant: String,
    pub share: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct IntentReport {
    pub sessions: Vec<SessionIntent>,
    pub by_intent: BTreeMap<String, usize>,
    pub by_repo: Vec<RepoIntent>,
}

pub fn build_intent_report(
    references: &[NativeSessionReference],
) -> Result<IntentReport, ParseError> {
    let mut rows = Vec::new();
    for reference in references {
        let session = parse_session(reference)?;
        let signals = extract_signals(reference, &session)?;
        let Some(first) = signals.first() else {
            continue;
        };
        if first.text.starts_with("[asa-internal]") {
            continue;
        }
        rows.push(SessionIntent {
            session_id: session.id,
            adapter: session.adapter,
            cwd: session.cwd,
            title: session.title,
            started_at: session.started_at,
            first_prompt: preview(&first.text, 100),
            intent: classify_intent(&first.text).to_owned(),
            pr_links: session.interactions.pr_links,
        });
    }
    let mut by_intent = BTreeMap::new();
    let mut by_cwd: BTreeMap<String, Vec<&SessionIntent>> = BTreeMap::new();
    for row in &rows {
        *by_intent.entry(row.intent.clone()).or_insert(0) += 1;
        if let Some(cwd) = &row.cwd {
            by_cwd.entry(cwd.clone()).or_default().push(row);
        }
    }
    let mut by_repo = by_cwd
        .into_iter()
        .filter(|(_, group)| group.len() >= 2)
        .map(|(cwd, group)| {
            let mut counts = BTreeMap::new();
            for row in &group {
                *counts.entry(row.intent.clone()).or_insert(0) += 1;
            }
            let (dominant, count) = counts
                .into_iter()
                .max_by_key(|(_, count)| *count)
                .expect("non-empty repository group");
            RepoIntent {
                cwd,
                sessions: group.len(),
                dominant,
                share: ratio(count, group.len()),
            }
        })
        .collect::<Vec<_>>();
    by_repo.sort_by_key(|entry| std::cmp::Reverse(entry.sessions));
    Ok(IntentReport {
        sessions: rows,
        by_intent,
        by_repo,
    })
}

fn classify_intent(prompt: &str) -> &'static str {
    let words = tokenize(prompt);
    let start = prompt
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();
    for (intent, candidates) in [
        (
            "bugfix",
            &[
                "fix",
                "bug",
                "broken",
                "fail",
                "failing",
                "error",
                "crash",
                "regression",
                "debug",
            ][..],
        ),
        (
            "refactor",
            &[
                "refactor",
                "cleanup",
                "simplify",
                "restructure",
                "rename",
                "extract",
                "reorganize",
                "migrate",
            ],
        ),
        (
            "ops",
            &[
                "deploy", "release", "publish", "pipeline", "docker", "infra", "server", "dns",
                "domain", "monitor", "backup", "cron",
            ],
        ),
        (
            "learning",
            &[
                "learn",
                "explain",
                "teach",
                "flashcard",
                "anki",
                "tutorial",
                "study",
            ],
        ),
        (
            "research",
            &[
                "investigate",
                "research",
                "compare",
                "evaluate",
                "brainstorm",
                "analyze",
                "analyse",
                "explore",
            ],
        ),
        (
            "feature",
            &[
                "add",
                "implement",
                "build",
                "create",
                "scaffold",
                "support",
                "new",
                "write",
                "make",
                "ship",
                "integrate",
            ],
        ),
    ] {
        if candidates.iter().any(|word| words.contains(*word)) {
            return intent;
        }
        if intent == "research"
            && [
                "how", "why", "what", "which", "where", "can", "could", "should", "is", "are",
                "do", "does",
            ]
            .contains(&start.as_str())
        {
            return intent;
        }
    }
    "other"
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelStat {
    pub model: String,
    pub adapter: String,
    pub sessions: usize,
    pub api_calls: u64,
    pub output_tokens: u64,
    pub share: f64,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ModelWeek {
    pub week: String,
    pub calls: BTreeMap<String, u64>,
    pub dominant: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ModelSwitch {
    pub week: String,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelReport {
    pub models: Vec<ModelStat>,
    pub favorites: BTreeMap<String, String>,
    pub weekly: Vec<ModelWeek>,
    pub switches: Vec<ModelSwitch>,
}

pub fn build_model_report(
    references: &[NativeSessionReference],
) -> Result<ModelReport, ParseError> {
    let mut stats: BTreeMap<(String, String), ModelStat> = BTreeMap::new();
    let mut weekly: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for reference in references {
        let session = parse_session(reference)?;
        for (raw_model, usage) in &session.model_usage {
            if raw_model.starts_with('<') {
                continue;
            }
            let model = display_model(raw_model);
            let stat = stats
                .entry((session.adapter.clone(), model.clone()))
                .or_insert_with(|| ModelStat {
                    model: model.clone(),
                    adapter: session.adapter.clone(),
                    sessions: 0,
                    api_calls: 0,
                    output_tokens: 0,
                    share: 0.0,
                    first_seen: None,
                    last_seen: None,
                });
            stat.sessions += 1;
            stat.api_calls = stat.api_calls.saturating_add(usage.api_calls);
            stat.output_tokens = stat.output_tokens.saturating_add(usage.output_tokens);
            if let Some(started) = &session.started_at {
                if stat.first_seen.as_ref().is_none_or(|value| started < value) {
                    stat.first_seen = Some(started.clone());
                }
                if stat.last_seen.as_ref().is_none_or(|value| started > value) {
                    stat.last_seen = Some(started.clone());
                }
                if let Some(week) = week_key(started) {
                    let calls = weekly.entry(week).or_default().entry(model).or_default();
                    *calls = calls.saturating_add(usage.api_calls);
                }
            }
        }
    }
    let mut per_adapter = BTreeMap::new();
    for stat in stats.values() {
        let calls: &mut u64 = per_adapter.entry(stat.adapter.clone()).or_default();
        *calls = calls.saturating_add(stat.api_calls);
    }
    for stat in stats.values_mut() {
        stat.share = ratio(
            stat.api_calls,
            *per_adapter.get(&stat.adapter).unwrap_or(&0),
        );
    }
    let mut models = stats.into_values().collect::<Vec<_>>();
    models.sort_by_key(|stat| std::cmp::Reverse(stat.api_calls));
    let mut favorites = BTreeMap::new();
    for adapter in per_adapter.keys() {
        if let Some(best) = models
            .iter()
            .filter(|stat| &stat.adapter == adapter)
            .max_by_key(|stat| stat.api_calls)
        {
            favorites.insert(adapter.clone(), best.model.clone());
        }
    }
    let weeks = weekly
        .into_iter()
        .filter_map(|(week, calls)| {
            let dominant = calls
                .iter()
                .max_by_key(|(_, count)| *count)
                .map(|(model, _)| model.clone())?;
            Some(ModelWeek {
                week,
                calls,
                dominant,
            })
        })
        .collect::<Vec<_>>();
    let switches = weeks
        .windows(2)
        .filter(|pair| pair[0].dominant != pair[1].dominant)
        .map(|pair| ModelSwitch {
            week: pair[1].week.clone(),
            from: pair[0].dominant.clone(),
            to: pair[1].dominant.clone(),
        })
        .collect();
    Ok(ModelReport {
        models,
        favorites,
        weekly: weeks,
        switches,
    })
}

fn display_model(model: &str) -> String {
    let Some((prefix, suffix)) = model.rsplit_once('-') else {
        return model.to_owned();
    };
    if suffix.len() == 8
        && suffix.starts_with("20")
        && suffix.chars().all(|character| character.is_ascii_digit())
    {
        prefix.to_owned()
    } else {
        model.to_owned()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstructionFile {
    pub path: String,
    pub exists: bool,
    pub size_bytes: Option<u64>,
    pub modified_at_unix_ms: Option<u128>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectReport {
    pub path: PathBuf,
    pub sessions: usize,
    pub per_agent: BTreeMap<String, usize>,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    pub usage: Usage,
    pub steps: usize,
    pub api_calls: u64,
    pub tool_calls: usize,
    pub tool_errors: usize,
    pub mcp_calls: usize,
    pub subagents: u64,
    pub interruptions: u64,
    pub commands: u64,
    pub pr_links: u64,
    pub compactions: u64,
    pub top_tools: Vec<(String, usize)>,
    pub mcp_servers: Vec<(String, usize)>,
    pub instruction_files: Vec<InstructionFile>,
}

pub fn build_project_report(
    repo: &Path,
    references: &[NativeSessionReference],
) -> Result<ProjectReport, ParseError> {
    let mut sessions = Vec::new();
    for reference in references {
        let session = parse_session(reference)?;
        if session
            .cwd
            .as_deref()
            .is_some_and(|cwd| belongs_to_repo(cwd, repo))
        {
            sessions.push(session);
        }
    }
    let mut usage = Usage::default();
    let mut per_agent = BTreeMap::new();
    let mut timestamps = Vec::new();
    let mut tools = BTreeMap::new();
    let mut servers = BTreeMap::new();
    let mut steps = 0;
    let mut api_calls = 0_u64;
    let mut tool_calls = 0;
    let mut tool_errors = 0;
    let mut mcp_calls = 0;
    for session in &sessions {
        *per_agent.entry(session.adapter.clone()).or_insert(0) += 1;
        usage.add(&session.usage);
        if let Some(started) = &session.started_at {
            timestamps.push(started.clone());
        }
        steps += session.steps.len();
        for step in &session.steps {
            api_calls = api_calls.saturating_add(step.api_calls);
            tool_calls += step.tool_calls.len();
            for call in &step.tool_calls {
                *tools.entry(call.name.clone()).or_insert(0) += 1;
                tool_errors += usize::from(call.is_error);
                mcp_calls += usize::from(call.is_mcp);
                if let Some(server) = &call.mcp_server {
                    *servers.entry(server.clone()).or_insert(0) += 1;
                }
            }
        }
    }
    timestamps.sort();
    let mut top_tools = tools.into_iter().collect::<Vec<_>>();
    top_tools.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    top_tools.truncate(12);
    let mut mcp_servers = servers.into_iter().collect::<Vec<_>>();
    mcp_servers.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    Ok(ProjectReport {
        path: repo.to_path_buf(),
        sessions: sessions.len(),
        per_agent,
        first_at: timestamps.first().cloned(),
        last_at: timestamps.last().cloned(),
        usage,
        steps,
        api_calls,
        tool_calls,
        tool_errors,
        mcp_calls,
        subagents: sessions.iter().map(|session| session.subagents).sum(),
        interruptions: sessions
            .iter()
            .map(|session| session.interactions.interruptions)
            .sum(),
        commands: sessions
            .iter()
            .map(|session| session.interactions.commands)
            .sum(),
        pr_links: sessions
            .iter()
            .map(|session| session.interactions.pr_links)
            .sum(),
        compactions: sessions.iter().map(|session| session.compactions).sum(),
        top_tools,
        mcp_servers,
        instruction_files: instruction_inventory(repo),
    })
}

fn instruction_inventory(repo: &Path) -> Vec<InstructionFile> {
    [
        "CLAUDE.md",
        "AGENTS.md",
        ".claude/settings.json",
        ".codex/hooks.json",
        "docs/dev-faq.md",
        ".asa/git-trace.jsonl",
    ]
    .iter()
    .map(|relative| {
        let metadata = fs::metadata(repo.join(relative)).ok();
        InstructionFile {
            path: (*relative).to_owned(),
            exists: metadata.is_some(),
            size_bytes: metadata.as_ref().map(fs::Metadata::len),
            modified_at_unix_ms: metadata
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| {
                    modified
                        .duration_since(std::time::SystemTime::UNIX_EPOCH)
                        .ok()
                })
                .map(|duration| duration.as_millis()),
        }
    })
    .collect()
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstructionChange {
    pub file: String,
    pub commit: String,
    pub date: String,
    pub subject: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EfficacyWindow {
    pub sessions: usize,
    pub prompts: usize,
    pub correction_rate: Option<f64>,
    pub interruption_rate: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EfficacyEntry {
    pub change: InstructionChange,
    pub before: EfficacyWindow,
    pub after: EfficacyWindow,
}

#[derive(Clone, Debug)]
struct SteeringSample {
    started_at: String,
    prompts: usize,
    corrections: usize,
    interruptions: u64,
}

pub fn build_efficacy_report(
    repo: &Path,
    references: &[NativeSessionReference],
    changes: &[InstructionChange],
    window_size: usize,
) -> Result<Vec<EfficacyEntry>, ParseError> {
    let mut samples = Vec::new();
    for reference in references {
        let session = parse_session(reference)?;
        if !session
            .cwd
            .as_deref()
            .is_some_and(|cwd| belongs_to_repo(cwd, repo))
        {
            continue;
        }
        let Some(started_at) = session.started_at.clone() else {
            continue;
        };
        let signals = extract_signals(reference, &session)?;
        if signals
            .first()
            .is_some_and(|signal| signal.text.starts_with("[asa-internal]"))
        {
            continue;
        }
        samples.push(SteeringSample {
            started_at,
            prompts: signals.len(),
            corrections: signals
                .iter()
                .filter(|signal| signal.kind == SignalKind::Correction)
                .count(),
            interruptions: session.interactions.interruptions,
        });
    }
    samples.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    Ok(changes
        .iter()
        .map(|change| {
            let before = samples
                .iter()
                .filter(|sample| sample.started_at < change.date)
                .rev()
                .take(window_size)
                .collect::<Vec<_>>();
            let after = samples
                .iter()
                .filter(|sample| sample.started_at >= change.date)
                .take(window_size)
                .collect::<Vec<_>>();
            EfficacyEntry {
                change: change.clone(),
                before: efficacy_window(&before),
                after: efficacy_window(&after),
            }
        })
        .collect())
}

fn efficacy_window(samples: &[&SteeringSample]) -> EfficacyWindow {
    let prompts: usize = samples.iter().map(|sample| sample.prompts).sum();
    let corrections: usize = samples.iter().map(|sample| sample.corrections).sum();
    let interruptions = samples
        .iter()
        .map(|sample| sample.interruptions)
        .sum::<u64>();
    EfficacyWindow {
        sessions: samples.len(),
        prompts,
        correction_rate: (prompts > 0).then(|| ratio(corrections, prompts)),
        interruption_rate: (prompts > 0).then(|| ratio(interruptions, prompts)),
    }
}

#[must_use]
pub fn render_efficacy(entries: &[EfficacyEntry]) -> String {
    if entries.is_empty() {
        return "No AGENTS.md or CLAUDE.md commits found.".to_owned();
    }
    let mut lines =
        vec!["Instruction efficacy (correlational; model/task changes are confounds):".to_owned()];
    lines.extend(entries.iter().map(|entry| {
        format!(
            "  {} {} {} — correction {} → {}, interruption {} → {} ({} / {} sessions)",
            entry.change.date.get(..10).unwrap_or(&entry.change.date),
            entry.change.file,
            entry.change.commit.get(..8).unwrap_or(&entry.change.commit),
            percent(entry.before.correction_rate),
            percent(entry.after.correction_rate),
            percent(entry.before.interruption_rate),
            percent(entry.after.interruption_rate),
            entry.before.sessions,
            entry.after.sessions
        )
    }));
    lines.join("\n")
}

fn percent(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{:.0}%", value * 100.0))
}

fn belongs_to_repo(cwd: &str, repo: &Path) -> bool {
    let cwd = Path::new(cwd)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(cwd));
    let repo = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    cwd == repo || cwd.starts_with(repo)
}

#[must_use]
pub fn render_intents(report: &IntentReport) -> String {
    let mut lines = vec![format!(
        "Session intents — {} sessions",
        report.sessions.len()
    )];
    lines.extend(
        report
            .by_intent
            .iter()
            .map(|(intent, count)| format!("  {intent}: {count}")),
    );
    if !report.by_repo.is_empty() {
        lines.extend([String::new(), "Repository tendencies:".to_owned()]);
        lines.extend(report.by_repo.iter().map(|repo| {
            format!(
                "  {} — {} ({:.0}% of {} sessions)",
                repo.cwd,
                repo.dominant,
                repo.share * 100.0,
                repo.sessions
            )
        }));
    }
    lines.join("\n")
}

#[must_use]
pub fn render_models(report: &ModelReport) -> String {
    if report.models.is_empty() {
        return "No model usage found in scope.".to_owned();
    }
    let mut lines = vec!["Model usage:".to_owned()];
    lines.extend(report.models.iter().map(|model| {
        format!(
            "  {}  {} · {} sessions · {} API calls · {:.0}% · {} output tokens",
            model.model,
            model.adapter,
            model.sessions,
            model.api_calls,
            model.share * 100.0,
            model.output_tokens
        )
    }));
    lines.extend([String::new(), "Favorites:".to_owned()]);
    lines.extend(
        report
            .favorites
            .iter()
            .map(|(adapter, model)| format!("  {adapter}: {model}")),
    );
    if !report.switches.is_empty() {
        lines.extend([String::new(), "Weekly dominant-model switches:".to_owned()]);
        lines.extend(
            report
                .switches
                .iter()
                .map(|switch| format!("  {}: {} → {}", switch.week, switch.from, switch.to)),
        );
    }
    lines.join("\n")
}

#[must_use]
pub fn render_project(report: &ProjectReport) -> String {
    let mut lines = vec![
        format!("Project dossier — {}", report.path.display()),
        format!(
            "{} sessions · {} steps · {} API calls · {} tool calls ({} errors, {} MCP)",
            report.sessions,
            report.steps,
            report.api_calls,
            report.tool_calls,
            report.tool_errors,
            report.mcp_calls
        ),
        format!(
            "{} total tokens · {} interruptions · {} compactions · {} PR links",
            report.usage.total_tokens, report.interruptions, report.compactions, report.pr_links
        ),
        String::new(),
        "Instruction surfaces:".to_owned(),
    ];
    lines.extend(report.instruction_files.iter().map(|file| {
        format!(
            "  {} {}",
            if file.exists { "present" } else { "missing" },
            file.path
        )
    }));
    lines.extend(
        report
            .top_tools
            .iter()
            .map(|(tool, count)| format!("  tool {tool}: {count}")),
    );
    lines.join("\n")
}

fn tokenize(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn week_key(timestamp: &str) -> Option<String> {
    let parsed =
        time::OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
            .ok()?;
    let days = i64::from(parsed.weekday().number_days_from_monday());
    Some((parsed.date() - time::Duration::days(days)).to_string())
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

#[allow(clippy::cast_precision_loss)]
fn ratio<N, D>(numerator: N, denominator: D) -> f64
where
    N: TryInto<u64>,
    D: TryInto<u64>,
{
    let numerator = numerator.try_into().ok().unwrap_or(0);
    let denominator = denominator.try_into().ok().unwrap_or(0);
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn intent_rules_respect_value_order() {
        assert_eq!(classify_intent("fix the deployment crash"), "bugfix");
        assert_eq!(
            classify_intent("migrate and clean up the parser"),
            "refactor"
        );
        assert_eq!(classify_intent("how does this cache work?"), "research");
        assert_eq!(classify_intent("implement a dashboard"), "feature");
    }

    #[test]
    fn model_display_and_week_switches_are_stable() {
        assert_eq!(
            display_model("claude-haiku-4-5-20251001"),
            "claude-haiku-4-5"
        );
        assert_eq!(display_model("gpt-5.6-codex"), "gpt-5.6-codex");
        assert_eq!(
            week_key("2026-07-29T00:00:00Z").as_deref(),
            Some("2026-07-27")
        );
    }

    #[test]
    fn native_reports_cover_intents_models_and_project_inventory() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let claude = NativeSessionReference {
            id: "claude-code:11111111-1111-1111-1111-111111111111".to_owned(),
            adapter: "claude-code".to_owned(),
            path: manifest.join("../../fixtures/v2/transcripts/claude-session.jsonl"),
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        };
        let codex = NativeSessionReference {
            id: "codex:22222222-2222-2222-2222-222222222222".to_owned(),
            adapter: "codex".to_owned(),
            path: manifest.join("../../fixtures/v2/transcripts/codex-session.jsonl"),
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        };
        let intents = build_intent_report(&[claude.clone(), codex.clone()]).unwrap();
        assert_eq!(intents.sessions.len(), 2);
        assert_eq!(intents.by_intent["other"], 2);
        let models = build_model_report(&[claude, codex]).unwrap();
        assert_eq!(models.favorites["claude-code"], "claude-test");
        assert_eq!(models.favorites["codex"], "gpt-test");
        assert_eq!(
            models
                .models
                .iter()
                .map(|model| model.api_calls)
                .sum::<u64>(),
            3
        );

        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("AGENTS.md"), "instructions").unwrap();
        let id = "33333333-3333-3333-3333-333333333333";
        let path = temp.path().join(format!("{id}.jsonl"));
        fs::write(
            &path,
            format!(
                "{{\"type\":\"user\",\"uuid\":\"step\",\"sessionId\":\"{id}\",\"cwd\":{},\"message\":{{\"content\":\"fix it\"}}}}\n",
                serde_json::to_string(temp.path().to_str().unwrap()).unwrap()
            ),
        )
        .unwrap();
        let reference = NativeSessionReference {
            id: format!("claude-code:{id}"),
            adapter: "claude-code".to_owned(),
            path,
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        };
        let project = build_project_report(temp.path(), &[reference]).unwrap();
        assert_eq!(project.sessions, 1);
        assert!(
            project
                .instruction_files
                .iter()
                .any(|file| file.path == "AGENTS.md" && file.exists)
        );
    }

    #[test]
    fn efficacy_windows_are_bounded_and_rate_based() {
        let samples = [
            SteeringSample {
                started_at: "2026-07-01T00:00:00Z".to_owned(),
                prompts: 4,
                corrections: 2,
                interruptions: 1,
            },
            SteeringSample {
                started_at: "2026-07-02T00:00:00Z".to_owned(),
                prompts: 4,
                corrections: 0,
                interruptions: 0,
            },
        ];
        let window = efficacy_window(&samples.iter().collect::<Vec<_>>());
        assert_eq!(window.sessions, 2);
        assert_eq!(window.prompts, 8);
        assert_eq!(window.correction_rate, Some(0.25));
        assert_eq!(window.interruption_rate, Some(0.125));
    }
}
