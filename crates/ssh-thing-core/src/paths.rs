//! App-data directory resolution without a Tauri runtime.
//!
//! Tauri resolves `app.path().app_data_dir()` as `<platform data dir>/<identifier>`.
//! The CLI has to land on exactly the same directory or it cannot see the
//! servers and snippets the desktop app wrote, so the identifier is mirrored
//! from `src-tauri/tauri.conf.json` and asserted in tests.

use std::path::{Path, PathBuf};

/// Bundle identifier from `src-tauri/tauri.conf.json`.
pub const APP_IDENTIFIER: &str = "com.kentaylor.ssh-thing";

/// Environment variable that relocates the data directory.
pub const ENV_DATA_DIR: &str = "SSH_THING_DATA_DIR";

/// Base data directory used by Tauri for this identifier.
///
/// `SSH_THING_DATA_DIR` overrides the location. That is for tests, fixtures,
/// and users who want a separate profile — secrets still come from the OS
/// keychain, so it cannot be used to smuggle in credentials.
pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(override_dir) = override_data_dir() {
        return Ok(override_dir);
    }

    let base = dirs::data_dir().ok_or_else(|| {
        "Could not determine the user data directory for this platform".to_string()
    })?;
    Ok(app_data_dir_for(&base))
}

/// The `SSH_THING_DATA_DIR` override, when set to something usable.
pub fn override_data_dir() -> Option<PathBuf> {
    let value = std::env::var_os(ENV_DATA_DIR)?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

/// The user's home directory.
pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not determine the home directory".to_string())
}

/// App-data directory for an explicit base directory. Split out so the
/// resolution rule is testable without touching the real home directory.
pub fn app_data_dir_for(base: &Path) -> PathBuf {
    base.join(APP_IDENTIFIER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_appends_identifier() {
        let base = PathBuf::from("/tmp/base");
        assert_eq!(
            app_data_dir_for(&base),
            PathBuf::from("/tmp/base/com.kentaylor.ssh-thing")
        );
    }

    #[test]
    fn resolved_dir_ends_with_identifier() {
        let dir = app_data_dir().expect("data dir should resolve on this platform");
        assert!(dir.ends_with(APP_IDENTIFIER) || override_data_dir().is_some());
    }

    #[test]
    fn empty_override_is_ignored() {
        std::env::set_var(ENV_DATA_DIR, "");
        let override_dir = override_data_dir();
        std::env::remove_var(ENV_DATA_DIR);
        assert!(override_dir.is_none());
    }
}
