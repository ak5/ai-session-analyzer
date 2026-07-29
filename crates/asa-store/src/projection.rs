use asa_analysis::NormalizedSession;
use asa_core::{
    AgentTrace, AsaPaths, AttributeValue, Observation, ObservationKind, ProjectionMetadata,
    SessionDocument, SessionId, SessionLineage, SessionSource, SpanDocument, SpanStatus, Surface,
    Turn, Usage, WorkspaceAttribution,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Read, Write},
    path::PathBuf,
};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Debug, Error)]
pub enum ProjectionError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("session encoding failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn project_observations(
    paths: &AsaPaths,
    observations: &[Observation],
) -> Result<Vec<SessionDocument>, ProjectionError> {
    let mut grouped: BTreeMap<&str, Vec<&Observation>> = BTreeMap::new();
    for observation in observations {
        grouped
            .entry(&observation.session_id)
            .or_default()
            .push(observation);
    }
    let mut sessions = Vec::with_capacity(grouped.len());
    for (session_id, mut group) in grouped {
        group.sort_by_key(|observation| observation.observed_at);
        let first = group[0];
        let source = if first.adapter == "claude-code" {
            SessionSource::ClaudeCode
        } else {
            SessionSource::Codex
        };
        let native_id = session_id
            .split_once(':')
            .map_or(session_id, |(_, native)| native);
        let id = SessionId::namespaced(&first.adapter, native_id);
        let mut workspaces: HashMap<String, WorkspaceAttribution> = HashMap::new();
        let mut turn_observations: BTreeMap<String, Vec<&Observation>> = BTreeMap::new();
        let mut current_turn: Option<String> = None;
        for observation in &group {
            if let Some(AttributeValue::String(path)) =
                observation.attributes.get("asa.workspace.path")
            {
                workspaces
                    .entry(path.clone())
                    .and_modify(|workspace| workspace.last_observed_at = observation.observed_at)
                    .or_insert(WorkspaceAttribution {
                        path: path.clone(),
                        first_observed_at: observation.observed_at,
                        last_observed_at: observation.observed_at,
                    });
            }
            if matches!(observation.kind, ObservationKind::PromptSubmitted) {
                current_turn = Some(
                    observation
                        .turn_id
                        .clone()
                        .unwrap_or_else(|| format!("derived:{}", observation.id)),
                );
            } else if let Some(explicit) = observation.turn_id.as_ref() {
                current_turn = Some(explicit.clone());
            } else if current_turn.is_none()
                && matches!(
                    observation.kind,
                    ObservationKind::ToolStarted
                        | ObservationKind::ToolCompleted
                        | ObservationKind::AgentStopped
                        | ObservationKind::SubagentStarted
                        | ObservationKind::SubagentStopped
                )
            {
                current_turn = Some(format!("derived:{}", observation.id));
            }
            if let Some(turn_id) = current_turn.as_ref() {
                turn_observations
                    .entry(turn_id.clone())
                    .or_default()
                    .push(observation);
            }
            if matches!(observation.kind, ObservationKind::AgentStopped) {
                current_turn = None;
            }
        }
        let conversation_id = SessionId::namespaced(&first.adapter, native_id);
        let (turns, traces): (Vec<_>, Vec<_>) = turn_observations
            .iter()
            .map(|(turn_id, observations)| project_turn(&conversation_id, turn_id, observations))
            .unzip();
        let session = SessionDocument {
            schema_version: 1,
            id,
            source,
            surface: Some(Surface::Unknown),
            lineage: SessionLineage::default(),
            workspaces: workspaces.into_values().collect(),
            started_at: group.first().map(|observation| observation.observed_at),
            ended_at: group.last().map(|observation| observation.observed_at),
            usage: Usage::default(),
            turns,
            traces,
            metadata: BTreeMap::new(),
            projection: ProjectionMetadata {
                observation_count: group.len() as u64,
                last_observation_id: group.last().map(|observation| observation.id.clone()),
                parser_version: 1,
            },
        };
        write_session(paths, &session)?;
        sessions.push(session);
    }
    Ok(sessions)
}

fn project_turn(
    conversation_id: &SessionId,
    turn_id: &str,
    observations: &[&Observation],
) -> (Turn, AgentTrace) {
    let trace_id = stable_hex(&format!("{conversation_id}\0{turn_id}"), 32);
    let root_span_id = stable_hex(&format!("{trace_id}\0invoke_agent"), 16);
    let stopped = observations
        .iter()
        .rev()
        .find(|observation| matches!(observation.kind, ObservationKind::AgentStopped));
    let assistant_output = stopped.and_then(|observation| {
        match observation.attributes.get("asa.assistant.response") {
            Some(AttributeValue::String(output)) => Some(output.clone()),
            _ => None,
        }
    });
    let mut tool_evidence: BTreeMap<String, (Option<&Observation>, Option<&Observation>)> =
        BTreeMap::new();
    let mut subagent_evidence: BTreeMap<String, (Option<&Observation>, Option<&Observation>)> =
        BTreeMap::new();
    for observation in observations {
        if matches!(
            observation.kind,
            ObservationKind::ToolStarted | ObservationKind::ToolCompleted
        ) {
            let invocation_id = observation
                .invocation_id
                .clone()
                .unwrap_or_else(|| format!("derived:{}", observation.id));
            let evidence = tool_evidence.entry(invocation_id).or_default();
            if matches!(observation.kind, ObservationKind::ToolStarted) {
                evidence.0 = Some(observation);
            } else {
                evidence.1 = Some(observation);
            }
        }
        if matches!(
            observation.kind,
            ObservationKind::SubagentStarted | ObservationKind::SubagentStopped
        ) {
            let invocation_id = observation
                .invocation_id
                .clone()
                .unwrap_or_else(|| format!("derived:{}", observation.id));
            let evidence = subagent_evidence.entry(invocation_id).or_default();
            if matches!(observation.kind, ObservationKind::SubagentStarted) {
                evidence.0 = Some(observation);
            } else {
                evidence.1 = Some(observation);
            }
        }
    }
    let root_span = SpanDocument {
        trace_id: trace_id.clone(),
        span_id: root_span_id.clone(),
        parent_span_id: None,
        operation_name: "invoke_agent".to_owned(),
        name: "invoke_agent".to_owned(),
        started_at: observations
            .first()
            .map(|observation| observation.observed_at),
        ended_at: stopped.map(|observation| observation.observed_at),
        status: if stopped.is_some() {
            SpanStatus::Ok
        } else {
            SpanStatus::Incomplete
        },
        attributes: BTreeMap::from([(
            "gen_ai.conversation.id".to_owned(),
            serde_json::Value::String(conversation_id.to_string()),
        )]),
    };
    let mut spans = vec![root_span];
    spans.extend(project_tool_spans(&trace_id, &root_span_id, &tool_evidence));
    spans.extend(project_subagent_spans(
        &trace_id,
        &root_span_id,
        &subagent_evidence,
    ));
    (
        Turn {
            id: turn_id.to_owned(),
            started_at: observations
                .first()
                .map(|observation| observation.observed_at),
            ended_at: stopped.map(|observation| observation.observed_at),
            completed: stopped.is_some(),
            tool_calls: u32::try_from(tool_evidence.len()).unwrap_or(u32::MAX),
            assistant_output,
            metadata: BTreeMap::new(),
        },
        AgentTrace {
            trace_id,
            conversation_id: conversation_id.clone(),
            turn_id: turn_id.to_owned(),
            spans,
        },
    )
}

fn project_subagent_spans(
    trace_id: &str,
    root_span_id: &str,
    evidence: &BTreeMap<String, (Option<&Observation>, Option<&Observation>)>,
) -> Vec<SpanDocument> {
    evidence
        .iter()
        .map(|(agent_id, (start, completion))| {
            let representative = start
                .or(*completion)
                .expect("subagent evidence is non-empty");
            let agent_name = match representative.attributes.get("gen_ai.agent.name") {
                Some(AttributeValue::String(name)) => name.clone(),
                _ => "subagent".to_owned(),
            };
            SpanDocument {
                trace_id: trace_id.to_owned(),
                span_id: stable_hex(&format!("{trace_id}\0invoke_agent\0{agent_id}"), 16),
                parent_span_id: Some(root_span_id.to_owned()),
                operation_name: "invoke_agent".to_owned(),
                name: format!("invoke_agent {agent_name}"),
                started_at: start
                    .or(*completion)
                    .map(|observation| observation.observed_at),
                ended_at: completion.map(|observation| observation.observed_at),
                status: match (start, completion) {
                    (Some(_), Some(_)) => SpanStatus::Ok,
                    _ => SpanStatus::Incomplete,
                },
                attributes: BTreeMap::from([
                    (
                        "gen_ai.agent.id".to_owned(),
                        serde_json::Value::String(agent_id.clone()),
                    ),
                    (
                        "gen_ai.agent.name".to_owned(),
                        serde_json::Value::String(agent_name),
                    ),
                ]),
            }
        })
        .collect()
}

fn project_tool_spans(
    trace_id: &str,
    root_span_id: &str,
    tool_evidence: &BTreeMap<String, (Option<&Observation>, Option<&Observation>)>,
) -> Vec<SpanDocument> {
    let mut spans = Vec::with_capacity(tool_evidence.len());
    for (invocation_id, (start, completion)) in tool_evidence {
        let representative = completion.or(*start).expect("tool evidence is non-empty");
        let tool_name = match representative.attributes.get("gen_ai.tool.name") {
            Some(AttributeValue::String(name)) => name.clone(),
            _ => "(unknown)".to_owned(),
        };
        spans.push(SpanDocument {
            trace_id: trace_id.to_owned(),
            span_id: stable_hex(&format!("{trace_id}\0execute_tool\0{invocation_id}"), 16),
            parent_span_id: Some(root_span_id.to_owned()),
            operation_name: "execute_tool".to_owned(),
            name: format!("execute_tool {tool_name}"),
            started_at: start
                .or(*completion)
                .map(|observation| observation.observed_at),
            ended_at: completion.map(|observation| observation.observed_at),
            status: match (start, completion) {
                (Some(_), Some(completion)) if completion.native_event == "PostToolUseFailure" => {
                    SpanStatus::Error
                }
                (Some(_), Some(_)) => SpanStatus::Ok,
                _ => SpanStatus::Incomplete,
            },
            attributes: BTreeMap::from([
                (
                    "gen_ai.tool.call.id".to_owned(),
                    serde_json::Value::String(invocation_id.clone()),
                ),
                (
                    "gen_ai.tool.name".to_owned(),
                    serde_json::Value::String(tool_name),
                ),
            ]),
        });
    }
    spans
}

fn stable_hex(input: &str, length: usize) -> String {
    let digest = hex::encode(Sha256::digest(input.as_bytes()));
    digest[..length].to_owned()
}

pub fn list_sessions(paths: &AsaPaths) -> Result<Vec<SessionDocument>, ProjectionError> {
    let mut sessions = Vec::new();
    let root = paths.sessions();
    if !root.exists() {
        return Ok(sessions);
    }
    for adapter in fs::read_dir(root)? {
        let adapter = adapter?;
        if !adapter.file_type()?.is_dir() {
            continue;
        }
        for entry in fs::read_dir(adapter.path())? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "zst")
            {
                sessions.push(read_session_path(entry.path())?);
            }
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.ended_at));
    Ok(sessions)
}

pub fn read_session(
    paths: &AsaPaths,
    adapter: &str,
    native_id: &str,
) -> Result<SessionDocument, ProjectionError> {
    read_session_path(
        paths
            .sessions()
            .join(adapter)
            .join(format!("{native_id}.json.zst")),
    )
}

pub fn project_native_session(
    paths: &AsaPaths,
    native: &NormalizedSession,
) -> Result<SessionDocument, ProjectionError> {
    let (adapter, native_id) = native
        .id
        .split_once(':')
        .unwrap_or((&native.adapter, native.id.as_str()));
    let existing = read_session(paths, adapter, native_id).ok();
    let source = if adapter == "claude-code" {
        SessionSource::ClaudeCode
    } else {
        SessionSource::Codex
    };
    let started_at = parse_timestamp(native.started_at.as_deref());
    let ended_at = parse_timestamp(native.ended_at.as_deref());
    let mut turns = native_turns(native);
    if let Some(existing) = existing.as_ref() {
        for observed_turn in &existing.turns {
            if !turns.iter().any(|turn| turn.id == observed_turn.id) {
                turns.push(observed_turn.clone());
            }
        }
    }
    let mut metadata = native_metadata(native);
    if let Some(version) = native.cli_version.as_ref() {
        metadata.insert("agent.version".to_owned(), serde_json::json!(version));
    }
    let workspaces = native.cwd.as_ref().map_or_else(Vec::new, |path| {
        vec![WorkspaceAttribution {
            path: path.clone(),
            first_observed_at: started_at.unwrap_or(OffsetDateTime::UNIX_EPOCH),
            last_observed_at: ended_at
                .or(started_at)
                .unwrap_or(OffsetDateTime::UNIX_EPOCH),
        }]
    });
    let mut session = SessionDocument {
        schema_version: 1,
        id: SessionId::namespaced(adapter, native_id),
        source,
        surface: Some(Surface::Unknown),
        lineage: SessionLineage {
            forked_from_session_id: native.forked_from_id.as_deref().map(|id| {
                let (source, native) = id.split_once(':').unwrap_or((adapter, id));
                SessionId::namespaced(source, native)
            }),
            ..SessionLineage::default()
        },
        workspaces,
        started_at,
        ended_at,
        usage: Usage {
            input_tokens: native.usage.input_tokens,
            output_tokens: native.usage.output_tokens,
            cache_read_input_tokens: native.usage.cache_read_tokens,
            cache_creation_input_tokens: native.usage.cache_creation_tokens,
        },
        turns,
        traces: existing
            .as_ref()
            .map_or_else(Vec::new, |session| session.traces.clone()),
        metadata,
        projection: existing.as_ref().map_or(
            ProjectionMetadata {
                observation_count: 0,
                last_observation_id: None,
                parser_version: 2,
            },
            |session| ProjectionMetadata {
                parser_version: 2,
                ..session.projection.clone()
            },
        ),
    };
    if let Some(existing) = existing {
        for workspace in existing.workspaces {
            if !session
                .workspaces
                .iter()
                .any(|current| current.path == workspace.path)
            {
                session.workspaces.push(workspace);
            }
        }
    }
    write_session(paths, &session)?;
    Ok(session)
}

fn native_turns(native: &NormalizedSession) -> Vec<Turn> {
    native
        .steps
        .iter()
        .map(|step| Turn {
            id: step.id.clone(),
            started_at: None,
            ended_at: None,
            completed: !step.aborted,
            tool_calls: u32::try_from(step.tool_calls.len()).unwrap_or(u32::MAX),
            assistant_output: None,
            metadata: BTreeMap::from([
                ("api_calls".to_owned(), serde_json::json!(step.api_calls)),
                (
                    "prompt_preview".to_owned(),
                    serde_json::json!(step.prompt_preview),
                ),
                ("usage".to_owned(), serde_json::json!(step.usage)),
                ("tool_calls".to_owned(), serde_json::json!(step.tool_calls)),
            ]),
        })
        .collect()
}

fn native_metadata(native: &NormalizedSession) -> BTreeMap<String, serde_json::Value> {
    BTreeMap::from([
        ("models".to_owned(), serde_json::json!(native.models)),
        (
            "native_transcript_path".to_owned(),
            serde_json::json!(native.file_path),
        ),
        (
            "native_malformed_lines".to_owned(),
            serde_json::json!(native.malformed_lines),
        ),
        (
            "native_compactions".to_owned(),
            serde_json::json!(native.compactions),
        ),
        (
            "native_interactions".to_owned(),
            serde_json::json!(native.interactions),
        ),
    ])
}

fn write_session(paths: &AsaPaths, session: &SessionDocument) -> Result<(), ProjectionError> {
    let (adapter, native_id) = session
        .id
        .to_string()
        .split_once(':')
        .map(|(adapter, native)| (adapter.to_owned(), native.to_owned()))
        .expect("namespaced session ID");
    let directory = paths.sessions().join(adapter);
    fs::create_dir_all(&directory)?;
    let final_path = directory.join(format!("{native_id}.json.zst"));
    let temporary = final_path.with_extension("tmp");
    let mut encoder = zstd::Encoder::new(fs::File::create(&temporary)?, 3)?;
    serde_json::to_writer(&mut encoder, session)?;
    encoder.flush()?;
    encoder.finish()?.sync_data()?;
    fs::rename(temporary, final_path)?;
    fs::File::open(&directory)?.sync_all()?;
    Ok(())
}

fn parse_timestamp(value: Option<&str>) -> Option<OffsetDateTime> {
    value.and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
}

fn read_session_path(path: PathBuf) -> Result<SessionDocument, ProjectionError> {
    let mut decoder = zstd::Decoder::new(fs::File::open(path)?)?;
    let mut bytes = Vec::new();
    decoder.read_to_end(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use asa_core::ObservationKind;
    use std::collections::BTreeMap;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;
    use time::{Duration, OffsetDateTime};

    fn observation(
        id: &str,
        kind: ObservationKind,
        seconds: i64,
        invocation_id: Option<&str>,
    ) -> Observation {
        Observation {
            schema_version: 1,
            id: id.to_owned(),
            adapter: "claude-code".to_owned(),
            native_event: match kind {
                ObservationKind::PromptSubmitted => "UserPromptSubmit",
                ObservationKind::ToolStarted => "PreToolUse",
                ObservationKind::ToolCompleted => "PostToolUse",
                ObservationKind::AgentStopped => "Stop",
                _ => "Other",
            }
            .to_owned(),
            kind,
            observed_at: OffsetDateTime::UNIX_EPOCH + Duration::seconds(seconds),
            session_id: "claude-code:session".to_owned(),
            turn_id: None,
            invocation_id: invocation_id.map(ToOwned::to_owned),
            attributes: BTreeMap::from([(
                "gen_ai.tool.name".to_owned(),
                AttributeValue::String("Bash".to_owned()),
            )]),
        }
    }

    #[test]
    fn correlates_claude_events_without_native_turn_ids() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let observations = vec![
            observation("prompt", ObservationKind::PromptSubmitted, 1, None),
            observation("start", ObservationKind::ToolStarted, 2, Some("tool-1")),
            observation(
                "completion",
                ObservationKind::ToolCompleted,
                3,
                Some("tool-1"),
            ),
            observation("stop", ObservationKind::AgentStopped, 4, None),
        ];
        let sessions = project_observations(&paths, &observations).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].turns.len(), 1);
        assert!(sessions[0].turns[0].completed);
        assert_eq!(sessions[0].turns[0].tool_calls, 1);
        assert_eq!(sessions[0].traces.len(), 1);
        assert_eq!(sessions[0].traces[0].spans.len(), 2);
        assert_eq!(sessions[0].traces[0].spans[0].status, SpanStatus::Ok);
        assert_eq!(sessions[0].traces[0].spans[1].status, SpanStatus::Ok);
    }

    #[test]
    fn completion_without_start_remains_partial() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let observations = vec![
            observation("prompt", ObservationKind::PromptSubmitted, 1, None),
            observation(
                "completion",
                ObservationKind::ToolCompleted,
                2,
                Some("tool-1"),
            ),
            observation("stop", ObservationKind::AgentStopped, 3, None),
        ];
        let sessions = project_observations(&paths, &observations).unwrap();
        assert_eq!(
            sessions[0].traces[0].spans[1].status,
            SpanStatus::Incomplete
        );
    }

    #[test]
    fn correlates_subagent_as_child_invoke_agent_span() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let mut start = observation(
            "subagent-start",
            ObservationKind::SubagentStarted,
            2,
            Some("agent-1"),
        );
        start.attributes.insert(
            "gen_ai.agent.name".to_owned(),
            AttributeValue::String("researcher".to_owned()),
        );
        let completion = observation(
            "subagent-stop",
            ObservationKind::SubagentStopped,
            3,
            Some("agent-1"),
        );
        let sessions = project_observations(
            &paths,
            &[
                observation("prompt", ObservationKind::PromptSubmitted, 1, None),
                start,
                completion,
                observation("stop", ObservationKind::AgentStopped, 4, None),
            ],
        )
        .unwrap();
        let spans = &sessions[0].traces[0].spans;
        let subagent = spans
            .iter()
            .find(|span| span.name == "invoke_agent researcher")
            .unwrap();
        assert_eq!(subagent.status, SpanStatus::Ok);
        assert_eq!(subagent.parent_span_id, Some(spans[0].span_id.clone()));
    }

    #[test]
    fn correlation_rebuild_after_restart_completes_partial_evidence_once() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let partial = vec![
            observation("prompt", ObservationKind::PromptSubmitted, 1, None),
            observation("start", ObservationKind::ToolStarted, 2, Some("tool-1")),
        ];
        let first = project_observations(&paths, &partial).unwrap();
        assert_eq!(first[0].traces[0].spans.len(), 2);
        assert_eq!(first[0].traces[0].spans[1].status, SpanStatus::Incomplete);

        let recovered = vec![
            partial[0].clone(),
            partial[1].clone(),
            observation(
                "completion",
                ObservationKind::ToolCompleted,
                3,
                Some("tool-1"),
            ),
            observation("stop", ObservationKind::AgentStopped, 4, None),
        ];
        let second = project_observations(&paths, &recovered).unwrap();
        assert_eq!(second[0].traces[0].spans.len(), 2);
        assert_eq!(second[0].traces[0].spans[1].status, SpanStatus::Ok);
        assert_eq!(second[0].projection.observation_count, 4);
    }

    #[test]
    fn interrupted_projection_temp_file_never_replaces_last_good_document() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let observations = vec![
            observation("prompt", ObservationKind::PromptSubmitted, 1, None),
            observation("stop", ObservationKind::AgentStopped, 2, None),
        ];
        project_observations(&paths, &observations).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "projection::tests::projection_crash_helper",
                "--nocapture",
            ])
            .env("ASA_PROJECTION_CRASH_ROOT", temp.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "helper must terminate abruptly");
        let final_path = paths
            .sessions()
            .join("claude-code")
            .join("session.json.zst");
        let temporary = final_path.with_extension("tmp");
        assert!(temporary.exists());

        let durable = read_session(&paths, "claude-code", "session").unwrap();
        assert_eq!(durable.projection.observation_count, 2);

        let rebuilt = project_observations(&paths, &observations).unwrap();
        assert_eq!(rebuilt[0].projection.observation_count, 2);
        assert!(!temporary.exists());
        assert_eq!(
            read_session(&paths, "claude-code", "session")
                .unwrap()
                .projection
                .observation_count,
            2
        );
    }

    #[test]
    fn projection_crash_helper() {
        let Some(root) = std::env::var_os("ASA_PROJECTION_CRASH_ROOT") else {
            return;
        };
        let paths = AsaPaths::discover(Some(std::path::Path::new(&root))).unwrap();
        let temporary = paths
            .sessions()
            .join("claude-code")
            .join("session.json.tmp");
        fs::write(temporary, b"truncated-zstd-frame").unwrap();
        std::process::abort();
    }
}
