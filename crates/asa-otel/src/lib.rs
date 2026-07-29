use asa_core::{AgentTrace, Observation, SpanStatus};
use opentelemetry_proto::tonic::{
    collector::{logs::v1::ExportLogsServiceRequest, trace::v1::ExportTraceServiceRequest},
    common::v1::{AnyValue, KeyValue, any_value},
    logs::v1::{LogRecord, ResourceLogs, ScopeLogs},
    resource::v1::Resource,
    trace::v1::{
        ResourceSpans, ScopeSpans, Span, Status,
        span::{Event, SpanKind},
        status::StatusCode,
    },
};

const BODY_ENCODING: &str = "application/vnd.asa.observation+json;version=1";

#[must_use]
pub fn export_request(observation: &Observation) -> ExportLogsServiceRequest {
    let body = serde_json::to_string(observation).expect("Observation always serializes");
    let timestamp = u64::try_from(observation.observed_at.unix_timestamp_nanos()).unwrap_or(0);
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: vec![string_attribute("service.name", "asa-hook")],
                dropped_attributes_count: 0,
                entity_refs: Vec::new(),
            }),
            scope_logs: vec![ScopeLogs {
                scope: None,
                log_records: vec![LogRecord {
                    time_unix_nano: timestamp,
                    observed_time_unix_nano: timestamp,
                    severity_number: 9,
                    severity_text: "INFO".to_owned(),
                    body: Some(AnyValue {
                        value: Some(any_value::Value::StringValue(body)),
                    }),
                    attributes: vec![string_attribute("content.type", BODY_ENCODING)],
                    dropped_attributes_count: 0,
                    flags: 0,
                    trace_id: Vec::new(),
                    span_id: Vec::new(),
                    event_name: observation.native_event.clone(),
                }],
                schema_url: asa_semconv::SCHEMA_URL.to_owned(),
            }],
            schema_url: asa_semconv::SCHEMA_URL.to_owned(),
        }],
    }
}

pub fn observations_from_request(
    request: &ExportLogsServiceRequest,
) -> Result<Vec<Observation>, DecodeError> {
    let mut observations = Vec::new();
    for resource_logs in &request.resource_logs {
        for scope_logs in &resource_logs.scope_logs {
            for record in &scope_logs.log_records {
                let content_type = record
                    .attributes
                    .iter()
                    .find(|attribute| attribute.key == "content.type")
                    .and_then(|attribute| attribute.value.as_ref())
                    .and_then(|value| value.value.as_ref())
                    .and_then(|value| match value {
                        any_value::Value::StringValue(value) => Some(value.as_str()),
                        _ => None,
                    });
                if content_type != Some(BODY_ENCODING) {
                    continue;
                }
                let body = record
                    .body
                    .as_ref()
                    .and_then(|body| body.value.as_ref())
                    .and_then(|value| match value {
                        any_value::Value::StringValue(value) => Some(value.as_bytes()),
                        _ => None,
                    })
                    .ok_or(DecodeError::MissingBody)?;
                let observation: Observation = serde_json::from_slice(body)?;
                if observation.schema_version != 1 {
                    return Err(DecodeError::UnsupportedVersion(observation.schema_version));
                }
                observations.push(observation);
            }
        }
    }
    Ok(observations)
}

/// Assemble a completed or partial ASA turn projection into standard OTLP
/// trace protobuf. External export is optional and deliberately outside the
/// durable hook acknowledgement boundary.
#[must_use]
pub fn trace_export_request(trace: &AgentTrace) -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: vec![string_attribute("service.name", "asa")],
                dropped_attributes_count: 0,
                entity_refs: Vec::new(),
            }),
            scope_spans: vec![ScopeSpans {
                scope: None,
                spans: trace
                    .spans
                    .iter()
                    .map(|span| Span {
                        trace_id: hex::decode(&span.trace_id).unwrap_or_default(),
                        span_id: hex::decode(&span.span_id).unwrap_or_default(),
                        trace_state: String::new(),
                        parent_span_id: span
                            .parent_span_id
                            .as_deref()
                            .and_then(|id| hex::decode(id).ok())
                            .unwrap_or_default(),
                        flags: 0,
                        name: span.name.clone(),
                        kind: SpanKind::Internal.into(),
                        start_time_unix_nano: unix_nanos(span.started_at),
                        end_time_unix_nano: unix_nanos(span.ended_at),
                        attributes: span
                            .attributes
                            .iter()
                            .map(|(key, value)| KeyValue {
                                key: key.clone(),
                                value: Some(json_value(value)),
                            })
                            .collect(),
                        dropped_attributes_count: 0,
                        events: Vec::<Event>::new(),
                        dropped_events_count: 0,
                        links: Vec::new(),
                        dropped_links_count: 0,
                        status: Some(Status {
                            message: String::new(),
                            code: match span.status {
                                SpanStatus::Ok => StatusCode::Ok.into(),
                                SpanStatus::Error => StatusCode::Error.into(),
                                SpanStatus::Incomplete => StatusCode::Unset.into(),
                            },
                        }),
                    })
                    .collect(),
                schema_url: asa_semconv::SCHEMA_URL.to_owned(),
            }],
            schema_url: asa_semconv::SCHEMA_URL.to_owned(),
        }],
    }
}

fn unix_nanos(value: Option<time::OffsetDateTime>) -> u64 {
    value
        .and_then(|value| u64::try_from(value.unix_timestamp_nanos()).ok())
        .unwrap_or(0)
}

fn json_value(value: &serde_json::Value) -> AnyValue {
    let value = match value {
        serde_json::Value::Bool(value) => any_value::Value::BoolValue(*value),
        serde_json::Value::Number(value) if value.is_i64() => {
            any_value::Value::IntValue(value.as_i64().unwrap_or_default())
        }
        serde_json::Value::Number(value) => {
            any_value::Value::DoubleValue(value.as_f64().unwrap_or_default())
        }
        serde_json::Value::String(value) => any_value::Value::StringValue(value.clone()),
        value => any_value::Value::StringValue(value.to_string()),
    };
    AnyValue { value: Some(value) }
}

fn string_attribute(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.to_owned(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.to_owned())),
        }),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("ASA observation log is missing a string body")]
    MissingBody,
    #[error("ASA observation body is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported ASA observation schema version {0}")]
    UnsupportedVersion(u32),
}

#[cfg(test)]
mod tests {
    use super::*;
    use asa_core::{AgentTrace, ObservationKind, SessionId, SpanDocument, SpanStatus};
    use std::collections::BTreeMap;
    use time::OffsetDateTime;

    fn observation() -> Observation {
        Observation {
            schema_version: 1,
            id: "one".to_owned(),
            adapter: "codex".to_owned(),
            native_event: "Stop".to_owned(),
            kind: ObservationKind::AgentStopped,
            observed_at: OffsetDateTime::UNIX_EPOCH,
            session_id: "codex:one".to_owned(),
            turn_id: Some("turn".to_owned()),
            invocation_id: None,
            attributes: BTreeMap::new(),
        }
    }

    #[test]
    fn round_trips_the_versioned_observation_and_pinned_schema() {
        let observation = observation();
        let request = export_request(&observation);
        assert_eq!(
            request.resource_logs[0].scope_logs[0].schema_url,
            asa_semconv::SCHEMA_URL
        );
        assert_eq!(
            observations_from_request(&request).unwrap(),
            vec![observation]
        );
    }

    #[test]
    fn rejects_incompatible_observation_versions() {
        let mut observation = observation();
        observation.schema_version = 2;
        let error = observations_from_request(&export_request(&observation)).unwrap_err();
        assert!(matches!(error, DecodeError::UnsupportedVersion(2)));
    }

    #[test]
    fn assembles_standard_otlp_trace_with_partial_status_preserved() {
        let trace = AgentTrace {
            trace_id: "00112233445566778899aabbccddeeff".to_owned(),
            conversation_id: SessionId::namespaced("codex", "one"),
            turn_id: "turn".to_owned(),
            spans: vec![SpanDocument {
                trace_id: "00112233445566778899aabbccddeeff".to_owned(),
                span_id: "0011223344556677".to_owned(),
                parent_span_id: None,
                operation_name: "invoke_agent".to_owned(),
                name: "invoke_agent".to_owned(),
                started_at: Some(OffsetDateTime::UNIX_EPOCH),
                ended_at: None,
                status: SpanStatus::Incomplete,
                attributes: BTreeMap::from([(
                    "gen_ai.conversation.id".to_owned(),
                    serde_json::json!("codex:one"),
                )]),
            }],
        };
        let request = trace_export_request(&trace);
        let resource = &request.resource_spans[0];
        assert_eq!(resource.schema_url, asa_semconv::SCHEMA_URL);
        let span = &resource.scope_spans[0].spans[0];
        assert_eq!(span.trace_id.len(), 16);
        assert_eq!(span.span_id.len(), 8);
        assert_eq!(span.status.as_ref().unwrap().code, StatusCode::Unset as i32);
        assert_eq!(span.end_time_unix_nano, 0);
    }
}
