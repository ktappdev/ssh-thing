//! Stable JSON envelope for every CLI response.
//!
//! One shape for success and failure keeps the contract trivial for an LLM:
//! always parse the same object, branch on `ok`, then read `data` or `error`.

use serde::Serialize;
use std::io::Write;

#[derive(Debug, Clone, Serialize)]
pub struct CliError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl CliError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Envelope<T: Serialize> {
    pub ok: bool,
    pub command: &'static str,
    pub error: Option<CliError>,
    pub data: Option<T>,
}

impl<T: Serialize> Envelope<T> {
    pub fn ok(command: &'static str, data: T) -> Self {
        Self {
            ok: true,
            command,
            error: None,
            data: Some(data),
        }
    }

    pub fn failed(command: &'static str, error: CliError) -> Self {
        Self {
            ok: false,
            command,
            error: Some(error),
            data: None,
        }
    }

    /// A command that ran far enough to produce a result, but did not succeed.
    /// `ok` mirrors the outcome so callers can branch on it, while `data` still
    /// carries the full report for diagnosis.
    pub fn failed_with_data(command: &'static str, error: CliError, data: T) -> Self {
        Self {
            ok: false,
            command,
            error: Some(error),
            data: Some(data),
        }
    }
}

/// Print an envelope as pretty JSON on stdout.
///
/// Pretty rather than compact because the consumer is a language model reading
/// a transcript, and a one-line 64 KiB JSON string is materially worse to read.
pub fn print_json<T: Serialize>(envelope: &Envelope<T>) {
    match serde_json::to_string_pretty(envelope) {
        Ok(rendered) => {
            println!("{rendered}");
        }
        Err(error) => {
            // Serialization of these types cannot realistically fail; if it
            // does, still emit a parseable envelope rather than panicking.
            println!(
                "{{\"ok\":false,\"command\":\"{}\",\"error\":{{\"code\":\"serialization_failed\",\"message\":{}}},\"data\":null}}",
                envelope.command,
                serde_json::Value::String(error.to_string())
            );
        }
    }
}

pub fn print_human(lines: &[String]) {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    for line in lines {
        let _ = writeln!(handle, "{line}");
    }
}
