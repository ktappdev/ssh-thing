//! `ssh-thing` — the LLM-facing CLI for SSH THING.
//!
//! Deliberate capability boundary: this binary can list saved servers and
//! snippets and run a snippet against the server it is scoped to. It cannot
//! accept a command string, a host, a user, or a credential, and it cannot
//! create, edit, or delete anything. Curation happens in the desktop app.

mod commands;
mod output;

use clap::{Parser, Subcommand};
use serde::Serialize;
use ssh_thing_core as core;

use commands::Failure;
use output::{CliError, Envelope};

#[derive(Parser, Debug)]
#[command(
    name = "ssh-thing",
    version,
    about = "Run saved SSH THING snippets against their assigned servers",
    long_about = "Run saved SSH THING snippets against their assigned servers.\n\n\
Commands never accept a command string, host, user, or credential. The human \
curates server-scoped snippets in the SSH THING desktop app; this CLI can only \
order from that menu. Every run is gated by the desktop app's \
'Allow external automation' setting.",
    disable_help_subcommand = true
)]
struct Cli {
    /// Emit JSON. This is the default and the stable contract.
    #[arg(long, global = true)]
    json: bool,

    /// Emit human-readable text instead of JSON.
    #[arg(long, global = true, conflicts_with = "json")]
    human: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List saved servers. Secret values are never included.
    Servers,

    /// List saved snippets and whether the CLI can run each one.
    Snippets {
        /// Only show snippets scoped to this server (id or label).
        #[arg(long, value_name = "SERVER")]
        server: Option<String>,
    },

    /// Run one saved snippet against the server it is scoped to.
    Run {
        /// Snippet id or unique snippet name.
        #[arg(long, value_name = "SNIPPET")]
        snippet: String,

        /// Optional server id or label. If given it must match the snippet's
        /// own scope; cross-server execution is refused.
        #[arg(long, value_name = "SERVER")]
        server: Option<String>,

        /// Command timeout in seconds (5-600, default 60).
        #[arg(long, value_name = "SECONDS")]
        timeout: Option<u64>,

        /// Resolve and report the run without connecting.
        #[arg(long)]
        dry_run: bool,
    },

    /// Show recent CLI runs.
    History {
        #[arg(long, default_value_t = 20, value_name = "N")]
        limit: usize,
    },

    /// Diagnose the data files, keychain access, and the automation gate.
    Doctor,

    /// Print CLI and app versions.
    Version,
}

impl Command {
    fn name(&self) -> &'static str {
        match self {
            Command::Servers => "servers",
            Command::Snippets { .. } => "snippets",
            Command::Run { .. } => "run",
            Command::History { .. } => "history",
            Command::Doctor => "doctor",
            Command::Version => "version",
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let human = cli.human;
    std::process::exit(dispatch(cli.command, human).await);
}

async fn dispatch(command: Command, human: bool) -> i32 {
    let name = command.name();

    let app_dir = match core::app_data_dir() {
        Ok(dir) => dir,
        Err(message) => return emit_err(name, human, Failure::failed("app_data_dir", message)),
    };

    match command {
        Command::Servers => match commands::servers(&app_dir) {
            Ok(servers) => {
                let lines = human.then(|| commands::human_servers(&servers));
                emit_ok(name, servers, lines)
            }
            Err(failure) => emit_err(name, human, failure),
        },

        Command::Snippets { server } => match commands::snippets(&app_dir, server.as_deref()) {
            Ok(snippets) => {
                let lines = human.then(|| commands::human_snippets(&snippets));
                emit_ok(name, snippets, lines)
            }
            Err(failure) => emit_err(name, human, failure),
        },

        Command::Run {
            snippet,
            server,
            timeout,
            dry_run,
        } => {
            let request = commands::RunRequest {
                snippet_selector: &snippet,
                server_selector: server.as_deref(),
                timeout_seconds: timeout,
                dry_run,
            };

            match commands::run(&app_dir, request).await {
                Ok((report, exit_code)) => {
                    let lines = human.then(|| commands::human_run(&report));
                    if exit_code == 0 {
                        return emit_ok(name, report, lines);
                    }

                    // The run happened and failed. Exit non-zero and keep the
                    // full report so the caller can branch on `ok` and still
                    // read the output, exit code, and error.
                    match lines {
                        Some(lines) => print_lines(&lines),
                        None => print_envelope(&Envelope::failed_with_data(
                            name,
                            CliError::new(
                                "run_failed",
                                report
                                    .error
                                    .clone()
                                    .unwrap_or_else(|| "The command failed.".to_string()),
                            ),
                            report,
                        )),
                    }
                    exit_code
                }
                Err(failure) => emit_err(name, human, failure),
            }
        }

        Command::History { limit } => match commands::history(&app_dir, limit) {
            Ok(entries) => {
                let lines = human.then(|| commands::human_history(&entries));
                emit_ok(name, entries, lines)
            }
            Err(failure) => emit_err(name, human, failure),
        },

        Command::Doctor => {
            let report = commands::doctor(&app_dir);
            let lines = human.then(|| commands::human_doctor(&report));
            emit_ok(name, report, lines)
        }

        Command::Version => {
            let report = commands::version(&app_dir);
            let lines = human.then(|| {
                vec![format!(
                    "ssh-thing {} (app {}, data schema {})",
                    report.cli_version,
                    report.app_version.as_deref().unwrap_or("unknown"),
                    report.data_schema_version
                )]
            });
            emit_ok(name, report, lines)
        }
    }
}

fn emit_ok<T: Serialize>(command: &'static str, data: T, human_lines: Option<Vec<String>>) -> i32 {
    match human_lines {
        Some(lines) => print_lines(&lines),
        None => print_envelope(&Envelope::ok(command, data)),
    }
    commands::EXIT_OK
}

fn emit_err(command: &'static str, human: bool, failure: Failure) -> i32 {
    if human {
        let mut lines = vec![format!("error: {}", failure.error.message)];
        if let Some(hint) = &failure.error.hint {
            lines.push(format!("hint: {hint}"));
        }
        print_lines(&lines);
    } else {
        print_envelope(&Envelope::<serde_json::Value>::failed(
            command,
            failure.error,
        ));
    }
    failure.exit
}

fn print_envelope<T: Serialize>(envelope: &Envelope<T>) {
    output::print_json(envelope);
}

fn print_lines(lines: &[String]) {
    output::print_human(lines);
}
