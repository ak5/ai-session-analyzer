use asa_core::{AsaPaths, SessionDocument};
use duckdb::{Connection, params};
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::mpsc::{self, Receiver, Sender},
    thread::{self, JoinHandle},
};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalyticsStats {
    pub sessions: u64,
    pub turns: u64,
    pub tool_calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

enum Command {
    Rebuild {
        sessions: Vec<SessionDocument>,
        response: Sender<Result<AnalyticsStats, AnalyticsError>>,
    },
    Stats {
        response: Sender<Result<AnalyticsStats, AnalyticsError>>,
    },
    Shutdown,
}

pub struct AnalyticsHandle {
    commands: Sender<Command>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Debug, Error)]
pub enum AnalyticsError {
    #[error("DuckDB error: {0}")]
    DuckDb(#[from] duckdb::Error),
    #[error("DuckDB could not be opened: {0}")]
    Unavailable(String),
    #[error("analytics owner thread stopped unexpectedly")]
    Disconnected,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn spawn_analytics(paths: &AsaPaths) -> Result<AnalyticsHandle, AnalyticsError> {
    fs::create_dir_all(paths.root())?;
    let database = paths.analytics_database();
    let (commands, receiver) = mpsc::channel();
    let thread = thread::Builder::new()
        .name("asa-duckdb-owner".to_owned())
        .spawn(move || owner_loop(&database, receiver))?;
    Ok(AnalyticsHandle {
        commands,
        thread: Some(thread),
    })
}

impl AnalyticsHandle {
    pub fn rebuild(
        &self,
        sessions: Vec<SessionDocument>,
    ) -> Result<AnalyticsStats, AnalyticsError> {
        let (response, result) = mpsc::channel();
        self.commands
            .send(Command::Rebuild { sessions, response })
            .map_err(|_| AnalyticsError::Disconnected)?;
        result.recv().map_err(|_| AnalyticsError::Disconnected)?
    }

    pub fn stats(&self) -> Result<AnalyticsStats, AnalyticsError> {
        let (response, result) = mpsc::channel();
        self.commands
            .send(Command::Stats { response })
            .map_err(|_| AnalyticsError::Disconnected)?;
        result.recv().map_err(|_| AnalyticsError::Disconnected)?
    }
}

impl Drop for AnalyticsHandle {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn owner_loop(path: &std::path::Path, receiver: Receiver<Command>) {
    let connection = Connection::open(path);
    for command in receiver {
        match command {
            Command::Rebuild { sessions, response } => {
                let result = connection
                    .as_ref()
                    .map_err(|error| AnalyticsError::Unavailable(error.to_string()))
                    .and_then(|connection| rebuild(connection, &sessions));
                let _ = response.send(result);
            }
            Command::Stats { response } => {
                let result = connection
                    .as_ref()
                    .map_err(|error| AnalyticsError::Unavailable(error.to_string()))
                    .and_then(stats);
                let _ = response.send(result);
            }
            Command::Shutdown => break,
        }
    }
}

fn initialize(connection: &Connection) -> Result<(), AnalyticsError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS session_summary (
          session_id VARCHAR PRIMARY KEY,
          adapter VARCHAR NOT NULL,
          started_at VARCHAR,
          ended_at VARCHAR,
          turns UBIGINT NOT NULL,
          tool_calls UBIGINT NOT NULL,
          input_tokens UBIGINT NOT NULL,
          output_tokens UBIGINT NOT NULL,
          observation_count UBIGINT NOT NULL,
          document_json VARCHAR NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projection_metadata (
          key VARCHAR PRIMARY KEY,
          value VARCHAR NOT NULL
        );
        ",
    )?;
    Ok(())
}

fn rebuild(
    connection: &Connection,
    sessions: &[SessionDocument],
) -> Result<AnalyticsStats, AnalyticsError> {
    rebuild_with_failure(connection, sessions, None)
}

fn rebuild_with_failure(
    connection: &Connection,
    sessions: &[SessionDocument],
    fail_after_inserts: Option<usize>,
) -> Result<AnalyticsStats, AnalyticsError> {
    initialize(connection)?;
    connection.execute("BEGIN TRANSACTION", [])?;
    let result = (|| {
        connection.execute("DELETE FROM session_summary", [])?;
        if fail_after_inserts == Some(0) {
            return Err(AnalyticsError::Unavailable(
                "injected rebuild interruption".to_owned(),
            ));
        }
        let mut statement = connection
            .prepare("INSERT INTO session_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")?;
        for (index, session) in sessions.iter().enumerate() {
            let tool_calls = session
                .turns
                .iter()
                .map(|turn| u64::from(turn.tool_calls))
                .sum::<u64>();
            statement.execute(params![
                session.id.to_string(),
                match session.source {
                    asa_core::SessionSource::ClaudeCode => "claude-code",
                    asa_core::SessionSource::Codex => "codex",
                },
                session.started_at.map(|value| value.to_string()),
                session.ended_at.map(|value| value.to_string()),
                u64::try_from(session.turns.len()).unwrap_or(u64::MAX),
                tool_calls,
                session.usage.input_tokens,
                session.usage.output_tokens,
                session.projection.observation_count,
                serde_json::to_string(session).expect("session document serializes"),
            ])?;
            if fail_after_inserts == Some(index + 1) {
                return Err(AnalyticsError::Unavailable(
                    "injected rebuild interruption".to_owned(),
                ));
            }
        }
        drop(statement);
        connection.execute("DELETE FROM projection_metadata", [])?;
        connection.execute(
            "INSERT INTO projection_metadata VALUES ('session_watermark', ?)",
            [session_watermark(sessions)],
        )?;
        connection.execute(
            "INSERT INTO projection_metadata VALUES ('schema_version', '1')",
            [],
        )?;
        Ok::<(), AnalyticsError>(())
    })();
    match result {
        Ok(()) => {
            connection.execute("COMMIT", [])?;
            stats(connection)
        }
        Err(error) => {
            let _ = connection.execute("ROLLBACK", []);
            Err(error)
        }
    }
}

fn session_watermark(sessions: &[SessionDocument]) -> String {
    let mut identities = sessions
        .iter()
        .map(|session| {
            format!(
                "{}\0{}\0{}",
                session.id,
                session.projection.observation_count,
                session
                    .projection
                    .last_observation_id
                    .as_deref()
                    .unwrap_or("")
            )
        })
        .collect::<Vec<_>>();
    identities.sort();
    let mut digest = Sha256::new();
    for identity in identities {
        digest.update(identity);
        digest.update([0]);
    }
    hex::encode(digest.finalize())
}

fn stats(connection: &Connection) -> Result<AnalyticsStats, AnalyticsError> {
    initialize(connection)?;
    connection
        .query_row(
            "SELECT count(*), coalesce(sum(turns), 0), coalesce(sum(tool_calls), 0),
                    coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
             FROM session_summary",
            [],
            |row| {
                Ok(AnalyticsStats {
                    sessions: row.get(0)?,
                    turns: row.get(1)?,
                    tool_calls: row.get(2)?,
                    input_tokens: row.get(3)?,
                    output_tokens: row.get(4)?,
                })
            },
        )
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_native_session;
    use asa_adapters::NativeSessionReference;
    use asa_analysis::parse_session;
    use asa_core::SessionId;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    #[test]
    fn deleting_and_rebuilding_database_restores_equivalent_stats() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let reference = NativeSessionReference {
            id: "codex:22222222-2222-2222-2222-222222222222".to_owned(),
            adapter: "codex".to_owned(),
            path: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/v2/transcripts/codex-session.jsonl"),
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        };
        let document = project_native_session(&paths, &parse_session(&reference).unwrap()).unwrap();
        let first = {
            let analytics = spawn_analytics(&paths).unwrap();
            analytics.rebuild(vec![document.clone()]).unwrap()
        };
        fs::remove_file(paths.analytics_database()).unwrap();
        let second = {
            let analytics = spawn_analytics(&paths).unwrap();
            analytics.rebuild(vec![document]).unwrap()
        };
        assert_eq!(first, second);
        assert_eq!(first.sessions, 1);
        assert_eq!(first.turns, 1);
        assert_eq!(first.tool_calls, 1);
        assert_eq!(first.input_tokens, 200);
        let connection = Connection::open(paths.analytics_database()).unwrap();
        let watermark: String = connection
            .query_row(
                "SELECT value FROM projection_metadata WHERE key = 'session_watermark'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(watermark.len(), 64);
    }

    #[test]
    fn interrupted_duckdb_rebuild_rolls_back_to_previous_watermark() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let reference = NativeSessionReference {
            id: "codex:22222222-2222-2222-2222-222222222222".to_owned(),
            adapter: "codex".to_owned(),
            path: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/v2/transcripts/codex-session.jsonl"),
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        };
        let original = project_native_session(&paths, &parse_session(&reference).unwrap()).unwrap();
        let mut replacement = original.clone();
        replacement.id = SessionId::namespaced("codex", "replacement");
        let connection = Connection::open(paths.analytics_database()).unwrap();
        let committed = rebuild(&connection, std::slice::from_ref(&original)).unwrap();
        let watermark_before: String = connection
            .query_row(
                "SELECT value FROM projection_metadata WHERE key = 'session_watermark'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert!(
            rebuild_with_failure(&connection, &[replacement], Some(1)).is_err(),
            "the injected interruption must abort the transaction"
        );
        assert_eq!(stats(&connection).unwrap(), committed);
        let watermark_after: String = connection
            .query_row(
                "SELECT value FROM projection_metadata WHERE key = 'session_watermark'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(watermark_after, watermark_before);
    }

    #[test]
    fn process_crash_during_duckdb_transaction_preserves_committed_projection() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let reference = NativeSessionReference {
            id: "codex:22222222-2222-2222-2222-222222222222".to_owned(),
            adapter: "codex".to_owned(),
            path: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/v2/transcripts/codex-session.jsonl"),
            title: None,
            updated_at_unix_ms: None,
            size_bytes: 0,
        };
        let document = project_native_session(&paths, &parse_session(&reference).unwrap()).unwrap();
        let committed = {
            let analytics = spawn_analytics(&paths).unwrap();
            analytics.rebuild(vec![document]).unwrap()
        };
        let connection = Connection::open(paths.analytics_database()).unwrap();
        let watermark_before: String = connection
            .query_row(
                "SELECT value FROM projection_metadata WHERE key = 'session_watermark'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);

        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "analytics::tests::duckdb_transaction_crash_helper",
                "--nocapture",
            ])
            .env("ASA_DUCKDB_CRASH_ROOT", temp.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "helper must terminate abruptly");

        let connection = Connection::open(paths.analytics_database()).unwrap();
        assert_eq!(stats(&connection).unwrap(), committed);
        let watermark_after: String = connection
            .query_row(
                "SELECT value FROM projection_metadata WHERE key = 'session_watermark'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(watermark_after, watermark_before);
    }

    #[test]
    fn duckdb_transaction_crash_helper() {
        let Some(root) = std::env::var_os("ASA_DUCKDB_CRASH_ROOT") else {
            return;
        };
        let paths = AsaPaths::discover(Some(std::path::Path::new(&root))).unwrap();
        let connection = Connection::open(paths.analytics_database()).unwrap();
        connection.execute("BEGIN TRANSACTION", []).unwrap();
        connection
            .execute("DELETE FROM session_summary", [])
            .unwrap();
        connection
            .execute(
                "UPDATE projection_metadata SET value = 'interrupted' WHERE key = 'session_watermark'",
                [],
            )
            .unwrap();
        std::process::abort();
    }
}
