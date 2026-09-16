//! Shared core for SSH THING.
//!
//! No `tauri` dependency lives here, so the CLI can read the same data files,
//! talk to the same keyring entries, and reuse the same SSH code as the
//! desktop app without launching it.

pub mod model;
pub mod paths;
pub mod secrets;
pub mod settings;
pub mod ssh;
pub mod store;

pub use model::*;
pub use paths::{app_data_dir, app_data_dir_for, override_data_dir, APP_IDENTIFIER, ENV_DATA_DIR};
pub use secrets::{delete_secret, get_secret, put_secret};
pub use settings::AutomationSettings;
pub use ssh::{
    append_capped, clamp_timeout, client_config, connect, connect_saved_server,
    describe_connect_failure, disconnect_quiet, exec_command, find_known_host, CommandOutcome,
    HostKeyDenial, StrictHostKeyHandler,
};
pub use store::{
    append_cli_history_entry, append_history_entry, load_actions, load_cli_history,
    load_known_hosts, load_servers, load_servers_migrated, load_settings_file, load_snippets,
    migrate_server_auth, parse_json_array_lenient, save_actions, save_cli_history,
    save_known_hosts, save_servers, save_settings_file, save_snippets, unix_timestamp_now,
};

/// Version of the shipped app/CLI, taken from the workspace version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
