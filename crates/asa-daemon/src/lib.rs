mod control;

use anyhow::{Context, Result};
use asa_adapters::{AdapterName, discover_sessions};
use asa_analysis::parse_session;
use asa_core::AsaPaths;
use asa_otel::observations_from_request;
use asa_store::{
    NativeCheckpoint, PARSER_VERSION, SegmentStore, drain_spool, is_session_deleted, list_sessions,
    load_checkpoints, project_native_session, project_observations, recover_observations,
    retained_observations, save_checkpoints, spawn_analytics,
};
use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsPartialSuccess, ExportLogsServiceRequest, ExportLogsServiceResponse,
    logs_service_server::{LogsService, LogsServiceServer},
};
use std::{net::SocketAddr, sync::Arc, thread::JoinHandle};
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status, metadata::MetadataValue, transport::Server};
use tracing::{info, warn};

pub const DEFAULT_ENDPOINT: &str = "127.0.0.1:4317";
pub const DEFAULT_CONTROL_ENDPOINT: &str = "127.0.0.1:4318";
pub const MAX_DECODED_REQUEST_BYTES: usize = 4 * 1024 * 1024;

pub async fn run(
    paths: AsaPaths,
    endpoint: SocketAddr,
    token: String,
    cancellation: CancellationToken,
) -> Result<()> {
    let store = SegmentStore::open(&paths).context("open durable segment")?;
    let drained = drain_spool(&paths, &store).context("drain hook spool")?;
    if drained > 0 {
        info!(drained, "drained pending hook observations");
    }
    rebuild_sessions(&paths).context("rebuild session projections")?;
    let (projection_tx, mut projection_rx) = mpsc::channel(1);
    let projection_paths = paths.clone();
    let projection_worker = tokio::spawn(async move {
        while projection_rx.recv().await.is_some() {
            let paths = projection_paths.clone();
            if let Err(error) = tokio::task::spawn_blocking(move || rebuild_observed(&paths))
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!(error)))
            {
                warn!(%error, "session projection failed; durable observations remain safe");
            }
        }
    });

    let (persistence, persistence_worker) =
        spawn_persistence_worker(store).context("start persistence worker")?;
    let service = IngestService {
        persistence,
        expected_authorization: format!("Bearer {token}"),
        projection_tx,
        ingestion_slots: Arc::new(Semaphore::new(64)),
    };
    let control_endpoint = control_endpoint(endpoint)?;
    let control_cancellation = cancellation.clone();
    let control_paths = paths.clone();
    let control_token = token.clone();
    let control_task = tokio::spawn(async move {
        control::serve(
            control_paths,
            control_endpoint,
            control_token,
            control_cancellation,
        )
        .await
    });
    info!(%endpoint, "ASA OTLP receiver listening");
    let result = Server::builder()
        .concurrency_limit_per_connection(32)
        .add_service(
            LogsServiceServer::new(service)
                .max_decoding_message_size(MAX_DECODED_REQUEST_BYTES)
                .max_encoding_message_size(256 * 1024),
        )
        .serve_with_shutdown(endpoint, cancellation.clone().cancelled_owned())
        .await
        .context("serve OTLP receiver");
    cancellation.cancel();
    match control_task.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(%error, "control API stopped with an error"),
        Err(error) => warn!(%error, "control API task did not shut down cleanly"),
    }
    // The service owns the final sender. Once the server has stopped and
    // dropped it, drain any accepted projection notification before exit.
    if let Err(error) = projection_worker.await {
        warn!(%error, "projection worker did not shut down cleanly");
    }
    match tokio::task::spawn_blocking(move || persistence_worker.join()).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => warn!("persistence worker panicked"),
        Err(error) => warn!(%error, "persistence worker join failed"),
    }
    result
}

fn control_endpoint(otlp: SocketAddr) -> Result<SocketAddr> {
    let mut control = otlp;
    control.set_port(
        otlp.port()
            .checked_add(1)
            .context("OTLP endpoint port has no adjacent control port")?,
    );
    Ok(control)
}

pub fn rebuild_sessions(paths: &AsaPaths) -> Result<usize> {
    let observations = retained_observations(paths, recover_observations(paths)?);
    let mut ids = project_observations(paths, &observations)?
        .into_iter()
        .map(|session| session.id.to_string())
        .collect::<std::collections::BTreeSet<_>>();
    let previous_checkpoints = load_checkpoints(paths)?;
    let mut checkpoints = std::collections::BTreeMap::new();
    for adapter in [AdapterName::ClaudeCode, AdapterName::Codex] {
        for reference in discover_sessions(adapter)? {
            if is_session_deleted(paths, &reference.id) {
                continue;
            }
            // Validate the checkpoint even though the current parser chooses a
            // complete reparse. Incremental append parsing remains deliberately
            // disabled until document-level hook/native merging is proven safe.
            let _unchanged = previous_checkpoints
                .get(&reference.id)
                .is_some_and(|checkpoint| {
                    checkpoint.matches(
                        &reference.id,
                        &reference.path,
                        reference.size_bytes,
                        reference.updated_at_unix_ms,
                    )
                });
            match parse_session(&reference)
                .context("parse native transcript")
                .and_then(|session| {
                    project_native_session(paths, &session).context("project native transcript")
                }) {
                Ok(session) => {
                    ids.insert(session.id.to_string());
                    checkpoints.insert(
                        reference.id.clone(),
                        NativeCheckpoint {
                            session_id: reference.id.clone(),
                            path: reference.path.to_string_lossy().into_owned(),
                            size_bytes: reference.size_bytes,
                            modified_unix_ms: reference.updated_at_unix_ms,
                            parser_version: PARSER_VERSION,
                        },
                    );
                }
                Err(error) => {
                    warn!(path = %reference.path.display(), %error, "native reconciliation skipped");
                }
            }
        }
    }
    save_checkpoints(paths, &checkpoints)?;
    let sessions = list_sessions(paths)?;
    let analytics = spawn_analytics(paths)?;
    analytics.rebuild(sessions)?;
    Ok(ids.len())
}

fn rebuild_observed(paths: &AsaPaths) -> Result<()> {
    let observations = retained_observations(paths, recover_observations(paths)?);
    project_observations(paths, &observations)?;
    let analytics = spawn_analytics(paths)?;
    analytics.rebuild(list_sessions(paths)?)?;
    Ok(())
}

struct IngestService {
    persistence: mpsc::Sender<PersistCommand>,
    expected_authorization: String,
    projection_tx: mpsc::Sender<()>,
    ingestion_slots: Arc<Semaphore>,
}

struct PersistCommand {
    observations: Vec<asa_core::Observation>,
    response: oneshot::Sender<Result<(), String>>,
}

fn spawn_persistence_worker(
    store: SegmentStore,
) -> std::io::Result<(mpsc::Sender<PersistCommand>, JoinHandle<()>)> {
    spawn_persistence_worker_with_delay(store, std::time::Duration::ZERO)
}

fn spawn_persistence_worker_with_delay(
    store: SegmentStore,
    delay: std::time::Duration,
) -> std::io::Result<(mpsc::Sender<PersistCommand>, JoinHandle<()>)> {
    let (sender, mut receiver) = mpsc::channel::<PersistCommand>(64);
    let worker = std::thread::Builder::new()
        .name("asa-segment-writer".to_owned())
        .spawn(move || {
            while let Some(command) = receiver.blocking_recv() {
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
                let result = command
                    .observations
                    .iter()
                    .try_for_each(|observation| store.append(observation).map(|_| ()))
                    .map_err(|error| error.to_string());
                let _ = command.response.send(result);
            }
        })?;
    Ok((sender, worker))
}

#[tonic::async_trait]
impl LogsService for IngestService {
    async fn export(
        &self,
        request: Request<ExportLogsServiceRequest>,
    ) -> Result<Response<ExportLogsServiceResponse>, Status> {
        authenticate(&request, &self.expected_authorization)?;
        let _permit = Arc::clone(&self.ingestion_slots)
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("ingestion concurrency limit reached"))?;
        let observations = observations_from_request(request.get_ref())
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        if observations.is_empty() {
            return Err(Status::invalid_argument(
                "request contains no ASA observation log records",
            ));
        }
        let (response, acknowledged) = oneshot::channel();
        self.persistence
            .try_send(PersistCommand {
                observations,
                response,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    Status::resource_exhausted("durable ingestion queue is full")
                }
                mpsc::error::TrySendError::Closed(_) => {
                    Status::unavailable("durable persistence worker is stopped")
                }
            })?;
        acknowledged
            .await
            .map_err(|_| Status::unavailable("durable persistence worker stopped before ack"))?
            .map_err(Status::internal)?;

        // Projection is rebuildable and intentionally outside the durable
        // acknowledgement boundary. A capacity-one worker coalesces bursts.
        let _ = self.projection_tx.try_send(());
        Ok(Response::new(ExportLogsServiceResponse {
            partial_success: Some(ExportLogsPartialSuccess {
                rejected_log_records: 0,
                error_message: String::new(),
            }),
        }))
    }
}

fn authenticate<T>(request: &Request<T>, expected: &str) -> Result<(), Status> {
    let authorization = request
        .metadata()
        .get("authorization")
        .ok_or_else(|| Status::unauthenticated("missing bearer token"))?;
    let expected = MetadataValue::try_from(expected)
        .map_err(|_| Status::internal("invalid configured bearer token"))?;
    if authorization != expected {
        return Err(Status::unauthenticated("invalid bearer token"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use asa_core::{Observation, ObservationKind};
    use asa_otel::export_request;
    use asa_store::recover_observations;
    use std::collections::BTreeMap;
    use tempfile::TempDir;
    use time::OffsetDateTime;

    fn observation(id: &str) -> Observation {
        Observation {
            schema_version: 1,
            id: id.to_owned(),
            adapter: "codex".to_owned(),
            native_event: "Stop".to_owned(),
            kind: ObservationKind::AgentStopped,
            observed_at: OffsetDateTime::UNIX_EPOCH,
            session_id: "codex:protocol-session".to_owned(),
            turn_id: Some("turn".to_owned()),
            invocation_id: None,
            attributes: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn authenticated_otlp_export_is_durable_and_duplicate_safe() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let (projection_tx, _projection_rx) = mpsc::channel(1);
        let (persistence, worker) =
            spawn_persistence_worker(SegmentStore::open(&paths).unwrap()).unwrap();
        let service = IngestService {
            persistence,
            expected_authorization: "Bearer test-token".to_owned(),
            projection_tx,
            ingestion_slots: Arc::new(Semaphore::new(2)),
        };
        let unauthorized = Request::new(export_request(&observation("protocol-observation")));
        assert_eq!(
            service.export(unauthorized).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        for _ in 0..2 {
            let mut authorized = Request::new(export_request(&observation("protocol-observation")));
            authorized.metadata_mut().insert(
                "authorization",
                MetadataValue::try_from("Bearer test-token").unwrap(),
            );
            service.export(authorized).await.unwrap();
        }
        assert_eq!(recover_observations(&paths).unwrap().len(), 1);
        drop(service);
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn saturated_ingestion_fails_fast_without_accepting_data() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let (projection_tx, _projection_rx) = mpsc::channel(1);
        let (persistence, worker) =
            spawn_persistence_worker(SegmentStore::open(&paths).unwrap()).unwrap();
        let service = IngestService {
            persistence,
            expected_authorization: "Bearer test-token".to_owned(),
            projection_tx,
            ingestion_slots: Arc::new(Semaphore::new(0)),
        };
        let mut request = Request::new(export_request(&observation("saturated")));
        request.metadata_mut().insert(
            "authorization",
            MetadataValue::try_from("Bearer test-token").unwrap(),
        );
        assert_eq!(
            service.export(request).await.unwrap_err().code(),
            tonic::Code::ResourceExhausted
        );
        assert!(recover_observations(&paths).unwrap().is_empty());
        drop(service);
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn full_durable_queue_fails_fast_without_accepting_request() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let (projection_tx, _projection_rx) = mpsc::channel(1);
        let (persistence, mut persistence_rx) = mpsc::channel(1);
        let (held_response, _held_acknowledgement) = oneshot::channel();
        persistence
            .try_send(PersistCommand {
                observations: vec![observation("already-queued")],
                response: held_response,
            })
            .unwrap();
        let service = IngestService {
            persistence,
            expected_authorization: "Bearer test-token".to_owned(),
            projection_tx,
            ingestion_slots: Arc::new(Semaphore::new(2)),
        };
        let mut request = Request::new(export_request(&observation("queue-full")));
        request.metadata_mut().insert(
            "authorization",
            MetadataValue::try_from("Bearer test-token").unwrap(),
        );
        assert_eq!(
            service.export(request).await.unwrap_err().code(),
            tonic::Code::ResourceExhausted
        );
        assert_eq!(
            persistence_rx.try_recv().unwrap().observations[0].id,
            "already-queued"
        );
        assert!(recover_observations(&paths).unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn many_simultaneous_exports_are_all_durable() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let (projection_tx, _projection_rx) = mpsc::channel(1);
        let (persistence, worker) =
            spawn_persistence_worker(SegmentStore::open(&paths).unwrap()).unwrap();
        let service = Arc::new(IngestService {
            persistence,
            expected_authorization: "Bearer test-token".to_owned(),
            projection_tx,
            ingestion_slots: Arc::new(Semaphore::new(64)),
        });
        let tasks = (0..32)
            .map(|index| {
                let service = Arc::clone(&service);
                tokio::spawn(async move {
                    let mut request =
                        Request::new(export_request(&observation(&format!("event-{index}"))));
                    request.metadata_mut().insert(
                        "authorization",
                        MetadataValue::try_from("Bearer test-token").unwrap(),
                    );
                    service.export(request).await.unwrap();
                })
            })
            .collect::<Vec<_>>();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(recover_observations(&paths).unwrap().len(), 32);
        drop(service);
        worker.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn sustained_slow_persistence_saturates_only_by_explicit_rejection() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let (projection_tx, _projection_rx) = mpsc::channel(1);
        let (persistence, worker) = spawn_persistence_worker_with_delay(
            SegmentStore::open(&paths).unwrap(),
            std::time::Duration::from_millis(5),
        )
        .unwrap();
        let service = Arc::new(IngestService {
            persistence,
            expected_authorization: "Bearer test-token".to_owned(),
            projection_tx,
            ingestion_slots: Arc::new(Semaphore::new(512)),
        });
        let tasks = (0..256)
            .map(|index| {
                let service = Arc::clone(&service);
                tokio::spawn(async move {
                    let mut request =
                        Request::new(export_request(&observation(&format!("stress-{index}"))));
                    request.metadata_mut().insert(
                        "authorization",
                        MetadataValue::try_from("Bearer test-token").unwrap(),
                    );
                    service.export(request).await.map(|_| ())
                })
            })
            .collect::<Vec<_>>();
        let mut accepted = 0;
        let mut rejected = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(()) => accepted += 1,
                Err(status) if status.code() == tonic::Code::ResourceExhausted => rejected += 1,
                Err(status) => panic!("unexpected status: {status}"),
            }
        }
        assert!(accepted > 0);
        assert!(rejected > 0);
        assert_eq!(accepted + rejected, 256);
        assert_eq!(recover_observations(&paths).unwrap().len(), accepted);
        drop(service);
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn persistence_worker_drains_accepted_queue_before_shutdown() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let (persistence, worker) =
            spawn_persistence_worker(SegmentStore::open(&paths).unwrap()).unwrap();
        let mut acknowledgements = Vec::new();
        for index in 0..64 {
            let (response, acknowledgement) = oneshot::channel();
            persistence
                .send(PersistCommand {
                    observations: vec![observation(&format!("shutdown-{index}"))],
                    response,
                })
                .await
                .unwrap();
            acknowledgements.push(acknowledgement);
        }
        drop(persistence);
        for acknowledgement in acknowledgements {
            acknowledgement.await.unwrap().unwrap();
        }
        worker.join().unwrap();
        assert_eq!(recover_observations(&paths).unwrap().len(), 64);
    }
}
