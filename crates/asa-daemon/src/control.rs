use asa_adapters::{AdapterName, capabilities, discover_sessions};
use asa_analysis::{analyze, compare, parse_session};
use asa_core::AsaPaths;
use asa_store::{list_sessions, read_session, recover_observations, spawn_analytics};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc, time::Instant};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct ControlState {
    paths: AsaPaths,
    token: Arc<str>,
    started: Instant,
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

pub async fn serve(
    paths: AsaPaths,
    endpoint: SocketAddr,
    token: String,
    cancellation: CancellationToken,
) -> anyhow::Result<()> {
    let state = ControlState {
        paths,
        token: Arc::from(token),
        started: Instant::now(),
    };
    let auth = state.clone();
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/rpc", post(rpc))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn_with_state(auth, authenticate))
        .with_state(state);
    let listener = TcpListener::bind(endpoint).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(cancellation.cancelled_owned())
        .await?;
    Ok(())
}

async fn authenticate(
    State(state): State<ControlState>,
    headers: HeaderMap,
    request: Request<Body>,
    next: Next,
) -> Response {
    let expected = format!("Bearer {}", state.token);
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(expected.as_str())
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid bearer token"})),
        )
            .into_response();
    }
    next.run(request).await
}

async fn health(State(state): State<ControlState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "uptime_ms": state.started.elapsed().as_millis(),
        "schema_version": 1,
    }))
}

async fn rpc(State(state): State<ControlState>, Json(request): Json<RpcRequest>) -> Response {
    let paths = state.paths;
    match tokio::task::spawn_blocking(move || dispatch(&paths, &request)).await {
        Ok(Ok(value)) => (StatusCode::OK, Json(json!({"result": value}))).into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

fn dispatch(paths: &AsaPaths, request: &RpcRequest) -> anyhow::Result<Value> {
    match request.method.as_str() {
        "adapter.list" => Ok(json!(["claude-code", "codex"])),
        "adapter.capabilities" => {
            let adapter = adapter_param(&request.params)?;
            Ok(serde_json::to_value(capabilities(adapter))?)
        }
        "session.list" => Ok(serde_json::to_value(list_sessions(paths)?)?),
        "session.get" => {
            let id = string_param(&request.params, "id")?;
            let (adapter, native) = id
                .split_once(':')
                .ok_or_else(|| anyhow::anyhow!("session id must be namespaced"))?;
            Ok(serde_json::to_value(read_session(paths, adapter, native)?)?)
        }
        "session.events" => {
            let id = string_param(&request.params, "id")?;
            let events = recover_observations(paths)?
                .into_iter()
                .filter(|observation| observation.session_id == id)
                .collect::<Vec<_>>();
            Ok(serde_json::to_value(events)?)
        }
        "analysis.session" => {
            let id = string_param(&request.params, "id")?;
            Ok(serde_json::to_value(analyze(parse_session(
                &resolve_native(&id)?,
            )?))?)
        }
        "analysis.compare" => {
            let a = analyze(parse_session(&resolve_native(&string_param(
                &request.params,
                "a",
            )?)?)?);
            let b = analyze(parse_session(&resolve_native(&string_param(
                &request.params,
                "b",
            )?)?)?);
            Ok(serde_json::to_value(compare(&a, &b))?)
        }
        "daemon.health" => Ok(json!({"status": "ok"})),
        "daemon.stats" => {
            let stats = spawn_analytics(paths)?.stats()?;
            Ok(json!({
                "sessions": stats.sessions,
                "turns": stats.turns,
                "tool_calls": stats.tool_calls,
                "input_tokens": stats.input_tokens,
                "output_tokens": stats.output_tokens,
            }))
        }
        "storage.rebuild" => {
            let stats = spawn_analytics(paths)?.rebuild(list_sessions(paths)?)?;
            Ok(json!({
                "sessions": stats.sessions,
                "turns": stats.turns,
                "tool_calls": stats.tool_calls,
                "input_tokens": stats.input_tokens,
                "output_tokens": stats.output_tokens,
            }))
        }
        method => anyhow::bail!("unknown control method {method:?}"),
    }
}

fn adapter_param(params: &Value) -> anyhow::Result<AdapterName> {
    string_param(params, "adapter")?.parse().map_err(Into::into)
}

fn string_param(params: &Value, name: &str) -> anyhow::Result<String> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("missing string parameter {name:?}"))
}

fn resolve_native(id_or_prefix: &str) -> anyhow::Result<asa_adapters::NativeSessionReference> {
    let sessions = [AdapterName::ClaudeCode, AdapterName::Codex]
        .into_iter()
        .map(discover_sessions)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if let Some(exact) = sessions.iter().find(|session| session.id == id_or_prefix) {
        return Ok(exact.clone());
    }
    let matches = sessions
        .into_iter()
        .filter(|session| {
            session.id.starts_with(id_or_prefix)
                || session
                    .id
                    .split_once(':')
                    .is_some_and(|(_, native)| native.starts_with(id_or_prefix))
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [session] => Ok(session.clone()),
        [] => anyhow::bail!("no native session matches {id_or_prefix:?}"),
        _ => anyhow::bail!("ambiguous native session prefix {id_or_prefix:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn dispatch_exposes_adapters_and_rejects_unknown_methods() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let adapters = dispatch(
            &paths,
            &RpcRequest {
                method: "adapter.list".to_owned(),
                params: Value::Null,
            },
        )
        .unwrap();
        assert_eq!(adapters, json!(["claude-code", "codex"]));
        assert!(
            dispatch(
                &paths,
                &RpcRequest {
                    method: "arbitrary.sql".to_owned(),
                    params: Value::Null,
                },
            )
            .is_err()
        );
    }
}
