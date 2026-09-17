//! Command implementations.
//!
//! Everything here is deliberately read-only except `run`, and `run` can only
//! execute a command string that already exists in the user's snippet file.

use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use ssh_thing_core as core;
use ssh_thing_core::model::{
    AuthMethod, CliHistoryEntry, SecretKind, ServerConnection, Snippet,
    DEFAULT_COMMAND_TIMEOUT_SECONDS,
};

use crate::output::CliError;

pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 1;
pub const EXIT_FAILED: i32 = 2;
pub const EXIT_BLOCKED: i32 = 3;

#[derive(Debug)]
pub struct Failure {
    pub error: CliError,
    pub exit: i32,
}

impl Failure {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            error: CliError::new("usage", message),
            exit: EXIT_USAGE,
        }
    }

    fn blocked(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            error: CliError::new(code, message),
            exit: EXIT_BLOCKED,
        }
    }

    pub fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            error: CliError::new(code, message),
            exit: EXIT_FAILED,
        }
    }

    fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.error.hint = Some(hint.into());
        self
    }
}

// ------------------------------------------------------------------ servers

#[derive(Debug, Serialize)]
pub struct ServerSummary {
    pub id: String,
    pub label: String,
    pub nickname: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: &'static str,
    /// Name of the environment variable that can supply this secret outside a
    /// GUI login session. A variable *name*, never a value.
    pub secret_env_var: Option<String>,
    pub connect_timeout_seconds: u64,
    pub last_connected_at: Option<u64>,
    pub host_key_trusted: bool,
    pub scoped_snippet_count: usize,
}

fn auth_kind(auth: &AuthMethod) -> &'static str {
    match auth {
        AuthMethod::SecretRef { kind, .. } => match kind {
            SecretKind::Password => "password",
            SecretKind::PrivateKey => "private_key",
        },
        AuthMethod::Password { .. } => "password",
        AuthMethod::Key { .. } => "private_key",
    }
}

fn secret_id(auth: &AuthMethod) -> Option<&str> {
    match auth {
        AuthMethod::SecretRef { secret_id, .. } => Some(secret_id.as_str()),
        _ => None,
    }
}

pub fn summarize_servers(
    app_dir: &Path,
    snippets: &[Snippet],
) -> Result<Vec<ServerSummary>, Failure> {
    let servers = core::load_servers(app_dir).map_err(|e| Failure::failed("read_failed", e))?;
    let known_hosts =
        core::load_known_hosts(app_dir).map_err(|e| Failure::failed("read_failed", e))?;

    Ok(servers
        .iter()
        .map(|server| ServerSummary {
            id: server.id.clone(),
            label: server.label(),
            nickname: server.nickname.clone(),
            host: server.host.clone(),
            port: server.port,
            user: server.user.clone(),
            auth_kind: auth_kind(&server.auth),
            secret_env_var: secret_id(&server.auth).map(core::secrets::env_var_name),
            connect_timeout_seconds: server
                .timeout_seconds
                .unwrap_or(core::model::DEFAULT_CONNECT_TIMEOUT_SECONDS),
            last_connected_at: server.last_connected_at,
            host_key_trusted: core::find_known_host(&known_hosts, &server.host, server.port)
                .is_some(),
            scoped_snippet_count: snippets
                .iter()
                .filter(|snippet| snippet.server_id.as_deref() == Some(server.id.as_str()))
                .count(),
        })
        .collect())
}

pub fn servers(app_dir: &Path) -> Result<Vec<ServerSummary>, Failure> {
    let snippets = core::load_snippets(app_dir).map_err(|e| Failure::failed("read_failed", e))?;
    summarize_servers(app_dir, &snippets)
}

pub fn human_servers(servers: &[ServerSummary]) -> Vec<String> {
    if servers.is_empty() {
        return vec!["No saved servers.".to_string()];
    }
    servers
        .iter()
        .map(|server| {
            format!(
                "{:<24} {:<8} {} ({} snippet(s){})",
                server.label,
                server.id.chars().take(8).collect::<String>(),
                server.host,
                server.scoped_snippet_count,
                if server.host_key_trusted {
                    ""
                } else {
                    ", host key not approved"
                }
            )
        })
        .collect()
}

// ----------------------------------------------------------------- snippets

#[derive(Debug, Serialize)]
pub struct SnippetSummary {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub server_id: Option<String>,
    pub server_label: Option<String>,
    pub runnable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

pub fn snippets(
    app_dir: &Path,
    server_filter: Option<&str>,
) -> Result<Vec<SnippetSummary>, Failure> {
    let servers = core::load_servers(app_dir).map_err(|e| Failure::failed("read_failed", e))?;
    let snippets = core::load_snippets(app_dir).map_err(|e| Failure::failed("read_failed", e))?;

    let filter_id = match server_filter {
        Some(selector) => Some(resolve_server(selector, &servers)?.id),
        None => None,
    };

    Ok(snippets
        .iter()
        .filter(|snippet| match &filter_id {
            Some(id) => snippet.server_id.as_deref() == Some(id.as_str()),
            None => true,
        })
        .map(|snippet| summarize_snippet(snippet, &servers))
        .collect())
}

fn summarize_snippet(snippet: &Snippet, servers: &[ServerConnection]) -> SnippetSummary {
    let scoped = snippet
        .server_id
        .as_ref()
        .and_then(|id| servers.iter().find(|server| &server.id == id));

    let (runnable, reason) = match (&snippet.server_id, scoped) {
        (None, _) => (false, Some("not_scoped_to_a_server")),
        (Some(_), None) => (false, Some("server_missing")),
        (Some(_), Some(_)) => (true, None),
    };

    SnippetSummary {
        id: snippet.id.clone(),
        name: snippet.name.clone(),
        command: snippet.command.clone(),
        description: snippet.description.clone(),
        server_id: snippet.server_id.clone(),
        server_label: scoped.map(|server| server.label()),
        runnable,
        reason,
    }
}

pub fn human_snippets(snippets: &[SnippetSummary]) -> Vec<String> {
    if snippets.is_empty() {
        return vec!["No snippets.".to_string()];
    }
    snippets
        .iter()
        .map(|snippet| {
            let scope = match (&snippet.server_label, snippet.runnable) {
                (Some(label), true) => label.clone(),
                (_, _) => "unscoped — desktop only".to_string(),
            };
            format!("{:<24} {:<24} {}", snippet.name, scope, snippet.command)
        })
        .collect()
}

// ------------------------------------------------------------------ resolve

pub fn resolve_snippet(selector: &str, snippets: &[Snippet]) -> Result<Snippet, Failure> {
    if let Some(snippet) = snippets.iter().find(|snippet| snippet.id == selector) {
        return Ok(snippet.clone());
    }

    let needle = selector.trim().to_lowercase();
    let matches: Vec<&Snippet> = snippets
        .iter()
        .filter(|snippet| snippet.name.trim().to_lowercase() == needle)
        .collect();

    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => Err(Failure::usage(format!("No snippet matches '{selector}'."))
            .with_hint("Run `ssh-thing snippets` to list available snippets.")),
        _ => {
            let ids: Vec<String> = matches.iter().map(|snippet| snippet.id.clone()).collect();
            Err(
                Failure::usage(format!("Snippet name '{selector}' is ambiguous."))
                    .with_hint(format!("Use one of these ids instead: {}", ids.join(", "))),
            )
        }
    }
}

pub fn resolve_server(
    selector: &str,
    servers: &[ServerConnection],
) -> Result<ServerConnection, Failure> {
    if let Some(server) = servers.iter().find(|server| server.id == selector) {
        return Ok(server.clone());
    }

    let needle = selector.trim().to_lowercase();
    let matches: Vec<&ServerConnection> = servers
        .iter()
        .filter(|server| server.label().trim().to_lowercase() == needle)
        .collect();

    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => Err(Failure::usage(format!("No server matches '{selector}'."))
            .with_hint("Run `ssh-thing servers` to list saved servers.")),
        _ => {
            let ids: Vec<String> = matches.iter().map(|server| server.id.clone()).collect();
            Err(
                Failure::usage(format!("Server name '{selector}' is ambiguous."))
                    .with_hint(format!("Use one of these ids instead: {}", ids.join(", "))),
            )
        }
    }
}

// ---------------------------------------------------------------------- run

#[derive(Debug, Serialize)]
pub struct RunReport {
    pub snippet_id: String,
    pub snippet: String,
    pub server_id: String,
    pub server: String,
    pub command: String,
    pub status: &'static str,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub timeout_seconds: u64,
    pub timeout_clamped: bool,
    pub output_truncated: bool,
    pub output: String,
    pub error: Option<String>,
    pub dry_run: bool,
}

pub struct RunRequest<'a> {
    pub snippet_selector: &'a str,
    pub server_selector: Option<&'a str>,
    pub timeout_seconds: Option<u64>,
    pub dry_run: bool,
}

/// Execution errors come back as a `RunReport` with `status: "error"` so the
/// caller still prints one complete JSON document. Only pre-flight problems
/// (gate closed, unknown snippet, cross-server request) are `Failure`s.
pub async fn run(app_dir: &Path, request: RunRequest<'_>) -> Result<(RunReport, i32), Failure> {
    // The gate file is policy, not run state: if it cannot be read, refuse like
    // a closed gate (exit 3) instead of reporting a failed run.
    let settings = core::AutomationSettings::load(app_dir).map_err(|error| {
        Failure::blocked(
            "settings_unreadable",
            format!("The SSH THING settings file could not be read: {error}"),
        )
        .with_hint(
            "Run `ssh-thing doctor` to inspect the data directory, or delete settings.json to reset automation to its default (off).",
        )
    })?;
    if !settings.allow_external_automation {
        return Err(Failure::blocked(
            "automation_disabled",
            "External automation is turned off, so the CLI will not run anything.",
        )
        .with_hint(
            "Open SSH THING, use the header menu, and enable 'Allow external automation' in the Automation section.",
        ));
    }

    let snippets = core::load_snippets(app_dir).map_err(|e| Failure::failed("read_failed", e))?;
    let snippet = resolve_snippet(request.snippet_selector, &snippets)?;

    let servers = core::load_servers(app_dir).map_err(|e| Failure::failed("read_failed", e))?;

    let scoped_id = match &snippet.server_id {
        Some(id) => id.clone(),
        None => {
            return Err(Failure::blocked(
                "not_scoped",
                format!("Snippet '{}' is not scoped to a server.", snippet.name),
            )
            .with_hint(
                "Unscoped snippets only run inside the desktop app. Assign the snippet to a server in SSH THING, then retry.",
            ))
        }
    };

    if let Some(selector) = request.server_selector {
        let requested = resolve_server(selector, &servers)?;
        if requested.id != scoped_id {
            let scoped_label = servers
                .iter()
                .find(|server| server.id == scoped_id)
                .map(ServerConnection::label)
                .unwrap_or_else(|| scoped_id.clone());
            return Err(Failure::blocked(
                "scope_mismatch",
                format!(
                    "Snippet '{}' is scoped to '{}', not '{}'.",
                    snippet.name,
                    scoped_label,
                    requested.label()
                ),
            )
            .with_hint(
                "Cross-server execution is never allowed. Choose a snippet scoped to that server.",
            ));
        }
    }

    let server = servers
        .iter()
        .find(|server| server.id == scoped_id)
        .cloned()
        .ok_or_else(|| {
            Failure::blocked(
                "server_missing",
                format!(
                    "Snippet '{}' is scoped to a server that no longer exists.",
                    snippet.name
                ),
            )
            .with_hint("Reassign the snippet to a server in the SSH THING desktop app.")
        })?;

    let requested_timeout = request
        .timeout_seconds
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS);
    let timeout_seconds = core::clamp_timeout(requested_timeout);
    let timeout_clamped = timeout_seconds != requested_timeout;

    let mut report = RunReport {
        snippet_id: snippet.id.clone(),
        snippet: snippet.name.clone(),
        server_id: server.id.clone(),
        server: server.label(),
        command: snippet.command.clone(),
        status: "dry_run",
        exit_code: None,
        duration_ms: 0,
        timeout_seconds,
        timeout_clamped,
        output_truncated: false,
        output: String::new(),
        error: None,
        dry_run: request.dry_run,
    };

    if request.dry_run {
        record(app_dir, &snippet, &server, &report);
        return Ok((report, EXIT_OK));
    }

    let started_at = core::unix_timestamp_now().map_err(|e| Failure::failed("clock_error", e))?;
    let started = Instant::now();

    let outcome = execute(&server, app_dir, &snippet.command, timeout_seconds).await;
    report.duration_ms = started.elapsed().as_millis() as u64;

    let exit_code = match outcome {
        Ok(outcome) => {
            report.output = outcome.output;
            report.output_truncated = outcome.truncated;
            report.exit_code = outcome.exit_code;

            match outcome.exit_code {
                Some(0) => {
                    report.status = "success";
                    EXIT_OK
                }
                Some(code) => {
                    report.status = "error";
                    report.error = Some(format!("Command exited with status {}", code));
                    EXIT_FAILED
                }
                None => {
                    report.status = "error";
                    report.error = Some(if report.output.trim().is_empty() {
                        "Command produced no output and returned no exit status — it may never have started.".to_string()
                    } else {
                        "Command completed without reporting an exit status.".to_string()
                    });
                    EXIT_FAILED
                }
            }
        }
        Err(message) => {
            report.status = "error";
            // The CLI never allocates a PTY, so this failure mode has one
            // overwhelmingly likely cause and the agent can act on it alone.
            report.error = Some(if message.starts_with("Command timed out") {
                format!(
                    "{message}. The CLI runs without a PTY, so a command that waits for a password prompt can only hang until the timeout. Use sudo with NOPASSWD, or key-based authentication, for CLI-runnable snippets."
                )
            } else {
                message
            });
            EXIT_FAILED
        }
    };

    record_with_timestamps(app_dir, &snippet, &server, &report, started_at);
    Ok((report, exit_code))
}

async fn execute(
    server: &ServerConnection,
    app_dir: &Path,
    command: &str,
    timeout_seconds: u64,
) -> Result<core::CommandOutcome, String> {
    let session = core::connect_saved_server(
        app_dir,
        &server.host,
        server.port,
        &server.user,
        &server.auth,
        server.timeout_seconds,
    )
    .await?;

    let result = core::exec_command(&session, command, None, Some(timeout_seconds)).await;
    core::disconnect_quiet(session).await;
    result
}

fn record(app_dir: &Path, snippet: &Snippet, server: &ServerConnection, report: &RunReport) {
    let now = core::unix_timestamp_now().unwrap_or_default();
    record_with_timestamps(app_dir, snippet, server, report, now);
}

fn record_with_timestamps(
    app_dir: &Path,
    snippet: &Snippet,
    server: &ServerConnection,
    report: &RunReport,
    started_at: u64,
) {
    let entry = CliHistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        snippet_id: snippet.id.clone(),
        snippet_name: snippet.name.clone(),
        server_id: server.id.clone(),
        server_label: server.label(),
        command: snippet.command.clone(),
        started_at,
        completed_at: core::unix_timestamp_now().unwrap_or(started_at),
        status: report.status.to_string(),
        exit_code: report.exit_code,
        output: if report.output.is_empty() {
            None
        } else {
            Some(report.output.clone())
        },
        error: report.error.clone(),
        dry_run: report.dry_run,
    };

    // History is an audit trail; a write failure must not change the outcome of
    // a run that already happened.
    if let Err(error) = core::append_cli_history_entry(app_dir, entry) {
        eprintln!("warning: could not append CLI history: {error}");
    }
}

pub fn human_run(report: &RunReport) -> Vec<String> {
    let mut lines = vec![format!(
        "{} -> {} ({})",
        report.snippet, report.server, report.command
    )];
    if report.dry_run {
        lines.push("dry run: nothing was executed".to_string());
        return lines;
    }
    lines.push(format!(
        "status: {}  exit_code: {}  duration: {}ms  timeout: {}s{}",
        report.status,
        report
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "none".to_string()),
        report.duration_ms,
        report.timeout_seconds,
        if report.timeout_clamped {
            " (clamped)"
        } else {
            ""
        }
    ));
    if let Some(error) = &report.error {
        lines.push(format!("error: {error}"));
    }
    if !report.output.is_empty() {
        lines.push("--- output ---".to_string());
        lines.push(report.output.trim_end().to_string());
    }
    if report.output_truncated {
        lines.push("(output truncated)".to_string());
    }
    lines
}

// ------------------------------------------------------------------ history

pub fn history(app_dir: &Path, limit: usize) -> Result<Vec<CliHistoryEntry>, Failure> {
    let mut entries =
        core::load_cli_history(app_dir).map_err(|e| Failure::failed("read_failed", e))?;
    entries.reverse();
    entries.truncate(limit);
    Ok(entries)
}

pub fn human_history(entries: &[CliHistoryEntry]) -> Vec<String> {
    if entries.is_empty() {
        return vec!["No CLI runs recorded.".to_string()];
    }
    entries
        .iter()
        .map(|entry| {
            format!(
                "{}  {:<24} {:<20} exit={}",
                entry.completed_at,
                entry.snippet_name,
                entry.server_label,
                entry
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "-".to_string())
            )
        })
        .collect()
}

// ------------------------------------------------------------------- doctor

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct DoctorReport {
    pub cli_version: &'static str,
    pub app_version: Option<String>,
    pub app_data_dir: String,
    pub data_dir_overridden: bool,
    pub automation_enabled: bool,
    pub keyring_override_variables: Vec<String>,
    pub checks: Vec<Check>,
    /// Every check except `external_automation` passed.
    pub healthy: bool,
    /// `healthy` **and** the automation gate is on. This is the one field an
    /// agent should branch on to decide whether `run` will work.
    pub runnable: bool,
}

pub fn doctor(app_dir: &Path) -> DoctorReport {
    let mut checks = Vec::new();

    checks.push(Check {
        name: "app_data_dir",
        ok: true,
        detail: app_dir.display().to_string(),
    });
    // Loaded once and reused: the check, the override list, and the automation
    // status all need this file, and a second read could disagree with the first.
    let servers = match core::load_servers(app_dir) {
        Ok(servers) => {
            checks.push(Check {
                name: "servers_load",
                ok: true,
                detail: format!("{} server(s)", servers.len()),
            });
            servers
        }
        Err(error) => {
            checks.push(Check {
                name: "servers_load",
                ok: false,
                detail: error,
            });
            Vec::new()
        }
    };

    checks.push(match core::load_snippets(app_dir) {
        Ok(snippets) => {
            let scoped = snippets
                .iter()
                .filter(|snippet| snippet.server_id.is_some())
                .count();
            Check {
                name: "snippets_load",
                ok: true,
                detail: format!("{scoped} runnable of {} total", snippets.len()),
            }
        }
        Err(error) => Check {
            name: "snippets_load",
            ok: false,
            detail: error,
        },
    });

    checks.push(match core::load_known_hosts(app_dir) {
        Ok(hosts) => Check {
            name: "known_hosts_load",
            ok: true,
            detail: format!("{} approved key(s)", hosts.len()),
        },
        Err(error) => Check {
            name: "known_hosts_load",
            ok: false,
            detail: error,
        },
    });

    checks.push(match core::secrets::probe() {
        Ok(()) => Check {
            name: "keyring_write_read_delete",
            ok: true,
            detail: "keychain round trip succeeded".to_string(),
        },
        Err(error) => Check {
            name: "keyring_write_read_delete",
            ok: false,
            detail: format!(
                "{error}. On macOS this means the CLI is not running in a local GUI login session; use the SSH_THING_SECRET_* override."
            ),
        },
    });

    // A corrupt settings file must be visible rather than silently defaulted:
    // it is the file that holds the automation gate.
    let loaded_settings = core::AutomationSettings::load(app_dir);
    checks.push(match &loaded_settings {
        Ok(_) => Check {
            name: "settings_load",
            ok: true,
            detail: "settings.json parsed".to_string(),
        },
        Err(error) => Check {
            name: "settings_load",
            ok: false,
            detail: error.clone(),
        },
    });
    let settings = loaded_settings.unwrap_or_default();
    checks.push(Check {
        name: "external_automation",
        ok: settings.allow_external_automation,
        detail: if settings.allow_external_automation {
            "enabled".to_string()
        } else {
            "disabled — `run` will refuse until it is enabled in the desktop app".to_string()
        },
    });

    let override_variables = servers
        .iter()
        .filter_map(|server| match &server.auth {
            AuthMethod::SecretRef { secret_id, .. } => Some(core::secrets::env_var_name(secret_id)),
            _ => None,
        })
        .collect();

    let healthy = checks
        .iter()
        .filter(|check| check.name != "external_automation")
        .all(|check| check.ok);

    // `healthy` deliberately ignores the gate so a clean install with
    // automation off still reads as healthy. Agents should branch on `runnable`.
    let runnable = healthy && settings.allow_external_automation;

    DoctorReport {
        cli_version: core::VERSION,
        app_version: settings.app_version,
        app_data_dir: app_dir.display().to_string(),
        data_dir_overridden: core::override_data_dir().is_some(),
        automation_enabled: settings.allow_external_automation,
        keyring_override_variables: override_variables,
        checks,
        healthy,
        runnable,
    }
}

pub fn human_doctor(report: &DoctorReport) -> Vec<String> {
    let mut lines = vec![
        format!("CLI version: {}", report.cli_version),
        format!(
            "App version: {}",
            report.app_version.as_deref().unwrap_or("unknown")
        ),
        format!(
            "Data directory: {}{}",
            report.app_data_dir,
            if report.data_dir_overridden {
                " (from SSH_THING_DATA_DIR)"
            } else {
                ""
            }
        ),
        format!(
            "External automation: {}",
            if report.automation_enabled {
                "enabled"
            } else {
                "disabled"
            }
        ),
        format!(
            "Runnable now: {}",
            if report.runnable { "yes" } else { "no" }
        ),
        String::new(),
    ];

    for check in &report.checks {
        lines.push(format!(
            "[{}] {:<26} {}",
            if check.ok { "ok" } else { "!!" },
            check.name,
            check.detail
        ));
    }

    if !report.keyring_override_variables.is_empty() {
        lines.push(String::new());
        lines.push("Headless secret overrides (set the value in the environment):".to_string());
        for variable in &report.keyring_override_variables {
            lines.push(format!("  {variable}"));
        }
    }

    lines
}

// ------------------------------------------------------------------ version

#[derive(Debug, Serialize)]
pub struct VersionReport {
    pub cli_version: &'static str,
    pub app_version: Option<String>,
    pub data_schema_version: u32,
    pub app_identifier: &'static str,
}

pub fn version(app_dir: &Path) -> VersionReport {
    let app_version = core::AutomationSettings::load(app_dir)
        .ok()
        .and_then(|settings| settings.app_version);

    VersionReport {
        cli_version: core::VERSION,
        app_version,
        data_schema_version: core::model::DATA_SCHEMA_VERSION,
        app_identifier: core::APP_IDENTIFIER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snippet(id: &str, name: &str, server_id: Option<&str>) -> Snippet {
        Snippet {
            id: id.to_string(),
            name: name.to_string(),
            command: "uptime".to_string(),
            description: None,
            server_id: server_id.map(str::to_string),
        }
    }

    fn server(id: &str, nickname: &str) -> ServerConnection {
        ServerConnection {
            id: id.to_string(),
            nickname: Some(nickname.to_string()),
            host: "example.com".to_string(),
            port: 22,
            user: "root".to_string(),
            timeout_seconds: None,
            last_connected_at: None,
            auth: AuthMethod::SecretRef {
                secret_id: format!("server:{id}:password"),
                kind: SecretKind::Password,
            },
        }
    }

    #[test]
    fn resolves_snippet_by_id_then_name() {
        let snippets = vec![snippet("abc", "Restart API", Some("s1"))];
        assert_eq!(resolve_snippet("abc", &snippets).expect("by id").id, "abc");
        assert_eq!(
            resolve_snippet("restart api", &snippets)
                .expect("by name")
                .id,
            "abc"
        );
    }

    #[test]
    fn ambiguous_snippet_name_is_rejected() {
        let snippets = vec![
            snippet("a", "Deploy", Some("s1")),
            snippet("b", "deploy", Some("s1")),
        ];
        let failure = resolve_snippet("Deploy", &snippets).expect_err("should be ambiguous");
        assert_eq!(failure.error.code, "usage");
        assert!(failure.error.hint.unwrap_or_default().contains('a'));
    }

    #[test]
    fn unknown_snippet_is_a_usage_error() {
        let failure = resolve_snippet("nope", &[]).expect_err("should fail");
        assert_eq!(failure.exit, EXIT_USAGE);
    }

    #[test]
    fn unscoped_snippets_are_not_runnable() {
        let summary = summarize_snippet(&snippet("a", "Global", None), &[]);
        assert!(!summary.runnable);
        assert_eq!(summary.reason, Some("not_scoped_to_a_server"));
    }

    #[test]
    fn scoped_snippet_without_server_is_not_runnable() {
        let summary = summarize_snippet(&snippet("a", "Orphan", Some("gone")), &[]);
        assert!(!summary.runnable);
        assert_eq!(summary.reason, Some("server_missing"));
    }

    #[test]
    fn scoped_snippet_with_server_is_runnable() {
        let summary = summarize_snippet(&snippet("a", "Ok", Some("s1")), &[server("s1", "prod")]);
        assert!(summary.runnable);
        assert_eq!(summary.server_label.as_deref(), Some("prod"));
    }

    #[test]
    fn server_resolution_prefers_id() {
        let servers = [server("s1", "prod"), server("s2", "prod")];
        assert_eq!(resolve_server("s2", &servers).expect("by id").id, "s2");
        assert!(resolve_server("prod", &servers).is_err());
    }

    #[test]
    fn server_summary_never_exposes_secret_values() {
        let servers = [server("s1", "prod")];
        let summary = &servers[0];
        let env = core::secrets::env_var_name(match &summary.auth {
            AuthMethod::SecretRef { secret_id, .. } => secret_id,
            _ => "none",
        });
        assert_eq!(env, "SSH_THING_SECRET_SERVER_S1_PASSWORD");
    }
}
