//! Install, update, and remove the `ssh-thing` CLI from the desktop app.
//!
//! This lives in Rust rather than the frontend on purpose: the `fs` capability
//! granted to the webview is read-only (`create-app-specific-dirs` +
//! `read-app-specific-dirs-recursive`), so JavaScript physically cannot write a
//! binary to `~/.local/bin`. Tauri commands bypass the capability ACL, which
//! also means no new permissions are needed.
//!
//! The installer verifies the published SHA-256 for the asset and fails closed.
//! It never elevates — the target is the user's own `~/.local/bin`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use ssh_thing_core::{paths, AutomationSettings};

const REPOSITORY: &str = "ktappdev/ssh-thing";
const BINARY_NAME: &str = "ssh-thing";
const DOWNLOAD_TIMEOUT_SECONDS: u64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliStatus {
    /// Version this app would install, i.e. the app's own version.
    pub expected_version: String,
    /// True when a prebuilt CLI exists for this OS/architecture.
    pub supported: bool,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub update_available: bool,
    pub on_path: bool,
    pub install_dir: String,
    pub automation_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliInstallResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub checksum_verified: bool,
    pub quarantine_cleared: bool,
    /// Set when the install directory is not on `PATH`. We print this instead
    /// of editing shell rc files behind the user's back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    MacOsAarch64,
    MacOsX64,
    LinuxX64,
}

impl Platform {
    fn detect() -> Option<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => Some(Platform::MacOsAarch64),
            ("macos", "x86_64") => Some(Platform::MacOsX64),
            ("linux", "x86_64") => Some(Platform::LinuxX64),
            _ => None,
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Platform::MacOsAarch64 => "macos-aarch64",
            Platform::MacOsX64 => "macos-x64",
            Platform::LinuxX64 => "linux-x64",
        }
    }
}

fn platform_label() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn unsupported_reason() -> String {
    format!(
        "No prebuilt CLI is published for {} yet. Build it from source with `cargo build --release -p ssh-thing-cli`.",
        platform_label()
    )
}

fn asset_name(platform: Platform, version: &str) -> String {
    format!("{BINARY_NAME}_{version}_{}", platform.slug())
}

fn release_base(version: &str) -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/v{version}")
}

fn install_dir() -> Result<PathBuf, String> {
    Ok(paths::home_dir()?.join(".local").join("bin"))
}

fn install_path() -> Result<PathBuf, String> {
    Ok(install_dir()?.join(BINARY_NAME))
}

fn directory_on_path(dir: &Path) -> bool {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).any(|entry| entry == dir))
        .unwrap_or(false)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))
}

#[tauri::command]
pub async fn cli_status(app: AppHandle) -> Result<CliStatus, String> {
    let platform = Platform::detect();
    let version = ssh_thing_core::VERSION.to_string();
    let dir = install_dir()?;
    let settings = AutomationSettings::load(&app_data_dir(&app)?)?;

    let mut candidates = vec![dir.join(BINARY_NAME)];
    candidates.extend(recorded_path(&settings));
    let installed_path = candidates.into_iter().find(|candidate| candidate.is_file());

    let installed_version = installed_path.as_deref().and_then(probe_version);
    let installed = installed_path.is_some();
    let update_available = needs_update(installed, installed_version.as_deref(), &version);

    let (asset, url) = match platform {
        Some(platform) => {
            let asset = asset_name(platform, &version);
            let url = format!("{}/{}", release_base(&version), asset);
            (Some(asset), Some(url))
        }
        None => (None, None),
    };

    Ok(CliStatus {
        expected_version: version.clone(),
        supported: platform.is_some(),
        platform: platform_label(),
        unsupported_reason: platform.is_none().then(unsupported_reason),
        asset_name: asset,
        download_url: url,
        installed,
        path: installed_path.map(|value| value.display().to_string()),
        update_available,
        version: installed_version,
        on_path: directory_on_path(&dir),
        install_dir: dir.display().to_string(),
        automation_enabled: settings.allow_external_automation,
    })
}

#[tauri::command]
pub async fn install_cli(app: AppHandle) -> Result<CliInstallResult, String> {
    let platform = Platform::detect().ok_or_else(unsupported_reason)?;
    let version = ssh_thing_core::VERSION.to_string();
    let asset = asset_name(platform, &version);
    let base = release_base(&version);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECONDS))
        .user_agent(format!("ssh-thing/{}", ssh_thing_core::VERSION))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    // Checksum first: refuse to keep bytes we cannot verify.
    let expected_checksum =
        fetch_checksum(&client, &format!("{base}/{asset}.sha256"), &version).await?;

    let bytes = client
        .get(format!("{base}/{asset}"))
        .send()
        .await
        .map_err(|error| describe_download_error("binary", &asset, &version, error))?
        .error_for_status()
        .map_err(|error| describe_download_error("binary", &asset, &version, error))?
        .bytes()
        .await
        .map_err(|error| format!("Failed to read the downloaded binary: {error}"))?;

    let actual_checksum = hex::encode(Sha256::digest(&bytes));
    if actual_checksum != expected_checksum {
        return Err(format!(
            "Checksum mismatch for {asset}. Expected {expected_checksum}, got {actual_checksum}. Nothing was installed."
        ));
    }

    let dir = install_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    let destination = dir.join(BINARY_NAME);
    // Stage through a temporary file so a partial write can never be executed.
    let staged = dir.join(format!(".{BINARY_NAME}.download"));
    std::fs::write(&staged, &bytes)
        .map_err(|e| format!("Failed to write {}: {e}", staged.display()))?;
    set_executable(&staged)?;
    std::fs::rename(&staged, &destination).map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        format!("Failed to install to {}: {e}", destination.display())
    })?;

    let quarantine_cleared = clear_quarantine(&destination);

    // Smoke test: if the binary cannot report its version, the install is not
    // usable and we say so instead of claiming success.
    let installed_version = probe_version(&destination);

    let mut settings = AutomationSettings::load(&app_data_dir(&app)?)?;
    settings.cli_install_path = Some(destination.display().to_string());
    settings.cli_installed_version = installed_version.clone();
    settings.save(&app_data_dir(&app)?)?;

    let path_hint = if directory_on_path(&dir) {
        None
    } else {
        Some(format!(
            "Add {} to your PATH: export PATH=\"{}:$PATH\"",
            dir.display(),
            dir.display()
        ))
    };

    Ok(CliInstallResult {
        path: destination.display().to_string(),
        version: installed_version,
        checksum_verified: true,
        quarantine_cleared,
        path_hint,
    })
}

#[tauri::command]
pub async fn uninstall_cli(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    let settings = AutomationSettings::load(&dir)?;

    let mut candidates = vec![install_path()?];
    candidates.extend(recorded_path(&settings));

    for candidate in candidates {
        if candidate.is_file() {
            std::fs::remove_file(&candidate)
                .map_err(|e| format!("Failed to remove {}: {e}", candidate.display()))?;
        }
    }

    let mut updated = settings;
    updated.cli_install_path = None;
    updated.cli_installed_version = None;
    updated.save(&dir)?;

    Ok(())
}

/// Record the running app version so the CLI can report an app/CLI mismatch.
pub fn stamp_app_version(app_dir: &Path, version: &str) -> Result<(), String> {
    let mut settings = AutomationSettings::load(app_dir)?;
    settings.app_version = Some(version.to_string());
    settings.save(app_dir)
}

/// Whether the app should offer to install or update.
///
/// Comparing versions alone would report "update available" on a machine with
/// no CLI installed at all. An installed binary that cannot report its own
/// version also needs attention, so that counts as needing an update.
fn needs_update(installed: bool, installed_version: Option<&str>, expected: &str) -> bool {
    installed && installed_version != Some(expected)
}

fn recorded_path(settings: &AutomationSettings) -> Option<PathBuf> {
    settings.cli_install_path.as_ref().map(PathBuf::from)
}

async fn fetch_checksum(
    client: &reqwest::Client,
    url: &str,
    version: &str,
) -> Result<String, String> {
    let body = client
        .get(url)
        .send()
        .await
        .map_err(|error| describe_download_error("checksum", url, version, error))?
        .error_for_status()
        .map_err(|error| describe_download_error("checksum", url, version, error))?
        .text()
        .await
        .map_err(|error| format!("Failed to read the checksum file: {error}"))?;

    parse_checksum(&body).ok_or_else(|| {
        format!(
            "The published checksum file for {url} is not in a recognised format, so the download was not installed."
        )
    })
}

/// Turn a download failure into something the person reading it can act on.
///
/// The overwhelmingly common case before a first release is a 404: the app is
/// newer than anything published, so there is no binary to fetch yet. Saying
/// "HTTP status client error (404 Not Found)" leaves the user stuck; saying why
/// and offering the from-source path does not.
fn describe_download_error(
    what: &str,
    subject: &str,
    version: &str,
    error: reqwest::Error,
) -> String {
    let from_source = FROM_SOURCE_HINT;

    if error.status() == Some(reqwest::StatusCode::NOT_FOUND) {
        return not_published_message(what, version);
    }

    if error.is_timeout() {
        return format!(
            "Timed out downloading the CLI {what} ({subject}). Check the network, then retry. {from_source}"
        );
    }

    if error.is_connect() {
        return format!(
            "Could not reach GitHub to download the CLI {what} ({subject}). Check the network, then retry. {from_source}"
        );
    }

    format!("Failed to download the CLI {what} ({subject}): {error}")
}

const FROM_SOURCE_HINT: &str =
    "Build it locally instead: `cargo build --release -p ssh-thing-cli`.";

/// The message for "this version has no published CLI asset".
///
/// Split out from [`describe_download_error`] because it is the guaranteed
/// state of the world until the first release carrying CLI binaries exists, and
/// it is the one download failure a user is most likely to meet.
fn not_published_message(what: &str, version: &str) -> String {
    format!(
        "No CLI {what} is published for version {version} yet, so nothing was installed. \
Release assets only exist after the release workflow finishes for that version. {FROM_SOURCE_HINT}"
    )
}

/// Extract the SHA-256 out of a published checksum file.
///
/// Tokens are scanned for the first 64-hex value rather than taking the first
/// token, so both the GNU form (`<hash>  <file>`, which the release workflow
/// publishes) and the BSD form (`SHA256 (file) = <hash>`) parse.
fn parse_checksum(body: &str) -> Option<String> {
    body.split_whitespace()
        .map(|value| value.trim().to_lowercase())
        .find(|value| value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let permissions = std::fs::Permissions::from_mode(0o755);
    std::fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to mark {} executable: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Err("CLI installation is only supported on macOS and Linux in this build.".to_string())
}

/// Clear the Gatekeeper quarantine flag. We wrote the bytes ourselves so it is
/// usually absent; this is defensive and never fails the install.
#[cfg(target_os = "macos")]
fn clear_quarantine(path: &Path) -> bool {
    std::process::Command::new("/usr/bin/xattr")
        .arg("-dr")
        .arg("com.apple.quarantine")
        .arg(path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn clear_quarantine(_path: &Path) -> bool {
    false
}

/// Read the version back out of a binary, which doubles as a smoke test.
fn probe_version(binary: &Path) -> Option<String> {
    let output = std::process::Command::new(binary)
        .arg("version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    parsed
        .get("data")
        .and_then(|data| data.get("cli_version"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_match_the_release_workflow() {
        assert_eq!(
            asset_name(Platform::MacOsAarch64, "1.1.34"),
            "ssh-thing_1.1.34_macos-aarch64"
        );
        assert_eq!(
            asset_name(Platform::MacOsX64, "1.1.34"),
            "ssh-thing_1.1.34_macos-x64"
        );
        assert_eq!(
            asset_name(Platform::LinuxX64, "1.1.34"),
            "ssh-thing_1.1.34_linux-x64"
        );
    }

    #[test]
    fn release_base_points_at_the_tag() {
        assert_eq!(
            release_base("1.1.34"),
            "https://github.com/ktappdev/ssh-thing/releases/download/v1.1.34"
        );
    }

    #[test]
    fn checksum_parser_accepts_gnu_and_bsd_formats() {
        const HASH: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

        let gnu = "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899  ssh-thing_1.1.34_linux-x64\n";
        assert_eq!(parse_checksum(gnu).as_deref(), Some(HASH));

        let bsd = "SHA256 (ssh-thing_1.1.34_linux-x64) = AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899\n";
        assert_eq!(parse_checksum(bsd).as_deref(), Some(HASH));

        assert_eq!(parse_checksum("not a checksum file"), None);
        assert_eq!(parse_checksum(""), None);
    }

    #[test]
    fn update_is_only_offered_when_installed_and_stale() {
        assert!(!needs_update(false, None, "1.1.34"));
        assert!(!needs_update(false, Some("1.1.33"), "1.1.34"));
        assert!(!needs_update(true, Some("1.1.34"), "1.1.34"));
        assert!(needs_update(true, Some("1.1.33"), "1.1.34"));
        // Installed but unreadable: offer a reinstall rather than claiming it is current.
        assert!(needs_update(true, None, "1.1.34"));
    }

    #[test]
    fn missing_published_assets_explain_themselves() {
        // A 404 is the guaranteed state until a release carries CLI binaries,
        // so its wording is load-bearing: it has to say why, and what to do.
        let message = not_published_message("checksum", "1.1.33");
        assert!(message.contains("published"));
        assert!(message.contains("1.1.33"));
        assert!(message.contains("cargo build --release -p ssh-thing-cli"));
        assert!(message.contains("nothing was installed"));
    }

    #[test]
    fn stray_platforms_are_reported_as_unsupported() {
        // Nothing to assert about the host, only that the reason is actionable.
        assert!(unsupported_reason().contains("cargo build --release -p ssh-thing-cli"));
    }
}
