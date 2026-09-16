//! Automation settings owned by the desktop app, read by the CLI.
//!
//! The CLI refuses to execute anything unless `allow_external_automation` is
//! true. It defaults to false, so installing the CLI alone never grants an
//! agent the ability to run commands.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::store;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AutomationSettings {
    /// Master switch. Defaults to off and must be turned on in the desktop app.
    #[serde(default)]
    pub allow_external_automation: bool,
    /// Where `Install CLI` last placed the binary, when it did.
    #[serde(default)]
    pub cli_install_path: Option<String>,
    /// Version reported by the installed CLI at install time.
    #[serde(default)]
    pub cli_installed_version: Option<String>,
    /// App version at the time these settings were written, so the CLI can
    /// warn about an app/CLI mismatch without launching the app.
    #[serde(default)]
    pub app_version: Option<String>,
}

impl AutomationSettings {
    pub fn load(app_dir: &Path) -> Result<Self, String> {
        Ok(store::load_settings_file::<AutomationSettings>(app_dir)?.unwrap_or_default())
    }

    pub fn save(&self, app_dir: &Path) -> Result<(), String> {
        store::save_settings_file(app_dir, self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ssh-thing-settings-{}-{}",
            name,
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn defaults_to_automation_disabled() {
        let dir = temp_dir("defaults");
        let settings = AutomationSettings::load(&dir).expect("load");
        assert!(!settings.allow_external_automation);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn round_trips() {
        let dir = temp_dir("round-trip");
        let settings = AutomationSettings {
            allow_external_automation: true,
            cli_install_path: Some("/tmp/bin/ssh-thing".to_string()),
            cli_installed_version: Some("1.1.34".to_string()),
            app_version: Some("1.1.34".to_string()),
        };
        settings.save(&dir).expect("save");
        let loaded = AutomationSettings::load(&dir).expect("load");
        assert_eq!(loaded, settings);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn partially_written_settings_file_still_loads() {
        let dir = temp_dir("partial");
        std::fs::write(dir.join("settings.json"), "{}").expect("write");
        let settings = AutomationSettings::load(&dir).expect("load");
        assert!(!settings.allow_external_automation);
        assert!(settings.cli_install_path.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_settings_file_fails_closed() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join("settings.json"), "null").expect("write");
        assert!(AutomationSettings::load(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
