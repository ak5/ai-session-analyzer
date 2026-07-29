mod hooks;
mod supervisor;

use anyhow::{Context, Result, bail};
use asa_adapters::{
    AdapterName, ContextForkOptions, MigrationConfig, NativeSessionReference, capabilities,
    craft_context_fork, discover_sessions, fork_native_session_at_step, migrate_workspace_path,
    native_hook_to_observation, native_hook_to_observation_with_policy, neutral_hook_response,
};
use asa_analysis::{
    AnalysisReport, InstructionChange, analyze, analyze_prompter, build_efficacy_report,
    build_intent_report, build_model_report, build_project_report, compare, distill_sessions,
    parse_session, render_distill, render_efficacy, render_intents, render_models, render_project,
    render_prompter,
};
use asa_core::{AsaPaths, AttributeValue, Observation, ObservationKind, PrivacyConfig};
use asa_daemon::DEFAULT_ENDPOINT;
use asa_otel::export_request;
use asa_store::{
    delete_session, is_session_deleted, list_sessions, read_session, spawn_analytics,
    spool_observation,
};
use clap::{Args, Parser, Subcommand};
use opentelemetry_proto::tonic::collector::logs::v1::logs_service_client::LogsServiceClient;
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use time::Duration as TimeDuration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use tonic::{
    Request,
    metadata::MetadataValue,
    transport::{Channel, Endpoint},
};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use hooks::HookScope;

const HOOK_MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const HOOK_ACK_BUDGET: Duration = Duration::from_millis(200);

#[derive(Parser)]
#[command(name = "asa", version, about = "Passive local agent observability")]
struct Cli {
    /// Override ASA's platform data root (tests and isolated development only).
    #[arg(long, global = true, env = "ASA_ROOT")]
    root: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Adapters {
        #[command(subcommand)]
        command: AdapterCommand,
    },
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
    Hook {
        #[command(subcommand)]
        command: HookCommand,
    },
    Sessions {
        #[command(subcommand)]
        command: SessionCommand,
    },
    Hooks {
        #[command(subcommand)]
        command: HooksCommand,
    },
    /// Analyze one native Claude Code or Codex transcript.
    Analyze {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Compare two native transcript analyses.
    Compare {
        a: String,
        b: String,
        #[arg(long)]
        json: bool,
    },
    /// Mine recurring prompts and tool sequences across native sessions.
    Distill {
        /// Sessions to include: all, claude, claude-code, or codex.
        #[arg(long, default_value = "all")]
        agent: String,
        /// Maximum newest sessions to analyze.
        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,
        /// Only sessions updated since Nd or YYYY-MM-DD.
        #[arg(long)]
        since: Option<String>,
        /// Emit the deterministic report as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Analyze local prompting patterns, leverage, archetype, and lint findings.
    Prompter {
        /// Sessions to include: all, claude, claude-code, or codex.
        #[arg(long, default_value = "all")]
        agent: String,
        /// Maximum newest sessions to analyze.
        #[arg(short = 'n', long, default_value_t = 25)]
        limit: usize,
        /// Only sessions updated since Nd or YYYY-MM-DD.
        #[arg(long)]
        since: Option<String>,
        /// Emit the deterministic report as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Summarize all discovered sessions belonging to one repository.
    Project {
        path: Option<PathBuf>,
        #[arg(short = 'n', long, default_value_t = 200)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// Classify the opening intent of each selected session.
    Intents {
        #[arg(long, default_value = "all")]
        agent: String,
        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,
        #[arg(long)]
        since: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Report model usage, favorites, and weekly switches.
    Models {
        #[arg(long, default_value = "all")]
        agent: String,
        #[arg(short = 'n', long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        since: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Compare steering metrics before and after instruction-file commits.
    Efficacy {
        path: Option<PathBuf>,
        #[arg(short = 'n', long, default_value_t = 200)]
        limit: usize,
        #[arg(long, default_value_t = 10)]
        window: usize,
        #[arg(long)]
        json: bool,
    },
    /// Resume a native session in its recorded working directory.
    Resume {
        id: String,
        /// Run headlessly with this prompt instead of opening the interactive CLI.
        #[arg(short, long)]
        prompt: Option<String>,
        /// Print the native command and working directory without launching it.
        #[arg(long)]
        dry_run: bool,
    },
    /// Fork a native session, leaving the original untouched.
    Fork(ForkArgs),
    Privacy {
        #[command(subcommand)]
        command: PrivacyCommand,
    },
    Storage {
        #[command(subcommand)]
        command: StorageCommand,
    },
}

#[derive(Args)]
struct ForkArgs {
    id: String,
    /// Fork after this step or turn ID by creating a disposable transcript copy.
    #[arg(long, conflicts_with = "context")]
    at: Option<String>,
    /// Craft a deterministic compact context plus a verbatim recent tail.
    #[arg(long, conflicts_with = "at")]
    context: bool,
    /// Number of recent steps retained verbatim by --context.
    #[arg(long, default_value_t = 2)]
    keep: usize,
    /// Focus hint used to weight matching conclusions in --context.
    #[arg(long, requires = "context")]
    hint: Option<String>,
    /// Run the fork headlessly with this prompt instead of opening the interactive CLI.
    #[arg(short, long)]
    prompt: Option<String>,
    /// Create an --at or --context fork without launching the native agent.
    #[arg(long)]
    no_launch: bool,
    /// Print the native command and working directory without launching it.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Clone, Copy, Subcommand)]
enum AdapterCommand {
    /// List compiled adapters and accurately qualified surfaces.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show observation and native-store capabilities.
    Capabilities {
        adapter: AdapterName,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum DaemonCommand {
    /// Run the OTLP receiver in the foreground.
    Run(EndpointArgs),
    /// Test whether the local receiver port accepts connections.
    Status(EndpointArgs),
    /// Rebuild all session projections from durable observations.
    Rebuild,
    /// Install and start the native per-user OS service.
    Install(EndpointArgs),
    /// Remove only ASA's native per-user OS service.
    Uninstall,
    /// Start the installed native per-user OS service.
    Start,
    /// Stop the installed native per-user OS service.
    Stop,
    /// Restart the installed native per-user OS service.
    Restart,
    /// Inspect service definition and ASA runtime prerequisites.
    Doctor,
    /// Print recent native-supervisor logs.
    Logs {
        #[arg(long, default_value_t = 100)]
        lines: usize,
    },
}

#[derive(Subcommand)]
enum HookCommand {
    /// Internal native-hook fast path. Reads one JSON payload from stdin.
    #[command(hide = true)]
    Ingest {
        #[arg(long)]
        adapter: AdapterName,
        #[command(flatten)]
        endpoint: EndpointArgs,
    },
}

#[derive(Subcommand)]
enum SessionCommand {
    /// List reconstructed sessions from both native adapters.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show one reconstructed session document.
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete ASA-owned observations and projections, never native transcripts.
    Delete {
        id: String,
        #[arg(long)]
        yes: bool,
    },
    /// Update native session metadata after a repository or parent directory moves.
    MigratePath {
        old: PathBuf,
        new: PathBuf,
        /// Show the complete preflight without changing native or ASA-owned files.
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum PrivacyCommand {
    /// Create an explicit metadata-first privacy configuration.
    Init,
    /// Inspect global configuration and effective adapter capture behavior.
    Show {
        #[arg(long)]
        adapter: Option<AdapterName>,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Apply configured retention to ASA-owned session data.
    EnforceRetention {
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Clone, Copy, Subcommand)]
enum StorageCommand {
    /// Rebuild `DuckDB` completely from session documents.
    Rebuild,
    /// Show aggregate analytical projection statistics.
    Stats,
}

#[derive(Subcommand)]
enum HooksCommand {
    /// Semantically merge ASA lifecycle observers into native hook settings.
    Install(HookSelection),
    /// Remove only ASA lifecycle observers from native hook settings.
    Uninstall(HookSelection),
    /// Report installation state without changing settings.
    Status(HookSelection),
    /// List ASA lifecycle observer installation state.
    List(HookSelection),
    /// Validate settings, configured events, and executable resolution.
    Doctor(HookSelection),
    /// Decode a representative event without sending or storing it.
    Test { adapter: AdapterName, event: String },
}

#[derive(Args)]
struct HookSelection {
    /// Adapter to manage. Omit with --all.
    adapter: Option<AdapterName>,
    #[arg(long, conflicts_with = "adapter")]
    all: bool,
    #[arg(long, default_value = "project")]
    scope: HookScope,
}

#[derive(Clone, Args)]
struct EndpointArgs {
    #[arg(long, default_value = DEFAULT_ENDPOINT, env = "ASA_ENDPOINT")]
    endpoint: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let paths = AsaPaths::discover(cli.root.as_deref())?;
    match cli.command {
        Command::Hook {
            command: HookCommand::Ingest { adapter, endpoint },
        } => {
            // Hook mode deliberately has no tracing subscriber or normal CLI
            // output. Agent correctness never depends on ASA health.
            run_hook(paths, adapter, &endpoint.endpoint).await;
            Ok(())
        }
        command => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| EnvFilter::new("asa=info")),
                )
                .init();
            run_human(paths, command).await
        }
    }
}

// Central dispatch intentionally keeps command-to-handler routing in one auditable match.
#[allow(clippy::too_many_lines)]
async fn run_human(paths: AsaPaths, command: Command) -> Result<()> {
    match command {
        Command::Adapters { command } => run_adapters(command),
        Command::Daemon {
            command: DaemonCommand::Run(endpoint),
        } => {
            let endpoint: SocketAddr = endpoint.endpoint.parse().context("invalid endpoint")?;
            let token = load_or_create_token(&paths)?;
            let cancellation = CancellationToken::new();
            let signal = cancellation.clone();
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                signal.cancel();
            });
            asa_daemon::run(paths, endpoint, token, cancellation).await
        }
        Command::Daemon {
            command: DaemonCommand::Status(endpoint),
        } => {
            daemon_status(&paths, &endpoint.endpoint).await?;
            println!("healthy at {}", endpoint.endpoint);
            Ok(())
        }
        Command::Daemon {
            command: DaemonCommand::Rebuild,
        } => {
            let count = asa_daemon::rebuild_sessions(&paths)?;
            println!("rebuilt {count} session projection(s)");
            Ok(())
        }
        Command::Daemon {
            command: DaemonCommand::Install(endpoint),
        } => {
            let executable = std::env::current_exe()?.canonicalize()?;
            let service = supervisor::install(&paths, &executable, &endpoint.endpoint)?;
            println!("installed and started {}", service.display());
            Ok(())
        }
        Command::Daemon {
            command: DaemonCommand::Uninstall,
        } => {
            let service = supervisor::uninstall()?;
            println!("uninstalled {}", service.display());
            Ok(())
        }
        Command::Daemon {
            command: DaemonCommand::Start,
        } => supervisor::start(),
        Command::Daemon {
            command: DaemonCommand::Stop,
        } => supervisor::stop(),
        Command::Daemon {
            command: DaemonCommand::Restart,
        } => supervisor::restart(),
        Command::Daemon {
            command: DaemonCommand::Doctor,
        } => {
            let findings = supervisor::doctor(&paths)?;
            if findings.is_empty() {
                println!("daemon service is healthy");
                Ok(())
            } else {
                for finding in findings {
                    println!("{finding}");
                }
                bail!("daemon service needs attention")
            }
        }
        Command::Daemon {
            command: DaemonCommand::Logs { lines },
        } => supervisor::print_logs(&paths, lines),
        Command::Sessions { command } => run_sessions(&paths, command),
        Command::Hooks { command } => run_hooks(command),
        Command::Analyze { id, json } => run_analyze(&id, json),
        Command::Compare { a, b, json } => run_compare(&a, &b, json),
        Command::Distill {
            agent,
            limit,
            since,
            json,
        } => run_distill(&agent, limit, since.as_deref(), json),
        Command::Prompter {
            agent,
            limit,
            since,
            json,
        } => run_prompter(&agent, limit, since.as_deref(), json),
        Command::Project { path, limit, json } => run_project(path.as_deref(), limit, json),
        Command::Intents {
            agent,
            limit,
            since,
            json,
        } => run_intents(&agent, limit, since.as_deref(), json),
        Command::Models {
            agent,
            limit,
            since,
            json,
        } => run_models(&agent, limit, since.as_deref(), json),
        Command::Efficacy {
            path,
            limit,
            window,
            json,
        } => run_efficacy(path.as_deref(), limit, window, json),
        Command::Resume {
            id,
            prompt,
            dry_run,
        } => run_native_session_command(&id, prompt.as_deref(), dry_run, resume_invocation).await,
        Command::Fork(args) => run_fork(&args).await,
        Command::Privacy { command } => run_privacy(&paths, command),
        Command::Storage { command } => run_storage(&paths, command),
        Command::Hook { .. } => unreachable!("hook handled before human CLI initialization"),
    }
}

async fn daemon_status(paths: &AsaPaths, endpoint: &str) -> Result<()> {
    let endpoint: SocketAddr = endpoint.parse().context("invalid endpoint")?;
    let mut control = endpoint;
    control.set_port(
        endpoint
            .port()
            .checked_add(1)
            .context("OTLP endpoint port has no adjacent control port")?,
    );
    let token = std::fs::read_to_string(paths.token_file()).context("daemon token unavailable")?;
    let check = async {
        let mut stream = TcpStream::connect(control).await?;
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {control}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            token.trim()
        );
        stream.write_all(request.as_bytes()).await?;
        let mut response = Vec::with_capacity(1024);
        stream.take(16 * 1024).read_to_end(&mut response).await?;
        let response = String::from_utf8_lossy(&response);
        if !response.starts_with("HTTP/1.1 200") || !response.contains("\"status\":\"ok\"") {
            bail!("control API returned an unhealthy response");
        }
        Ok::<(), anyhow::Error>(())
    };
    timeout(Duration::from_millis(500), check)
        .await
        .context("daemon health check timed out")??;
    Ok(())
}

fn run_adapters(command: AdapterCommand) -> Result<()> {
    match command {
        AdapterCommand::List { json } => {
            let adapters = serde_json::json!([
                {
                    "name": "claude-code",
                    "cli_hooks": "supported",
                    "cli_transcripts": "supported",
                    "desktop_hooks": "conditional: only surfaces using the Claude Code hook runtime",
                    "desktop_transcripts": "unknown"
                },
                {
                    "name": "codex",
                    "cli_hooks": "supported",
                    "cli_transcripts": "supported",
                    "desktop_hooks": "conditional: requires the same trusted local-workspace hook runtime",
                    "desktop_transcripts": "supported when stored in CODEX_HOME"
                }
            ]);
            if json {
                println!("{}", serde_json::to_string_pretty(&adapters)?);
            } else {
                for adapter in adapters.as_array().expect("adapter list is an array") {
                    println!(
                        "{}: CLI hooks/transcripts supported; desktop hooks {}",
                        adapter["name"].as_str().unwrap_or("?"),
                        adapter["desktop_hooks"].as_str().unwrap_or("unknown")
                    );
                }
            }
        }
        AdapterCommand::Capabilities { adapter, json } => {
            let value = serde_json::to_value(capabilities(adapter))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&value)?);
            } else {
                println!("{}: {}", adapter.as_str(), value);
            }
        }
    }
    Ok(())
}

fn run_storage(paths: &AsaPaths, command: StorageCommand) -> Result<()> {
    let analytics = spawn_analytics(paths)?;
    let stats = match command {
        StorageCommand::Rebuild => analytics.rebuild(list_sessions(paths)?)?,
        StorageCommand::Stats => analytics.stats()?,
    };
    println!(
        "sessions {} · turns {} · tool calls {} · input tokens {} · output tokens {}",
        stats.sessions, stats.turns, stats.tool_calls, stats.input_tokens, stats.output_tokens
    );
    Ok(())
}

fn run_privacy(paths: &AsaPaths, command: PrivacyCommand) -> Result<()> {
    match command {
        PrivacyCommand::Init => {
            let path = paths.privacy_config();
            if path.exists() {
                bail!("privacy configuration already exists: {}", path.display());
            }
            std::fs::create_dir_all(paths.root())?;
            let contents = serde_json::to_string_pretty(&PrivacyConfig::default())? + "\n";
            write_private(&path, &contents)?;
            println!("created {}", path.display());
        }
        PrivacyCommand::Show { adapter, cwd } => {
            let config = load_privacy(paths);
            let value = if let Some(adapter) = adapter {
                serde_json::json!({
                    "adapter": adapter.as_str(),
                    "capture": config.effective_for(adapter.as_str()),
                    "excluded": config.excludes(cwd.as_deref()),
                    "maximum_content_bytes": config.maximum_content_bytes,
                    "retention_days": config.retention_days,
                })
            } else {
                serde_json::to_value(config)?
            };
            println!("{}", serde_json::to_string_pretty(&value)?);
        }
        PrivacyCommand::EnforceRetention { yes } => {
            if !yes {
                bail!("retention deletion requires --yes");
            }
            let config = load_privacy(paths);
            let days = config
                .retention_days
                .context("retention_days is not configured")?;
            let cutoff = time::OffsetDateTime::now_utc() - TimeDuration::days(i64::from(days));
            let expired = list_sessions(paths)?
                .into_iter()
                .filter(|session| session.ended_at.is_some_and(|ended| ended < cutoff))
                .map(|session| session.id.to_string())
                .collect::<Vec<_>>();
            for session_id in &expired {
                delete_session(paths, session_id)?;
            }
            println!("deleted {} expired ASA session(s)", expired.len());
        }
    }
    Ok(())
}

fn run_analyze(id: &str, json: bool) -> Result<()> {
    let report = analyze(parse_session(&resolve_native_session(id)?)?);
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        render_analysis(&report);
    }
    Ok(())
}

fn run_compare(a: &str, b: &str, json: bool) -> Result<()> {
    let a_report = analyze(parse_session(&resolve_native_session(a)?)?);
    let b_report = analyze(parse_session(&resolve_native_session(b)?)?);
    let rows = compare(&a_report, &b_report);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "a": a_report.session.id,
                "b": b_report.session.id,
                "rows": rows
            }))?
        );
    } else {
        println!("A: {}", a_report.session.id);
        println!("B: {}", b_report.session.id);
        println!();
        println!("{:<22} {:>14} {:>14} {:>14}", "metric", "A", "B", "delta");
        println!("{}", "-".repeat(68));
        for row in rows {
            println!(
                "{:<22} {:>14} {:>14} {:>+14}",
                row.metric, row.a, row.b, row.delta
            );
        }
    }
    Ok(())
}

fn run_distill(agent: &str, limit: usize, since: Option<&str>, json: bool) -> Result<()> {
    let references = select_native_sessions(agent, limit, since)?;
    let report = distill_sessions(&references)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", render_distill(&report));
    }
    Ok(())
}

fn run_prompter(agent: &str, limit: usize, since: Option<&str>, json: bool) -> Result<()> {
    let references = select_native_sessions(agent, limit, since)?;
    let report = analyze_prompter(&references)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", render_prompter(&report));
    }
    Ok(())
}

fn run_project(path: Option<&Path>, limit: usize, json: bool) -> Result<()> {
    let repo = resolve_repo_root(path)?;
    let references = select_native_sessions("all", limit, None)?;
    let report = build_project_report(&repo, &references)?;
    if report.sessions == 0 {
        bail!("no native sessions found for {}", repo.display());
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", render_project(&report));
    }
    Ok(())
}

fn run_intents(agent: &str, limit: usize, since: Option<&str>, json: bool) -> Result<()> {
    let references = select_native_sessions(agent, limit, since)?;
    let report = build_intent_report(&references)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", render_intents(&report));
    }
    Ok(())
}

fn run_models(agent: &str, limit: usize, since: Option<&str>, json: bool) -> Result<()> {
    let references = select_native_sessions(agent, limit, since)?;
    let report = build_model_report(&references)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", render_models(&report));
    }
    Ok(())
}

fn run_efficacy(path: Option<&Path>, limit: usize, window: usize, json: bool) -> Result<()> {
    if window == 0 {
        bail!("--window must be greater than zero");
    }
    let repo = resolve_repo_root(path)?;
    let changes = read_instruction_changes(&repo)?;
    let references = select_native_sessions("all", limit, None)?;
    let report = build_efficacy_report(&repo, &references, &changes, window)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", render_efficacy(&report));
    }
    Ok(())
}

fn read_instruction_changes(repo: &Path) -> Result<Vec<InstructionChange>> {
    let mut changes = Vec::new();
    for file in ["CLAUDE.md", "AGENTS.md"] {
        let output = std::process::Command::new("git")
            .args(["log", "--follow", "--format=%H|%cI|%s", "--", file])
            .current_dir(repo)
            .output()
            .with_context(|| format!("failed to read git history for {file}"))?;
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8(output.stdout)
            .with_context(|| format!("git history for {file} is not UTF-8"))?;
        for line in stdout.lines() {
            let mut fields = line.splitn(3, '|');
            let (Some(commit), Some(date), Some(subject)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            changes.push(InstructionChange {
                file: file.to_owned(),
                commit: commit.to_owned(),
                date: date.to_owned(),
                subject: subject.to_owned(),
            });
        }
    }
    changes.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(changes)
}

fn resolve_repo_root(path: Option<&Path>) -> Result<PathBuf> {
    let path = if let Some(path) = path {
        path.canonicalize()
            .with_context(|| format!("cannot resolve repository path {}", path.display()))?
    } else {
        std::env::current_dir()?
    };
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&path)
        .output()
        .with_context(|| format!("failed to inspect git repository at {}", path.display()))?;
    if !output.status.success() {
        bail!("{} is not inside a git repository", path.display());
    }
    let root =
        String::from_utf8(output.stdout).context("git returned a non-UTF-8 repository path")?;
    PathBuf::from(root.trim())
        .canonicalize()
        .context("cannot canonicalize git repository root")
}

fn select_native_sessions(
    agent: &str,
    limit: usize,
    since: Option<&str>,
) -> Result<Vec<NativeSessionReference>> {
    let adapters = match agent {
        "all" => vec![AdapterName::ClaudeCode, AdapterName::Codex],
        "claude" | "claude-code" => vec![AdapterName::ClaudeCode],
        "codex" => vec![AdapterName::Codex],
        _ => bail!("unknown --agent {agent:?}; use all, claude, or codex"),
    };
    if limit == 0 {
        bail!("--limit must be greater than zero");
    }
    let since_ms = since.map(parse_since_ms).transpose()?;
    let mut references = adapters
        .into_iter()
        .map(discover_sessions)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .filter(|reference| {
            since_ms.is_none_or(|minimum| {
                reference
                    .updated_at_unix_ms
                    .is_some_and(|updated| updated >= minimum)
            })
        })
        .collect::<Vec<_>>();
    references.sort_by_key(|reference| std::cmp::Reverse(reference.updated_at_unix_ms));
    references.truncate(limit);
    if references.is_empty() {
        bail!("no native sessions in scope; relax --since, --agent, or --limit");
    }
    Ok(references)
}

fn parse_since_ms(value: &str) -> Result<u128> {
    if let Some(days) = value.strip_suffix('d') {
        let days = days
            .parse::<u64>()
            .with_context(|| format!("invalid relative --since value {value:?}"))?;
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .context("system clock is before Unix epoch")?
            .as_millis();
        return Ok(now.saturating_sub(u128::from(days) * 86_400_000));
    }
    let timestamp = format!("{value}T00:00:00Z");
    let parsed =
        time::OffsetDateTime::parse(&timestamp, &time::format_description::well_known::Rfc3339)
            .with_context(|| format!("invalid --since {value:?}; use Nd or YYYY-MM-DD"))?;
    u128::try_from(parsed.unix_timestamp_nanos() / 1_000_000)
        .context("--since must be after the Unix epoch")
}

#[derive(Debug, Eq, PartialEq)]
struct NativeInvocation {
    command: &'static str,
    args: Vec<String>,
}

fn resume_invocation(
    adapter: &str,
    native_id: &str,
    prompt: Option<&str>,
) -> Result<NativeInvocation> {
    match adapter {
        "claude-code" => {
            let mut args = if prompt.is_some() {
                vec!["-p".to_owned(), "--resume".to_owned(), native_id.to_owned()]
            } else {
                vec!["--resume".to_owned(), native_id.to_owned()]
            };
            if let Some(prompt) = prompt {
                args.push(prompt.to_owned());
            }
            Ok(NativeInvocation {
                command: "claude",
                args,
            })
        }
        "codex" => {
            let mut args = if prompt.is_some() {
                vec!["exec".to_owned(), "resume".to_owned(), native_id.to_owned()]
            } else {
                vec!["resume".to_owned(), native_id.to_owned()]
            };
            if let Some(prompt) = prompt {
                args.push(prompt.to_owned());
            }
            Ok(NativeInvocation {
                command: "codex",
                args,
            })
        }
        _ => bail!("adapter {adapter:?} does not support resume"),
    }
}

fn fork_invocation(
    adapter: &str,
    native_id: &str,
    prompt: Option<&str>,
) -> Result<NativeInvocation> {
    match adapter {
        "claude-code" => {
            let mut args = if prompt.is_some() {
                vec![
                    "-p".to_owned(),
                    "--resume".to_owned(),
                    native_id.to_owned(),
                    "--fork-session".to_owned(),
                ]
            } else {
                vec![
                    "--resume".to_owned(),
                    native_id.to_owned(),
                    "--fork-session".to_owned(),
                ]
            };
            if let Some(prompt) = prompt {
                args.push(prompt.to_owned());
            }
            Ok(NativeInvocation {
                command: "claude",
                args,
            })
        }
        "codex" => {
            let mut args = vec!["fork".to_owned(), native_id.to_owned()];
            if let Some(prompt) = prompt {
                args.push(prompt.to_owned());
            }
            Ok(NativeInvocation {
                command: "codex",
                args,
            })
        }
        _ => bail!("adapter {adapter:?} does not support fork"),
    }
}

async fn run_native_session_command(
    id: &str,
    prompt: Option<&str>,
    dry_run: bool,
    invocation_for: fn(&str, &str, Option<&str>) -> Result<NativeInvocation>,
) -> Result<()> {
    let reference = resolve_native_session(id)?;
    let session = parse_session(&reference)?;
    let native_id = reference
        .id
        .split_once(':')
        .map_or(reference.id.as_str(), |(_, native)| native);
    let invocation = invocation_for(&reference.adapter, native_id, prompt)?;
    let cwd = native_session_cwd(session.cwd.as_deref())?;
    launch_native_invocation(invocation, cwd, dry_run).await
}

async fn run_fork(args: &ForkArgs) -> Result<()> {
    let reference = resolve_native_session(&args.id)?;
    let session = parse_session(&reference)?;
    let cwd = native_session_cwd(session.cwd.as_deref())?;
    if args.context {
        return run_context_fork(&reference, cwd, args).await;
    }
    if let Some(step_id) = args.at.as_deref() {
        return run_at_fork(&reference, cwd, step_id, args).await;
    }
    if args.no_launch {
        bail!(
            "--no-launch requires --at or --context because native whole-session forks are created on launch"
        );
    }
    let native_id = reference
        .id
        .split_once(':')
        .map_or(reference.id.as_str(), |(_, native)| native);
    let invocation = fork_invocation(&reference.adapter, native_id, args.prompt.as_deref())?;
    launch_native_invocation(invocation, cwd, args.dry_run).await
}

async fn run_context_fork(
    reference: &NativeSessionReference,
    cwd: PathBuf,
    args: &ForkArgs,
) -> Result<()> {
    if args.dry_run {
        println!(
            "[dry-run] would craft a context fork of {}: digest older steps and keep the last {} verbatim{}",
            reference.id,
            args.keep,
            args.hint
                .as_deref()
                .map_or_else(String::new, |value| format!(" with focus {value:?}"))
        );
        println!("  source: {}", reference.path.display());
        print_dry_run_resume(cwd.as_path(), args);
        return Ok(());
    }
    let fork = craft_context_fork(
        reference,
        &ContextForkOptions {
            keep_last_steps: args.keep,
            hint: args.hint.clone(),
        },
    )?;
    println!(
        "crafted context fork of {} -> {}\n  {}\n  {} steps digested, {} kept verbatim, {} digest chars, estimated {} tokens{}",
        reference.id,
        fork.new_session_id,
        fork.new_path.display(),
        fork.digested_steps,
        fork.kept_steps,
        fork.digest_chars,
        fork.estimated_tokens,
        copied_subagent_note(fork.copied_subagents)
    );
    if args.no_launch {
        return Ok(());
    }
    let invocation = resume_invocation(
        &reference.adapter,
        &fork.new_session_id,
        args.prompt.as_deref(),
    )?;
    launch_native_invocation(invocation, cwd, false).await
}

async fn run_at_fork(
    reference: &NativeSessionReference,
    cwd: PathBuf,
    step_id: &str,
    args: &ForkArgs,
) -> Result<()> {
    if args.dry_run {
        println!(
            "[dry-run] would fork {} at step {} by writing a new native transcript beside:",
            reference.id, step_id
        );
        println!("  {}", reference.path.display());
        print_dry_run_resume(cwd.as_path(), args);
        return Ok(());
    }
    let fork = fork_native_session_at_step(reference, step_id)?;
    println!(
        "forked {} at step {} -> {}\n  {}\n  kept {} records, dropped {}{}",
        reference.id,
        step_id,
        fork.new_session_id,
        fork.new_path.display(),
        fork.kept_records,
        fork.dropped_records,
        copied_subagent_note(fork.copied_subagents)
    );
    if args.no_launch {
        return Ok(());
    }
    let invocation = resume_invocation(
        &reference.adapter,
        &fork.new_session_id,
        args.prompt.as_deref(),
    )?;
    launch_native_invocation(invocation, cwd, false).await
}

fn print_dry_run_resume(cwd: &Path, args: &ForkArgs) {
    if !args.no_launch {
        println!(
            "[dry-run] would then resume the new session (cwd: {}){}",
            cwd.display(),
            args.prompt
                .as_deref()
                .map_or_else(String::new, |value| format!(" with prompt {value:?}"))
        );
    }
}

fn copied_subagent_note(count: usize) -> String {
    if count == 0 {
        String::new()
    } else {
        format!(", copied {count} subagent transcript(s)")
    }
}

fn native_session_cwd(recorded: Option<&str>) -> Result<PathBuf> {
    Ok(recorded
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or(std::env::current_dir()?))
}

async fn launch_native_invocation(
    invocation: NativeInvocation,
    cwd: PathBuf,
    dry_run: bool,
) -> Result<()> {
    let rendered = render_process(&invocation);
    if dry_run {
        println!("[dry-run] would run (cwd: {}):", cwd.display());
        println!("  {rendered}");
        return Ok(());
    }

    eprintln!("→ {rendered}  (cwd: {})", cwd.display());
    let status = tokio::task::spawn_blocking(move || {
        std::process::Command::new(invocation.command)
            .args(invocation.args)
            .current_dir(cwd)
            .status()
    })
    .await
    .context("native agent process task failed")?
    .with_context(|| {
        format!(
            "failed to launch native agent command; is {} installed and on PATH?",
            rendered
                .split_whitespace()
                .next()
                .unwrap_or("the agent CLI")
        )
    })?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

fn render_process(invocation: &NativeInvocation) -> String {
    std::iter::once(invocation.command.to_owned())
        .chain(invocation.args.iter().map(|argument| {
            if argument
                .chars()
                .any(|character| character.is_whitespace() || matches!(character, '"' | '\\'))
            {
                serde_json::to_string(argument).expect("process argument serializes")
            } else {
                argument.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_native_session(id_or_prefix: &str) -> Result<NativeSessionReference> {
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
        [] => bail!("no native session matches {id_or_prefix:?}"),
        _ => bail!(
            "ambiguous native session prefix {id_or_prefix:?} ({} matches)",
            matches.len()
        ),
    }
}

fn render_analysis(report: &AnalysisReport) {
    let session = &report.session;
    println!("{} session {}", session.adapter, session.id);
    if let Some(title) = session.title.as_ref() {
        println!("  title  {title}");
    }
    if let Some(cwd) = session.cwd.as_ref() {
        println!("  cwd    {cwd}");
    }
    if !session.models.is_empty() {
        println!("  model  {}", session.models.join(", "));
    }
    println!("  file   {}", session.file_path.display());
    println!();
    println!(
        "steps {} · api calls {} · tool calls {} ({} mcp, {} errors) · subagents {} · compactions {}",
        report.steps,
        report.api_calls,
        report.tool_calls,
        report.mcp_calls,
        report.tool_errors,
        report.subagents,
        session.compactions,
    );
    println!(
        "tokens: in {}, out {}, cache-read {}, cache-write {}, reasoning {} — total {}",
        session.usage.input_tokens,
        session.usage.output_tokens,
        session.usage.cache_read_tokens,
        session.usage.cache_creation_tokens,
        session.usage.reasoning_tokens,
        session.usage.total_tokens,
    );
    if session.malformed_lines > 0 {
        println!(
            "parser: ignored {} malformed or truncated JSONL line(s)",
            session.malformed_lines
        );
    }
    if !report.tool_stats.is_empty() {
        println!();
        println!("{:<36} {:>8} {:>8}", "tool", "calls", "errors");
        println!("{}", "-".repeat(54));
        for tool in &report.tool_stats {
            println!("{:<36} {:>8} {:>8}", tool.name, tool.count, tool.errors);
        }
    }
}

#[allow(clippy::too_many_lines)]
fn run_sessions(paths: &AsaPaths, command: SessionCommand) -> Result<()> {
    match command {
        SessionCommand::List { json } => {
            let observed = list_sessions(paths)?;
            let mut entries = BTreeMap::new();
            for session in &observed {
                entries.insert(
                    session.id.to_string(),
                    serde_json::json!({
                        "id": session.id.to_string(),
                        "adapter": match session.source {
                            asa_core::SessionSource::ClaudeCode => "claude-code",
                            asa_core::SessionSource::Codex => "codex",
                        },
                        "native_path": null,
                        "native": false,
                        "observed": true,
                        "turn_count": session.turns.len(),
                        "observation_count": session.projection.observation_count,
                        "title": null,
                        "updated_at_unix_ms": null
                    }),
                );
            }
            for adapter in [AdapterName::ClaudeCode, AdapterName::Codex] {
                for native in discover_sessions(adapter)? {
                    let entry = entries.entry(native.id.clone()).or_insert_with(|| {
                        serde_json::json!({
                            "id": native.id.clone(),
                            "adapter": native.adapter.clone(),
                            "native_path": null,
                            "native": false,
                            "observed": false,
                            "turn_count": 0,
                            "observation_count": 0,
                            "title": null,
                            "updated_at_unix_ms": null
                        })
                    });
                    entry["native"] = serde_json::Value::Bool(true);
                    entry["native_path"] =
                        serde_json::Value::String(native.path.display().to_string());
                    entry["title"] = native
                        .title
                        .map_or(serde_json::Value::Null, serde_json::Value::String);
                    entry["updated_at_unix_ms"] = native
                        .updated_at_unix_ms
                        .and_then(|milliseconds| u64::try_from(milliseconds).ok())
                        .map_or(serde_json::Value::Null, serde_json::Value::from);
                }
            }
            let mut sessions = entries.into_values().collect::<Vec<_>>();
            sessions.sort_by_key(|session| {
                std::cmp::Reverse(session["updated_at_unix_ms"].as_u64().unwrap_or_default())
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&sessions)?);
            } else if sessions.is_empty() {
                println!("No native or observed sessions found.");
            } else {
                for session in sessions {
                    println!(
                        "{:<48} {:<11} native={} observed={} {} turn(s)",
                        session["id"].as_str().unwrap_or("?"),
                        session["adapter"].as_str().unwrap_or("?"),
                        session["native"].as_bool().unwrap_or(false),
                        session["observed"].as_bool().unwrap_or(false),
                        session["turn_count"].as_u64().unwrap_or_default(),
                    );
                }
            }
            Ok(())
        }
        SessionCommand::Show { id, json } => {
            let (adapter, native_id) = id
                .split_once(':')
                .context("session ID must be namespaced, e.g. codex:abc")?;
            let session = read_session(paths, adapter, native_id)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&session)?);
            } else {
                println!("session: {}", session.id);
                println!("turns: {}", session.turns.len());
                println!("observations: {}", session.projection.observation_count);
            }
            Ok(())
        }
        SessionCommand::Delete { id, yes } => {
            if !yes {
                bail!("deletion requires --yes; native agent transcripts are never removed");
            }
            let report = delete_session(paths, &id)?;
            println!(
                "deleted ASA session {}: {} observation(s), {} spool entry(s), projection={}; native transcript untouched",
                report.session_id,
                report.observations_removed,
                report.spool_entries_removed,
                report.projection_removed,
            );
            Ok(())
        }
        SessionCommand::MigratePath {
            old,
            new,
            dry_run,
            json,
        } => {
            let config = MigrationConfig::discover(paths.root())?;
            let report = migrate_workspace_path(&old, &new, &config, dry_run)?;
            if !dry_run {
                let observation = Observation {
                    schema_version: 1,
                    id: Uuid::now_v7().to_string(),
                    adapter: "asa".to_owned(),
                    native_event: "workspace.path.changed".to_owned(),
                    kind: ObservationKind::WorkspacePathChanged,
                    observed_at: time::OffsetDateTime::now_utc(),
                    session_id: format!("workspace-migration:{}", report.id),
                    turn_id: None,
                    invocation_id: None,
                    attributes: BTreeMap::from([
                        (
                            asa_semconv::asa::WORKSPACE_PREVIOUS_PATH.to_owned(),
                            AttributeValue::String(old.to_string_lossy().into_owned()),
                        ),
                        (
                            asa_semconv::asa::WORKSPACE_PATH.to_owned(),
                            AttributeValue::String(new.to_string_lossy().into_owned()),
                        ),
                    ]),
                };
                spool_observation(paths, &observation)?;
                // Existing projections are always rebuildable; this reconciles any
                // durable observations already drained by a running daemon.
                let _ = asa_daemon::rebuild_sessions(paths)?;
                let analytics = spawn_analytics(paths)?;
                let _ = analytics.rebuild(list_sessions(paths)?)?;
            }
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "{} workspace migration {}: {} operation(s), {} session(s), {} metadata field(s)",
                    if dry_run { "planned" } else { "completed" },
                    report.id,
                    report.operations,
                    report.sessions,
                    report.records_changed
                );
                if dry_run {
                    for operation in &report.planned {
                        println!(
                            "  {}: {} -> {}{}",
                            operation.adapter,
                            operation.source.display(),
                            operation.destination.display(),
                            if operation.remove_source {
                                ""
                            } else {
                                " (in place)"
                            }
                        );
                    }
                } else {
                    println!("journal: {}", report.journal.display());
                    println!("backups: {}", report.backup_root.display());
                }
            }
            Ok(())
        }
    }
}

fn run_hooks(command: HooksCommand) -> Result<()> {
    if let HooksCommand::Test { adapter, event } = command {
        let payload = serde_json::json!({
            "session_id": "asa-hook-test",
            "turn_id": "asa-hook-test-turn",
            "cwd": std::env::current_dir()?,
            "hook_event_name": event,
            "tool_use_id": "asa-hook-test-tool",
            "tool_name": "asa-hook-test"
        });
        let observation = native_hook_to_observation(adapter, &serde_json::to_vec(&payload)?)?;
        println!("{}", serde_json::to_string_pretty(&observation)?);
        return Ok(());
    }
    let (selection, operation) = match command {
        HooksCommand::Install(selection) => (selection, "install"),
        HooksCommand::Uninstall(selection) => (selection, "uninstall"),
        HooksCommand::Status(selection) | HooksCommand::List(selection) => (selection, "status"),
        HooksCommand::Doctor(selection) => (selection, "doctor"),
        HooksCommand::Test { .. } => unreachable!(),
    };
    let adapters = selected_adapters(&selection)?;
    let cwd = std::env::current_dir()?;
    let locations = hooks::locations(&adapters, selection.scope, &cwd)?;
    let executable = std::env::current_exe()?.canonicalize()?;
    let mut unhealthy = false;
    for location in locations {
        match operation {
            "install" => {
                let changed = hooks::install(&location, &executable)?;
                println!(
                    "{}: {} ({})",
                    location.adapter.as_str(),
                    location.path.display(),
                    if changed {
                        "installed"
                    } else {
                        "already installed"
                    }
                );
            }
            "uninstall" => {
                let changed = hooks::uninstall(&location)?;
                println!(
                    "{}: {} ({})",
                    location.adapter.as_str(),
                    location.path.display(),
                    if changed { "removed" } else { "not installed" }
                );
            }
            "status" => {
                let installed = hooks::installed(&location)?;
                unhealthy |= !installed;
                println!(
                    "{}: {} ({})",
                    location.adapter.as_str(),
                    location.path.display(),
                    if installed {
                        "installed"
                    } else {
                        "not installed"
                    }
                );
            }
            "doctor" => {
                let findings = hooks::doctor(&location, &executable)?;
                unhealthy |= !findings.is_empty();
                if findings.is_empty() {
                    println!("{}: healthy", location.adapter.as_str());
                } else {
                    for finding in findings {
                        println!("{}: {finding}", location.adapter.as_str());
                    }
                }
            }
            _ => unreachable!(),
        }
    }
    if unhealthy {
        bail!("one or more hook installations need attention");
    }
    if matches!(operation, "install") && adapters.contains(&AdapterName::Codex) {
        println!("Codex: open /hooks to review and trust the installed definitions.");
    }
    Ok(())
}

fn selected_adapters(selection: &HookSelection) -> Result<Vec<AdapterName>> {
    if selection.all {
        return Ok(vec![AdapterName::ClaudeCode, AdapterName::Codex]);
    }
    selection
        .adapter
        .map(|adapter| vec![adapter])
        .context("pass an adapter (claude-code or codex), or --all")
}

async fn run_hook(paths: AsaPaths, adapter: AdapterName, endpoint: &str) {
    let mut payload = Vec::new();
    let read_result = io::stdin()
        .take((HOOK_MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut payload);
    let event = serde_json::from_slice::<serde_json::Value>(&payload)
        .ok()
        .and_then(|value| {
            value
                .get("hook_event_name")
                .or_else(|| value.get("event_name"))
                .or_else(|| value.get("event"))
                .and_then(|event| event.as_str())
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let privacy = load_privacy(&paths);
    let cwd = serde_json::from_slice::<serde_json::Value>(&payload)
        .ok()
        .and_then(|value| value.get("cwd")?.as_str().map(ToOwned::to_owned));
    if read_result.is_ok()
        && payload.len() <= HOOK_MAX_INPUT_BYTES
        && !privacy.excludes(cwd.as_deref())
        && let Ok(observation) = native_hook_to_observation_with_policy(
            adapter,
            &payload,
            privacy.effective_for(adapter.as_str()).prompt,
            privacy.effective_for(adapter.as_str()).assistant_response,
            privacy.maximum_content_bytes,
        )
    {
        if is_session_deleted(&paths, &observation.session_id) {
            let _ = io::stdout().write_all(neutral_hook_response(adapter, &event).as_bytes());
            return;
        }
        let delivered = timeout(
            HOOK_ACK_BUDGET,
            send_observation(&paths, endpoint, &observation),
        )
        .await;
        if !matches!(delivered, Ok(Ok(()))) {
            let _ = spool_observation(&paths, &observation);
        }
    }
    let _ = io::stdout().write_all(neutral_hook_response(adapter, &event).as_bytes());
}

fn load_privacy(paths: &AsaPaths) -> PrivacyConfig {
    std::fs::read(paths.privacy_config())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn send_observation(
    paths: &AsaPaths,
    endpoint: &str,
    observation: &asa_core::Observation,
) -> Result<()> {
    let token = std::fs::read_to_string(paths.token_file()).context("daemon token unavailable")?;
    let channel: Channel = Endpoint::from_shared(format!("http://{endpoint}"))?
        .connect_timeout(Duration::from_millis(50))
        .timeout(Duration::from_millis(150))
        .connect()
        .await?;
    let mut client = LogsServiceClient::new(channel);
    let mut request = Request::new(export_request(observation));
    request.metadata_mut().insert(
        "authorization",
        MetadataValue::try_from(format!("Bearer {}", token.trim()))?,
    );
    client.export(request).await?;
    Ok(())
}

fn load_or_create_token(paths: &AsaPaths) -> Result<String> {
    let path = paths.token_file();
    if let Ok(existing) = std::fs::read_to_string(&path)
        && !existing.trim().is_empty()
    {
        return Ok(existing.trim().to_owned());
    }
    std::fs::create_dir_all(paths.root())?;
    let token = Uuid::now_v7().simple().to_string();
    let temporary = path.with_extension("tmp");
    write_private(&temporary, &token)?;
    std::fs::rename(&temporary, path)?;
    Ok(token)
}

fn write_private(path: &Path, contents: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_data()?;
    }
    #[cfg(not(unix))]
    {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_data()?;
    }
    Ok(())
}

#[cfg(test)]
mod resume_tests {
    use super::*;

    #[test]
    fn claude_resume_matches_retained_v1_argv() {
        assert_eq!(
            resume_invocation("claude-code", "abc", Some("do the thing")).unwrap(),
            NativeInvocation {
                command: "claude",
                args: vec![
                    "-p".to_owned(),
                    "--resume".to_owned(),
                    "abc".to_owned(),
                    "do the thing".to_owned()
                ]
            }
        );
    }

    #[test]
    fn codex_resume_matches_interactive_and_headless_v1_argv() {
        assert_eq!(
            resume_invocation("codex", "abc", None).unwrap(),
            NativeInvocation {
                command: "codex",
                args: vec!["resume".to_owned(), "abc".to_owned()]
            }
        );
        assert_eq!(
            resume_invocation("codex", "abc", Some("continue")).unwrap(),
            NativeInvocation {
                command: "codex",
                args: vec![
                    "exec".to_owned(),
                    "resume".to_owned(),
                    "abc".to_owned(),
                    "continue".to_owned()
                ]
            }
        );
    }

    #[test]
    fn process_rendering_quotes_only_unsafe_arguments() {
        let invocation = resume_invocation("claude-code", "abc", Some("do \"it\"")).unwrap();
        assert_eq!(
            render_process(&invocation),
            "claude -p --resume abc \"do \\\"it\\\"\""
        );
    }

    #[test]
    fn claude_whole_session_fork_matches_retained_v1_argv() {
        assert_eq!(
            fork_invocation("claude-code", "abc", None).unwrap(),
            NativeInvocation {
                command: "claude",
                args: vec![
                    "--resume".to_owned(),
                    "abc".to_owned(),
                    "--fork-session".to_owned(),
                ]
            }
        );
        assert_eq!(
            fork_invocation("claude-code", "abc", Some("try B")).unwrap(),
            NativeInvocation {
                command: "claude",
                args: vec![
                    "-p".to_owned(),
                    "--resume".to_owned(),
                    "abc".to_owned(),
                    "--fork-session".to_owned(),
                    "try B".to_owned(),
                ]
            }
        );
    }

    #[test]
    fn codex_whole_session_fork_matches_retained_v1_argv() {
        assert_eq!(
            fork_invocation("codex", "abc", None).unwrap(),
            NativeInvocation {
                command: "codex",
                args: vec!["fork".to_owned(), "abc".to_owned()]
            }
        );
        assert_eq!(
            fork_invocation("codex", "abc", Some("try B")).unwrap(),
            NativeInvocation {
                command: "codex",
                args: vec!["fork".to_owned(), "abc".to_owned(), "try B".to_owned()]
            }
        );
    }

    #[test]
    fn fork_cli_accepts_whole_at_and_context_modes_but_rejects_mixed_modes() {
        assert!(Cli::try_parse_from(["asa", "fork", "abc"]).is_ok());
        assert!(
            Cli::try_parse_from(["asa", "fork", "abc", "--at", "turn-one", "--no-launch"]).is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "asa",
                "fork",
                "abc",
                "--context",
                "--keep",
                "4",
                "--hint",
                "database",
                "--no-launch"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from(["asa", "fork", "abc", "--at", "turn-one", "--context"]).is_err()
        );
        assert!(Cli::try_parse_from(["asa", "fork", "abc", "--hint", "database"]).is_err());
    }

    #[test]
    fn migrate_path_cli_accepts_apply_dry_run_and_json() {
        assert!(
            Cli::try_parse_from(["asa", "sessions", "migrate-path", "/old path", "/new path"])
                .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "asa",
                "sessions",
                "migrate-path",
                "/old",
                "/new",
                "--dry-run",
                "--json"
            ])
            .is_ok()
        );
    }
}
