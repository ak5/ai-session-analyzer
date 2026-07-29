use crate::{AnalysisReport, ComparisonRow, McpServerStat, NormalizedSession, ToolStat};
use std::collections::BTreeMap;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[must_use]
pub fn analyze(session: NormalizedSession) -> AnalysisReport {
    let mut tools: BTreeMap<String, ToolStat> = BTreeMap::new();
    let mut servers: BTreeMap<String, u64> = BTreeMap::new();
    for call in session.steps.iter().flat_map(|step| &step.tool_calls) {
        let stat = tools.entry(call.name.clone()).or_insert(ToolStat {
            name: call.name.clone(),
            count: 0,
            errors: 0,
            is_mcp: call.is_mcp,
            mcp_server: call.mcp_server.clone(),
        });
        stat.count = stat.count.saturating_add(1);
        if call.is_error {
            stat.errors = stat.errors.saturating_add(1);
        }
        if let Some(server) = call.mcp_server.as_ref() {
            *servers.entry(server.clone()).or_default() += 1;
        }
    }
    let mut tool_stats = tools.into_values().collect::<Vec<_>>();
    tool_stats.sort_by_key(|stat| std::cmp::Reverse(stat.count));
    let mut mcp_servers = servers
        .into_iter()
        .map(|(server, calls)| McpServerStat { server, calls })
        .collect::<Vec<_>>();
    mcp_servers.sort_by_key(|stat| std::cmp::Reverse(stat.calls));
    let duration_ms = session
        .started_at
        .as_deref()
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
        .zip(
            session
                .ended_at
                .as_deref()
                .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok()),
        )
        .map(|(start, end)| (end - start).whole_milliseconds())
        .filter(|duration| *duration >= 0);
    let api_calls = session.steps.iter().map(|step| step.api_calls).sum();
    let tool_calls = count_calls(&session, |call| !call.name.is_empty());
    let mcp_calls = count_calls(&session, |call| call.is_mcp);
    let tool_errors = count_calls(&session, |call| call.is_error);
    AnalysisReport {
        steps: session.steps.len(),
        api_calls,
        tool_calls,
        mcp_calls,
        tool_errors,
        subagents: session.subagents,
        duration_ms,
        tool_stats,
        mcp_servers,
        session,
    }
}

fn count_calls(session: &NormalizedSession, predicate: impl Fn(&crate::ToolCall) -> bool) -> u64 {
    session
        .steps
        .iter()
        .flat_map(|step| &step.tool_calls)
        .filter(|call| predicate(call))
        .count()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[must_use]
pub fn compare(a: &AnalysisReport, b: &AnalysisReport) -> Vec<ComparisonRow> {
    let mut values = vec![
        ("steps", a.steps as i128, b.steps as i128),
        (
            "api calls",
            i128::from(a.api_calls),
            i128::from(b.api_calls),
        ),
        (
            "tool calls",
            i128::from(a.tool_calls),
            i128::from(b.tool_calls),
        ),
        (
            "tool errors",
            i128::from(a.tool_errors),
            i128::from(b.tool_errors),
        ),
        (
            "mcp calls",
            i128::from(a.mcp_calls),
            i128::from(b.mcp_calls),
        ),
        (
            "subagents",
            i128::from(a.subagents),
            i128::from(b.subagents),
        ),
        (
            "compactions",
            i128::from(a.session.compactions),
            i128::from(b.session.compactions),
        ),
        (
            "interruptions",
            i128::from(a.session.interactions.interruptions),
            i128::from(b.session.interactions.interruptions),
        ),
    ];
    if a.duration_ms.is_some() || b.duration_ms.is_some() {
        values.push((
            "duration (s)",
            a.duration_ms.unwrap_or_default() / 1_000,
            b.duration_ms.unwrap_or_default() / 1_000,
        ));
    }
    values.extend([
        (
            "input tokens",
            i128::from(a.session.usage.input_tokens),
            i128::from(b.session.usage.input_tokens),
        ),
        (
            "output tokens",
            i128::from(a.session.usage.output_tokens),
            i128::from(b.session.usage.output_tokens),
        ),
        (
            "cache-read tokens",
            i128::from(a.session.usage.cache_read_tokens),
            i128::from(b.session.usage.cache_read_tokens),
        ),
        (
            "cache-write tokens",
            i128::from(a.session.usage.cache_creation_tokens),
            i128::from(b.session.usage.cache_creation_tokens),
        ),
        (
            "total tokens",
            i128::from(a.session.usage.total_tokens),
            i128::from(b.session.usage.total_tokens),
        ),
    ]);
    values
        .into_iter()
        .map(|(metric, a, b)| ComparisonRow {
            metric: metric.to_owned(),
            a,
            b,
            delta: b - a,
        })
        .collect()
}
