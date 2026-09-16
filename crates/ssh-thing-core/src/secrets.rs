//! Keyring access plus an explicit, opt-in environment override.
//!
//! Secrets live in the OS keychain under service `com.ssh-thing`. That works
//! everywhere the user has an unlocked login session. It does *not* work when
//! a macOS process runs outside a GUI login session (SSH, cron, LaunchAgent):
//! the Security framework returns `errSecInteractionNotAllowed` (-25308).
//!
//! Rather than silently failing there, `get_secret` checks
//! `SSH_THING_SECRET_<SANITIZED_ID>` first. That escape hatch is opt-in — the
//! user has to set the variable — so it never becomes a hidden second store of
//! record, and nothing is written to disk in plaintext.

use keyring::Entry;

/// Keyring service name. Must stay in sync with the desktop app or the two
/// processes will not see the same entries.
pub const KEYRING_SERVICE: &str = "com.ssh-thing";

/// Environment prefix for the headless secret override.
pub const SECRET_ENV_PREFIX: &str = "SSH_THING_SECRET_";

/// Identifier of the throwaway entry written by `probe`.
pub const PROBE_SECRET_ID: &str = "ssh-thing:doctor-probe";

pub fn keyring_service_name() -> &'static str {
    KEYRING_SERVICE
}

/// Map a secret id to its environment variable name.
///
/// `server:8f4c…:password` becomes `SSH_THING_SECRET_SERVER_8F4C…_PASSWORD`.
/// Every non-alphanumeric character becomes `_`, so the mapping is stable and
/// safe to use from any shell.
pub fn env_var_name(secret_id: &str) -> String {
    let mut name = String::with_capacity(SECRET_ENV_PREFIX.len() + secret_id.len());
    name.push_str(SECRET_ENV_PREFIX);
    for ch in secret_id.chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch.to_ascii_uppercase());
        } else {
            name.push('_');
        }
    }
    name
}

fn entry(secret_id: &str) -> Result<Entry, String> {
    Entry::new(keyring_service_name(), secret_id)
        .map_err(|e| format!("keyring entry failed: {}", e))
}

pub fn put_secret(secret_id: &str, secret: &str) -> Result<(), String> {
    entry(secret_id)?
        .set_password(secret)
        .map_err(|e| format!("keyring set failed: {}", e))
}

/// Read a secret, preferring an explicit `SSH_THING_SECRET_*` override.
pub fn get_secret(secret_id: &str) -> Result<String, String> {
    let variable = env_var_name(secret_id);
    if let Ok(value) = std::env::var(&variable) {
        if !value.is_empty() {
            return Ok(value);
        }
    }

    entry(secret_id)?
        .get_password()
        .map_err(|error| keyring_read_error(secret_id, &error))
}

pub fn delete_secret(secret_id: &str) -> Result<(), String> {
    entry(secret_id)?
        .delete_password()
        .map_err(|e| format!("keyring delete failed: {}", e))
}

/// Error text for a failed keychain read.
///
/// The leading clause matches the historical message so existing behaviour is
/// recognisable, and macOS gets an actionable hint because a headless session
/// is by far the most common cause there.
fn keyring_read_error(secret_id: &str, error: &keyring::Error) -> String {
    let mut message = format!("keyring get failed: {}", error);
    if cfg!(target_os = "macos") {
        message.push_str(&format!(
            ". macOS only serves keychain reads to a local GUI login session (SSH and background sessions get errSecInteractionNotAllowed). Run the CLI from a local terminal, or set {} to supply this secret without the keychain",
            env_var_name(secret_id)
        ));
    }
    message
}

/// Write, read back, and delete a throwaway entry.
///
/// This is the only reliable way to detect a keyring backend that is present
/// at compile time but unusable at runtime — including the `keyring` crate's
/// silent mock store when no platform backend is enabled.
pub fn probe() -> Result<(), String> {
    let marker = format!("probe-{}", std::process::id());
    put_secret(PROBE_SECRET_ID, &marker)?;

    let read_back = get_secret(PROBE_SECRET_ID)?;
    let _ = delete_secret(PROBE_SECRET_ID);

    if read_back != marker {
        return Err(
            "keyring write/read mismatch — the active backend is not persisting secrets"
                .to_string(),
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_var_names_are_shell_safe_and_stable() {
        assert_eq!(
            env_var_name("server:8f4c-1234:password"),
            "SSH_THING_SECRET_SERVER_8F4C_1234_PASSWORD"
        );
        assert_eq!(env_var_name("abc"), "SSH_THING_SECRET_ABC");
    }

    #[test]
    fn env_override_wins_over_keyring() {
        let secret_id = format!("test:override:{}", std::process::id());
        let variable = env_var_name(&secret_id);
        std::env::set_var(&variable, "from-env");
        let resolved = get_secret(&secret_id).expect("env override should resolve");
        std::env::remove_var(&variable);
        assert_eq!(resolved, "from-env");
    }
}
