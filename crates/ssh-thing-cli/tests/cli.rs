//! Integration tests for the `ssh-thing` binary.
//!
//! Every case runs the real binary against a fixture data directory
//! (`SSH_THING_DATA_DIR`) and asserts on the JSON envelope. Nothing here opens a
//! network connection: the gate, scope, and dry-run paths all resolve before any
//! SSH handshake, and the refusal paths must not connect at all.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_ssh-thing");

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str, allow_automation: bool) -> Self {
        let dir =
            std::env::temp_dir().join(format!("ssh-thing-cli-it-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create fixture dir");

        write(
            &dir.join("servers.json"),
            r#"[
              {
                "id": "srv-alpha",
                "nickname": "alpha",
                "host": "127.0.0.1",
                "port": 22,
                "user": "root",
                "auth": {
                  "type": "SecretRef",
                  "secret_id": "server:srv-alpha:password",
                  "kind": "Password"
                }
              },
              {
                "id": "srv-beta",
                "nickname": "beta",
                "host": "127.0.0.1",
                "port": 2222,
                "user": "root",
                "auth": {
                  "type": "SecretRef",
                  "secret_id": "server:srv-beta:password",
                  "kind": "Password"
                }
              }
            ]"#,
        );

        write(
            &dir.join("snippets.json"),
            r#"[
              {
                "id": "snip-alpha",
                "name": "Alpha uptime",
                "command": "uptime",
                "description": null,
                "server_id": "srv-alpha"
              },
              {
                "id": "snip-orphan",
                "name": "Orphan",
                "command": "uptime",
                "description": null,
                "server_id": "srv-gone"
              },
              {
                "id": "snip-global",
                "name": "Global",
                "command": "uptime",
                "description": null
              }
            ]"#,
        );

        write(
            &dir.join("settings.json"),
            &format!(r#"{{ "allow_external_automation": {} }}"#, allow_automation),
        );

        write(&dir.join("known_hosts.json"), "[]");

        Fixture { dir }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(BIN)
            .args(args)
            .env("SSH_THING_DATA_DIR", &self.dir)
            .output()
            .expect("run ssh-thing")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn write(path: &Path, contents: &str) {
    std::fs::write(path, contents).expect("write fixture file");
}

fn envelope(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout was not JSON ({error}).\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn exit_code(output: &Output) -> i32 {
    output.status.code().expect("process exited normally")
}

fn error_code(value: &Value) -> &str {
    value["error"]["code"].as_str().unwrap_or("<missing>")
}

#[test]
fn servers_lists_metadata_without_secret_values() {
    let fixture = Fixture::new("servers", false);
    let output = fixture.run(&["servers"]);
    assert_eq!(exit_code(&output), 0);

    let body = envelope(&output);
    assert_eq!(body["ok"], Value::Bool(true));
    assert_eq!(body["command"], "servers");

    let servers = body["data"].as_array().expect("data is an array");
    assert_eq!(servers.len(), 2);

    let alpha = servers
        .iter()
        .find(|server| server["id"] == "srv-alpha")
        .expect("alpha present");
    assert_eq!(alpha["label"], "alpha");
    assert_eq!(alpha["auth_kind"], "password");
    assert_eq!(alpha["scoped_snippet_count"], 1);
    assert_eq!(alpha["host_key_trusted"], Value::Bool(false));
    assert_eq!(
        alpha["secret_env_var"],
        "SSH_THING_SECRET_SERVER_SRV_ALPHA_PASSWORD"
    );

    // The raw response must not carry credential material. The only permitted
    // mention of a secret is the derived environment variable *name*.
    let raw = String::from_utf8_lossy(&output.stdout);
    assert!(!raw.contains("secret_id"));
    assert!(!raw.contains("password_hash"));
    assert!(!raw.contains("private_key\""));
}

#[test]
fn snippets_mark_each_entry_runnable_or_not() {
    let fixture = Fixture::new("snippets", false);
    let output = fixture.run(&["snippets", "--json"]);
    assert_eq!(exit_code(&output), 0);

    let body = envelope(&output);
    let snippets = body["data"].as_array().expect("data is an array");

    let by_id = |id: &str| {
        snippets
            .iter()
            .find(|snippet| snippet["id"] == id)
            .unwrap_or_else(|| panic!("{id} present"))
            .clone()
    };

    let alpha = by_id("snip-alpha");
    assert_eq!(alpha["runnable"], Value::Bool(true));
    assert_eq!(alpha["server_label"], "alpha");
    assert!(alpha["reason"].is_null());

    let orphan = by_id("snip-orphan");
    assert_eq!(orphan["runnable"], Value::Bool(false));
    assert_eq!(orphan["reason"], "server_missing");

    let global = by_id("snip-global");
    assert_eq!(global["runnable"], Value::Bool(false));
    assert_eq!(global["reason"], "not_scoped_to_a_server");
}

#[test]
fn snippets_can_be_filtered_by_server() {
    let fixture = Fixture::new("snippets-filter", false);

    let output = fixture.run(&["snippets", "--server", "alpha"]);
    assert_eq!(exit_code(&output), 0);
    let body = envelope(&output);
    let snippets = body["data"].as_array().expect("data is an array");
    assert_eq!(snippets.len(), 1);
    assert_eq!(snippets[0]["id"], "snip-alpha");

    let empty = fixture.run(&["snippets", "--server", "srv-beta"]);
    assert_eq!(exit_code(&empty), 0);
    assert!(envelope(&empty)["data"]
        .as_array()
        .expect("array")
        .is_empty());
}

#[test]
fn run_is_blocked_while_external_automation_is_off() {
    let fixture = Fixture::new("gate-off", false);

    let output = fixture.run(&["run", "--snippet", "Alpha uptime"]);
    assert_eq!(exit_code(&output), 3);

    let body = envelope(&output);
    assert_eq!(body["ok"], Value::Bool(false));
    assert_eq!(error_code(&body), "automation_disabled");
    assert!(body["error"]["hint"]
        .as_str()
        .expect("hint")
        .contains("Allow external automation"));
    assert!(body["data"].is_null());
}

#[test]
fn run_refuses_unscoped_snippets() {
    let fixture = Fixture::new("unscoped", true);

    let output = fixture.run(&["run", "--snippet", "snip-global"]);
    assert_eq!(exit_code(&output), 3);
    let body = envelope(&output);
    assert_eq!(error_code(&body), "not_scoped");
}

#[test]
fn run_refuses_cross_server_execution() {
    let fixture = Fixture::new("cross-server", true);

    let output = fixture.run(&["run", "--snippet", "Alpha uptime", "--server", "beta"]);
    assert_eq!(exit_code(&output), 3);

    let body = envelope(&output);
    assert_eq!(error_code(&body), "scope_mismatch");
    assert!(body["error"]["message"]
        .as_str()
        .expect("message")
        .contains("alpha"));
}

#[test]
fn run_refuses_a_snippet_whose_server_vanished() {
    let fixture = Fixture::new("server-missing", true);

    let output = fixture.run(&["run", "--snippet", "Orphan"]);
    assert_eq!(exit_code(&output), 3);
    let body = envelope(&output);
    assert_eq!(error_code(&body), "server_missing");
}

#[test]
fn dry_run_resolves_without_connecting_and_records_history() {
    let fixture = Fixture::new("dry-run", true);

    let output = fixture.run(&["run", "--snippet", "snip-alpha", "--dry-run"]);
    assert_eq!(exit_code(&output), 0);

    let body = envelope(&output);
    assert_eq!(body["ok"], Value::Bool(true));
    assert_eq!(body["data"]["dry_run"], Value::Bool(true));
    assert_eq!(body["data"]["status"], "dry_run");
    assert_eq!(body["data"]["command"], "uptime");
    assert_eq!(body["data"]["server"], "alpha");
    assert_eq!(body["data"]["timeout_seconds"], 60);
    assert_eq!(body["data"]["timeout_clamped"], Value::Bool(false));
    assert_eq!(body["data"]["output"], "");

    let history = fixture.run(&["history"]);
    assert_eq!(exit_code(&history), 0);
    let entries = envelope(&history);
    let entries = entries["data"].as_array().expect("history is an array");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["snippet_name"], "Alpha uptime");
    assert_eq!(entries[0]["dry_run"], Value::Bool(true));
}

#[test]
fn timeout_is_clamped_and_reported() {
    let fixture = Fixture::new("timeout-clamp", true);

    let output = fixture.run(&[
        "run",
        "--snippet",
        "snip-alpha",
        "--dry-run",
        "--timeout",
        "9000",
    ]);
    assert_eq!(exit_code(&output), 0);

    let body = envelope(&output);
    assert_eq!(body["data"]["timeout_seconds"], 600);
    assert_eq!(body["data"]["timeout_clamped"], Value::Bool(true));
}

#[test]
fn unknown_and_ambiguous_selectors_are_usage_errors() {
    let fixture = Fixture::new("selectors", true);

    let missing = fixture.run(&["run", "--snippet", "does-not-exist"]);
    assert_eq!(exit_code(&missing), 1);
    let body = envelope(&missing);
    assert_eq!(error_code(&body), "usage");
    assert!(body["error"]["hint"]
        .as_str()
        .expect("hint")
        .contains("ssh-thing snippets"));

    // "alpha" matches one server label, so resolving it as a snippet fails.
    let wrong_kind = fixture.run(&["run", "--snippet", "alpha"]);
    assert_eq!(exit_code(&wrong_kind), 1);
    assert_eq!(error_code(&envelope(&wrong_kind)), "usage");
}

#[test]
fn run_refuses_when_the_settings_file_is_unreadable() {
    let fixture = Fixture::new("settings-corrupt", true);
    // Valid JSON that is not a settings object: the gate file is unreadable.
    write(&fixture.dir.join("settings.json"), "null");

    let output = fixture.run(&["run", "--snippet", "snip-alpha"]);
    assert_eq!(exit_code(&output), 3);

    let body = envelope(&output);
    assert_eq!(error_code(&body), "settings_unreadable");
    assert!(body["error"]["hint"]
        .as_str()
        .expect("hint")
        .contains("doctor"));
    assert!(body["data"].is_null());
}

#[test]
fn timeout_floor_is_clamped_and_reported() {
    let fixture = Fixture::new("timeout-floor", true);

    let output = fixture.run(&[
        "run",
        "--snippet",
        "snip-alpha",
        "--dry-run",
        "--timeout",
        "1",
    ]);
    assert_eq!(exit_code(&output), 0);

    let body = envelope(&output);
    assert_eq!(body["data"]["timeout_seconds"], 5);
    assert_eq!(body["data"]["timeout_clamped"], Value::Bool(true));
}

#[test]
fn doctor_never_reports_runnable_while_the_gate_is_off() {
    let fixture = Fixture::new("doctor-gate", false);

    let output = fixture.run(&["doctor"]);
    assert_eq!(exit_code(&output), 0);

    let body = envelope(&output);
    assert_eq!(body["data"]["automation_enabled"], Value::Bool(false));
    assert_eq!(body["data"]["runnable"], Value::Bool(false));
    assert_eq!(body["data"]["data_dir_overridden"], Value::Bool(true));

    let checks = body["data"]["checks"].as_array().expect("checks");
    let settings_check = checks
        .iter()
        .find(|check| check["name"] == "settings_load")
        .expect("settings_load check present");
    assert_eq!(settings_check["ok"], Value::Bool(true));
}

#[test]
fn version_reports_the_schema_and_rejects_nothing() {
    let fixture = Fixture::new("version", false);
    let output = fixture.run(&["version"]);
    assert_eq!(exit_code(&output), 0);

    let body = envelope(&output);
    assert_eq!(body["data"]["data_schema_version"], 1);
    assert_eq!(body["data"]["app_identifier"], "com.kentaylor.ssh-thing");
    assert!(!body["data"]["cli_version"]
        .as_str()
        .expect("version")
        .is_empty());
}

#[test]
fn human_output_is_not_json_but_still_exits_zero() {
    let fixture = Fixture::new("human", false);
    let output = fixture.run(&["servers", "--human"]);
    assert_eq!(exit_code(&output), 0);

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("alpha"));
    assert!(!stdout.trim_start().starts_with('{'));
}
