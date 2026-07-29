use crate::{
    NormalizedSession, ParseError,
    distill::{Signal, extract_signals},
    parse_session,
};
use asa_adapters::NativeSessionReference;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PrompterAggregate {
    pub sessions: usize,
    pub prompts: usize,
    pub corrections: usize,
    pub interruptions: u64,
    pub commands: u64,
    pub prompt_chars: usize,
    pub average_prompt_chars: usize,
    pub average_specificity: Option<f64>,
    pub vague_per_ten_prompts: f64,
    pub correction_rate: f64,
    pub interruption_rate: f64,
    pub output_tokens_per_prompt_kchar: Option<u64>,
    pub tool_calls_per_prompt: f64,
    pub prompts_per_session: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionPrompterStats {
    pub adapter: String,
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub started_at: Option<String>,
    pub prompts: usize,
    pub corrections: usize,
    pub interruptions: u64,
    pub commands: u64,
    pub queued_prompts: u64,
    pub pr_links: u64,
    pub prompt_chars: usize,
    pub average_prompt_chars: usize,
    pub average_specificity: Option<f64>,
    pub vague_count: usize,
    pub output_tokens: u64,
    pub tool_calls: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Archetype {
    pub name: String,
    pub description: String,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LintFinding {
    pub rule: String,
    pub severity: String,
    pub message: String,
    pub examples: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WeekBucket {
    pub week: String,
    pub sessions: usize,
    pub prompts: usize,
    pub correction_rate: f64,
    pub interruption_rate: f64,
    pub average_specificity: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Correlations {
    pub session_sample_size: usize,
    pub specificity_vs_correction_rate: Option<f64>,
    pub prompt_chars_vs_tool_calls: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkflowSummary {
    pub sessions_with_compactions: usize,
    pub compactions: u64,
    pub sessions_with_pr_links: usize,
    pub long_untracked_sessions: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PrompterReport {
    pub totals: PrompterAggregate,
    pub per_agent: BTreeMap<String, PrompterAggregate>,
    pub sessions: Vec<SessionPrompterStats>,
    pub archetype: Archetype,
    pub lints: Vec<LintFinding>,
    pub workflow: WorkflowSummary,
    pub skill_curve: Vec<WeekBucket>,
    pub correlations: Correlations,
}

#[derive(Clone, Debug)]
struct Features {
    chars: usize,
    is_correction: bool,
    has_path: bool,
    has_code: bool,
    vague_count: usize,
    specificity: f64,
}

#[derive(Clone, Debug)]
struct PromptDatum {
    signal: Signal,
    features: Features,
    corrected_by_next: bool,
}

/// Analyze human prompting behavior locally from explicitly selected native sessions.
// The assembly stays linear so every section visibly derives from one selected scope.
#[allow(clippy::cast_precision_loss, clippy::too_many_lines)]
pub fn analyze_prompter(
    references: &[NativeSessionReference],
) -> Result<PrompterReport, ParseError> {
    let mut sessions = Vec::new();
    let mut per_session = Vec::new();
    for reference in references {
        let session = parse_session(reference)?;
        let signals = extract_signals(reference, &session)?;
        if signals
            .first()
            .is_some_and(|signal| signal.text.starts_with("[asa-internal]"))
        {
            continue;
        }
        let mut data = signals
            .into_iter()
            .map(|signal| PromptDatum {
                features: features(&signal.text),
                signal,
                corrected_by_next: false,
            })
            .collect::<Vec<_>>();
        for index in 1..data.len() {
            if data[index].features.is_correction {
                data[index - 1].corrected_by_next = true;
            }
        }
        per_session.push(data);
        sessions.push(session);
    }
    let session_stats = sessions
        .iter()
        .zip(&per_session)
        .map(|(session, data)| session_stats(session, data))
        .collect::<Vec<_>>();
    let all = per_session.iter().flatten().cloned().collect::<Vec<_>>();
    let totals = aggregate(&session_stats, &all);
    let mut per_agent = BTreeMap::new();
    for adapter in session_stats
        .iter()
        .map(|stats| stats.adapter.clone())
        .collect::<std::collections::BTreeSet<_>>()
    {
        let stats = session_stats
            .iter()
            .filter(|stats| stats.adapter == adapter)
            .cloned()
            .collect::<Vec<_>>();
        let signals = all
            .iter()
            .filter(|datum| datum.signal.agent == adapter)
            .cloned()
            .collect::<Vec<_>>();
        per_agent.insert(adapter, aggregate(&stats, &signals));
    }
    let subagents_per_session = if sessions.is_empty() {
        0.0
    } else {
        ratio(
            sessions
                .iter()
                .map(|session| session.subagents)
                .sum::<u64>(),
            sessions.len(),
        )
    };
    let archetype = pick_archetype(&totals, subagents_per_session);
    let lints = lint(&totals, &all);
    let workflow = workflow(&sessions);
    let skill_curve = skill_curve(&all);
    let with_specificity = session_stats
        .iter()
        .filter(|stats| stats.prompts >= 2 && stats.average_specificity.is_some())
        .collect::<Vec<_>>();
    let correlations = Correlations {
        session_sample_size: with_specificity.len(),
        specificity_vs_correction_rate: pearson(
            &with_specificity
                .iter()
                .filter_map(|stats| stats.average_specificity)
                .collect::<Vec<_>>(),
            &with_specificity
                .iter()
                .map(|stats| ratio(stats.corrections, stats.prompts))
                .collect::<Vec<_>>(),
        ),
        prompt_chars_vs_tool_calls: pearson(
            &all.iter()
                .map(|datum| datum.features.chars as f64)
                .collect::<Vec<_>>(),
            &all.iter()
                .map(|datum| datum.signal.tool_calls as f64)
                .collect::<Vec<_>>(),
        ),
    };
    Ok(PrompterReport {
        totals,
        per_agent,
        sessions: session_stats,
        archetype,
        lints,
        workflow,
        skill_curve,
        correlations,
    })
}

fn session_stats(session: &NormalizedSession, data: &[PromptDatum]) -> SessionPrompterStats {
    let prompt_chars = data.iter().map(|datum| datum.features.chars).sum();
    let output_tokens = data.iter().map(|datum| datum.signal.output_tokens).sum();
    SessionPrompterStats {
        adapter: session.adapter.clone(),
        id: session.id.clone(),
        title: session.title.clone(),
        cwd: session.cwd.clone(),
        started_at: session.started_at.clone(),
        prompts: data.len(),
        corrections: data
            .iter()
            .filter(|datum| datum.features.is_correction)
            .count(),
        interruptions: session.interactions.interruptions,
        commands: session.interactions.commands,
        queued_prompts: session.interactions.queued_prompts,
        pr_links: session.interactions.pr_links,
        prompt_chars,
        average_prompt_chars: rounded_ratio(prompt_chars, data.len()),
        average_specificity: mean(
            &data
                .iter()
                .map(|datum| datum.features.specificity)
                .collect::<Vec<_>>(),
        ),
        vague_count: data.iter().map(|datum| datum.features.vague_count).sum(),
        output_tokens,
        tool_calls: data.iter().map(|datum| datum.signal.tool_calls).sum(),
    }
}

#[allow(clippy::cast_precision_loss)]
fn aggregate(stats: &[SessionPrompterStats], data: &[PromptDatum]) -> PrompterAggregate {
    let prompts = data.len();
    let prompt_chars = stats.iter().map(|stats| stats.prompt_chars).sum();
    let output_tokens = stats.iter().map(|stats| stats.output_tokens).sum::<u64>();
    let corrections = stats.iter().map(|stats| stats.corrections).sum();
    let interruptions = stats.iter().map(|stats| stats.interruptions).sum::<u64>();
    let vague = stats.iter().map(|stats| stats.vague_count).sum::<usize>();
    let tool_calls = stats.iter().map(|stats| stats.tool_calls).sum::<usize>();
    PrompterAggregate {
        sessions: stats.len(),
        prompts,
        corrections,
        interruptions,
        commands: stats.iter().map(|stats| stats.commands).sum(),
        prompt_chars,
        average_prompt_chars: rounded_ratio(prompt_chars, prompts),
        average_specificity: mean(
            &data
                .iter()
                .map(|datum| datum.features.specificity)
                .collect::<Vec<_>>(),
        ),
        vague_per_ten_prompts: if prompts == 0 {
            0.0
        } else {
            (vague as f64 / prompts as f64 * 100.0).round() / 10.0
        },
        correction_rate: ratio(corrections, prompts),
        interruption_rate: ratio(interruptions, prompts),
        output_tokens_per_prompt_kchar: (prompt_chars > 0).then(|| {
            let prompt_chars = u128::try_from(prompt_chars).unwrap_or(u128::MAX);
            let rounded =
                (u128::from(output_tokens).saturating_mul(1_000) + prompt_chars / 2) / prompt_chars;
            u64::try_from(rounded).unwrap_or(u64::MAX)
        }),
        tool_calls_per_prompt: ratio(tool_calls, prompts),
        prompts_per_session: ratio(prompts, stats.len()),
    }
}

fn features(text: &str) -> Features {
    let trimmed = text.trim();
    let lower = trimmed.to_lowercase();
    let chars = trimmed.chars().count();
    let is_correction = matches_correction(&lower);
    let has_path = trimmed.split_whitespace().any(|word| {
        word.contains('/')
            || [
                ".ts", ".tsx", ".js", ".py", ".rs", ".go", ".md", ".json", ".toml", ".yaml", ".sh",
                ".sql",
            ]
            .iter()
            .any(|extension| word.ends_with(extension))
    });
    let has_code = trimmed.contains('`')
        || trimmed.contains("--")
        || trimmed
            .split_whitespace()
            .any(|word| word.contains('_') || has_camel_case(word));
    let has_enumeration = trimmed
        .lines()
        .any(|line| matches!(line.trim_start().chars().next(), Some('-' | '*' | '•')));
    let vague_count: usize = [
        "etc",
        "or something",
        "or whatever",
        "somehow",
        "idk",
        "whatever works",
        "and so on",
        "stuff like that",
        "something like that",
    ]
    .iter()
    .map(|marker| lower.matches(marker).count())
    .sum();
    let imperative = [
        "add ",
        "fix ",
        "make ",
        "write ",
        "run ",
        "update ",
        "refactor ",
        "implement ",
        "create ",
        "remove ",
        "delete ",
        "rename ",
        "move ",
        "change ",
        "build ",
        "test ",
        "document ",
        "ship ",
        "deploy ",
        "investigate ",
        "check ",
        "verify ",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix));
    let mut specificity_tenths = 50_i32;
    specificity_tenths += if has_path { 15 } else { 0 };
    specificity_tenths += if has_code { 15 } else { 0 };
    specificity_tenths += if has_enumeration { 10 } else { 0 };
    specificity_tenths += if imperative { 10 } else { 0 };
    specificity_tenths += if (80..=2_000).contains(&chars) { 10 } else { 0 };
    specificity_tenths -= if chars < 20 { 20 } else { 0 };
    specificity_tenths -= i32::try_from(vague_count.min(3)).unwrap_or(3) * 10;
    Features {
        chars,
        is_correction,
        has_path,
        has_code,
        vague_count,
        specificity: f64::from(specificity_tenths.clamp(0, 100)) / 10.0,
    }
}

fn matches_correction(lower: &str) -> bool {
    [
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
        "i meant",
        "i said",
        "undo",
        "revert",
        "instead",
        "wrong",
        "stop ",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn has_camel_case(word: &str) -> bool {
    let mut saw_lower = false;
    for character in word.chars() {
        if character.is_ascii_lowercase() {
            saw_lower = true;
        } else if saw_lower && character.is_ascii_uppercase() {
            return true;
        }
    }
    false
}

fn pick_archetype(totals: &PrompterAggregate, subagents_per_session: f64) -> Archetype {
    let command_rate = ratio(totals.commands, totals.prompts);
    let steer_rate = totals.correction_rate + totals.interruption_rate;
    let evidence = vec![
        format!(
            "{} prompts across {} sessions ({:.1}/session)",
            totals.prompts, totals.sessions, totals.prompts_per_session
        ),
        format!(
            "average prompt {} chars, specificity {}/10",
            totals.average_prompt_chars,
            totals
                .average_specificity
                .map_or_else(|| "—".to_owned(), |value| format!("{value:.1}"))
        ),
        format!(
            "correction rate {:.0}%, interruption rate {:.0}%",
            totals.correction_rate * 100.0,
            totals.interruption_rate * 100.0
        ),
    ];
    let (name, description) = if totals.prompts == 0 {
        ("Unknown", "No prompt-bearing steps found in scope.")
    } else if steer_rate > 0.25 {
        (
            "The Micromanager",
            "Frequent corrections or interruptions suggest front-loading more constraints.",
        )
    } else if totals.average_prompt_chars > 700 && totals.prompts_per_session < 4.0 {
        (
            "The Cannonballer",
            "Few large briefs; effective when specifications are complete.",
        )
    } else if command_rate > 0.25 || subagents_per_session >= 1.5 {
        (
            "The Delegator",
            "Heavy command or subagent use means the harness carries much of the workflow.",
        )
    } else if totals.prompts_per_session >= 8.0 && totals.average_prompt_chars < 300 {
        (
            "The Gardener",
            "Many small prompts indicate incremental, high-touch steering.",
        )
    } else {
        (
            "The Balanced Operator",
            "No single steering pattern dominates the selected sessions.",
        )
    };
    Archetype {
        name: name.to_owned(),
        description: description.to_owned(),
        evidence,
    }
}

fn lint(totals: &PrompterAggregate, data: &[PromptDatum]) -> Vec<LintFinding> {
    let examples = |predicate: &dyn Fn(&PromptDatum) -> bool| {
        data.iter()
            .filter(|datum| predicate(datum))
            .take(3)
            .map(|datum| format!("{:?}", preview(&datum.signal.text, 90)))
            .collect::<Vec<_>>()
    };
    let mut findings = Vec::new();
    if totals.vague_per_ten_prompts > 1.5 {
        findings.push(LintFinding {
            rule: "vague-filler".to_owned(),
            severity: "warn".to_owned(),
            message: format!(
                "{} vague fillers per ten prompts delegate decisions without constraints.",
                totals.vague_per_ten_prompts
            ),
            examples: examples(&|datum| datum.features.vague_count > 0),
        });
    }
    let long_unanchored = data
        .iter()
        .filter(|datum| {
            datum.features.chars > 200 && !datum.features.has_path && !datum.features.has_code
        })
        .count();
    if data.len() >= 5 && ratio(long_unanchored, data.len()) > 0.3 {
        findings.push(LintFinding {
            rule: "unanchored-epics".to_owned(),
            severity: "warn".to_owned(),
            message: format!(
                "{long_unanchored}/{} long prompts name no path or code identifier.",
                data.len()
            ),
            examples: examples(&|datum| {
                datum.features.chars > 200 && !datum.features.has_path && !datum.features.has_code
            }),
        });
    }
    if totals.correction_rate > 0.15 {
        findings.push(LintFinding {
            rule: "correction-heavy".to_owned(),
            severity: "warn".to_owned(),
            message: format!(
                "{:.0}% of prompts are corrections.",
                totals.correction_rate * 100.0
            ),
            examples: examples(&|datum| datum.corrected_by_next),
        });
    }
    if totals.interruption_rate > 0.15 {
        findings.push(LintFinding {
            rule: "interrupt-heavy".to_owned(),
            severity: "warn".to_owned(),
            message: format!(
                "{:.0}% interruption rate; turns are often cut off.",
                totals.interruption_rate * 100.0
            ),
            examples: Vec::new(),
        });
    }
    if findings.is_empty() {
        findings.push(LintFinding {
            rule: "all-clear".to_owned(),
            severity: "info".to_owned(),
            message: "No local lint thresholds tripped in this scope.".to_owned(),
            examples: Vec::new(),
        });
    }
    findings
}

fn workflow(sessions: &[NormalizedSession]) -> WorkflowSummary {
    WorkflowSummary {
        sessions_with_compactions: sessions
            .iter()
            .filter(|session| session.compactions > 0)
            .count(),
        compactions: sessions.iter().map(|session| session.compactions).sum(),
        sessions_with_pr_links: sessions
            .iter()
            .filter(|session| session.interactions.pr_links > 0)
            .count(),
        long_untracked_sessions: sessions
            .iter()
            .filter(|session| session.steps.len() >= 10 && session.interactions.pr_links == 0)
            .count(),
    }
}

fn skill_curve(data: &[PromptDatum]) -> Vec<WeekBucket> {
    let mut weeks: BTreeMap<String, Vec<&PromptDatum>> = BTreeMap::new();
    for datum in data {
        let Some(timestamp) = &datum.signal.timestamp else {
            continue;
        };
        let Some(week_start) = week_key(timestamp) else {
            continue;
        };
        weeks.entry(week_start).or_default().push(datum);
    }
    weeks
        .into_iter()
        .map(|(week, values)| {
            let prompts = values.len();
            WeekBucket {
                week,
                sessions: values
                    .iter()
                    .map(|datum| &datum.signal.session_id)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len(),
                prompts,
                correction_rate: ratio(
                    values
                        .iter()
                        .filter(|datum| datum.features.is_correction)
                        .count(),
                    prompts,
                ),
                interruption_rate: ratio(
                    values.iter().filter(|datum| datum.signal.aborted).count(),
                    prompts,
                ),
                average_specificity: mean(
                    &values
                        .iter()
                        .map(|datum| datum.features.specificity)
                        .collect::<Vec<_>>(),
                ),
            }
        })
        .collect()
}

fn week_key(timestamp: &str) -> Option<String> {
    let parsed =
        time::OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
            .ok()?;
    let days_from_monday = i64::from(parsed.weekday().number_days_from_monday());
    Some((parsed.date() - time::Duration::days(days_from_monday)).to_string())
}

fn pearson(xs: &[f64], ys: &[f64]) -> Option<f64> {
    let length = xs.len().min(ys.len());
    if length < 4 {
        return None;
    }
    let mean_x = mean(&xs[..length])?;
    let mean_y = mean(&ys[..length])?;
    let mut numerator = 0.0;
    let mut delta_x = 0.0;
    let mut delta_y = 0.0;
    for index in 0..length {
        let x = xs[index] - mean_x;
        let y = ys[index] - mean_y;
        numerator += x * y;
        delta_x += x * x;
        delta_y += y * y;
    }
    (delta_x > 0.0 && delta_y > 0.0).then(|| numerator / (delta_x.sqrt() * delta_y.sqrt()))
}

#[allow(clippy::cast_precision_loss)]
fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
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

fn rounded_ratio(numerator: usize, denominator: usize) -> usize {
    if denominator == 0 {
        0
    } else {
        (numerator + denominator / 2) / denominator
    }
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
pub fn render_prompter(report: &PrompterReport) -> String {
    let totals = &report.totals;
    let mut lines = vec![
        format!(
            "Prompter report — {} prompts, {} sessions, {} chars typed",
            totals.prompts, totals.sessions, totals.prompt_chars
        ),
        format!(
            "average {} chars · specificity {} · corrections {:.0}% · interruptions {:.0}% · tools/prompt {:.1}",
            totals.average_prompt_chars,
            totals
                .average_specificity
                .map_or_else(|| "—".to_owned(), |value| format!("{value:.1}/10")),
            totals.correction_rate * 100.0,
            totals.interruption_rate * 100.0,
            totals.tool_calls_per_prompt
        ),
        String::new(),
        format!("Archetype: {}", report.archetype.name),
        format!("  {}", report.archetype.description),
        String::new(),
        "Lint:".to_owned(),
    ];
    lines.extend(report.lints.iter().map(|finding| {
        format!(
            "  [{}] {}: {}",
            finding.severity, finding.rule, finding.message
        )
    }));
    lines.extend([
        String::new(),
        "Workflow:".to_owned(),
        format!(
            "  compactions: {} sessions / {} total · PR-linked sessions: {} · long untracked sessions: {}",
            report.workflow.sessions_with_compactions,
            report.workflow.compactions,
            report.workflow.sessions_with_pr_links,
            report.workflow.long_untracked_sessions
        ),
        String::new(),
        "Sessions in scope:".to_owned(),
    ]);
    lines.extend(report.sessions.iter().map(|session| {
        format!(
            "  {}  {}  {} prompts · {} corrections · avg {} chars",
            session.id,
            session.adapter,
            session.prompts,
            session.corrections,
            session.average_prompt_chars
        )
    }));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn feature_scores_and_archetypes_are_explainable() {
        let anchored = features("Implement the parser in crates/asa-analysis/src/parser.rs");
        let vague = features("do it somehow or whatever");
        assert!(anchored.has_path);
        assert!(anchored.specificity > vague.specificity);
        assert!(features("Actually, use the other path").is_correction);
        let totals = PrompterAggregate {
            sessions: 2,
            prompts: 10,
            corrections: 3,
            interruptions: 0,
            commands: 0,
            prompt_chars: 1_000,
            average_prompt_chars: 100,
            average_specificity: Some(7.0),
            vague_per_ten_prompts: 0.0,
            correction_rate: 0.3,
            interruption_rate: 0.0,
            output_tokens_per_prompt_kchar: None,
            tool_calls_per_prompt: 1.0,
            prompts_per_session: 5.0,
        };
        assert_eq!(pick_archetype(&totals, 0.0).name, "The Micromanager");
    }

    #[test]
    fn pearson_requires_four_samples_and_detects_linear_relation() {
        assert_eq!(pearson(&[1.0, 2.0, 3.0], &[2.0, 4.0, 6.0]), None);
        let correlation = pearson(&[1.0, 2.0, 3.0, 4.0], &[2.0, 4.0, 6.0, 8.0]).unwrap();
        assert!((correlation - 1.0).abs() < 0.000_001);
    }

    #[test]
    fn native_prompter_report_excludes_internal_and_counts_corrections() {
        let temp = TempDir::new().unwrap();
        let make = |id: &str, prompts: &[&str]| {
            let path = temp.path().join(format!("{id}.jsonl"));
            let records = prompts
                .iter()
                .enumerate()
                .flat_map(|(index, prompt)| {
                    [
                        serde_json::json!({"type":"user","uuid":format!("{id}-step-{index}"),"sessionId":id,"cwd":"/project","timestamp":format!("2026-07-0{}T00:00:00Z", index + 1),"message":{"content":prompt}}),
                        serde_json::json!({"type":"assistant","uuid":format!("{id}-answer-{index}"),"sessionId":id,"message":{"id":format!("{id}-message-{index}"),"usage":{"output_tokens":20},"content":[{"type":"text","text":"done"}]}}),
                    ]
                })
                .collect::<Vec<_>>();
            fs::write(
                &path,
                records
                    .iter()
                    .map(ToString::to_string)
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
        let references = vec![
            make(
                "11111111-1111-1111-1111-111111111111",
                &[
                    "Implement the parser in crates/asa-analysis/src/parser.rs",
                    "Actually, preserve unknown fields too",
                ],
            ),
            make(
                "22222222-2222-2222-2222-222222222222",
                &["[asa-internal]\njudge these prompts"],
            ),
        ];

        let report = analyze_prompter(&references).unwrap();

        assert_eq!(report.totals.sessions, 1);
        assert_eq!(report.totals.prompts, 2);
        assert_eq!(report.totals.corrections, 1);
        assert!(
            report
                .totals
                .output_tokens_per_prompt_kchar
                .is_some_and(|value| value > 0)
        );
        assert_eq!(report.archetype.name, "The Micromanager");
        assert_eq!(report.skill_curve.len(), 1);
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("judge these")
        );
    }
}
