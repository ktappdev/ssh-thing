const EMPTY = "—";

/**
 * Automation panel: the desktop-side gate the CLI obeys, plus install/update of
 * the `ssh-thing` binary.
 *
 * Security note: this panel is the only place `allow_external_automation` is
 * toggled, and it is deliberately a separate action from installing the CLI.
 */
export function initAutomationManager(options) {
  const invoke = options.invoke;
  const showToast = options.showToast || (() => {});
  const showAlert = options.showAlert || (() => {});

  const modal = document.getElementById("automation-modal");
  const openButton = document.getElementById("automation-btn");
  const closeButton = document.getElementById("automation-close-btn");
  const toggle = document.getElementById("automation-enabled");
  const statusLine = document.getElementById("automation-status");
  const detailButton = document.getElementById("automation-detail-btn");
  const installButton = document.getElementById("cli-install-btn");
  const uninstallButton = document.getElementById("cli-uninstall-btn");
  const refreshButton = document.getElementById("cli-refresh-btn");

  if (!modal || !openButton || !toggle) {
    return { refresh: async () => {} };
  }

  const fields = {
    status: document.getElementById("cli-status-value"),
    version: document.getElementById("cli-version-value"),
    path: document.getElementById("cli-path-value"),
    platform: document.getElementById("cli-platform-value"),
  };
  const pathHint = document.getElementById("cli-path-hint");

  let settings = null;
  let cliStatus = null;
  let busy = false;

  const setStatus = (message, tone = "info") => {
    if (!statusLine) return;
    statusLine.textContent = message;
    statusLine.classList.toggle("is-error", tone === "error");
    statusLine.classList.toggle("is-busy", tone === "busy");
  };

  const setText = (element, value) => {
    if (element) element.textContent = value === undefined || value === null || value === "" ? EMPTY : String(value);
  };

  const setBusy = (value) => {
    busy = value;
    for (const button of [installButton, uninstallButton, refreshButton, toggle]) {
      if (button) button.disabled = value;
    }
  };

  const renderSettings = () => {
    toggle.checked = Boolean(settings?.allow_external_automation);
    if (settings?.allow_external_automation) {
      setStatus("External automation is on. The CLI can run server-scoped snippets.", "info");
    } else {
      setStatus("External automation is off. The CLI can read snippets but every run is refused.", "info");
    }
  };

  const renderCliStatus = () => {
    if (!cliStatus) {
      setText(fields.status, "Unavailable");
      setText(fields.version, EMPTY);
      setText(fields.path, EMPTY);
      setText(fields.platform, EMPTY);
      if (installButton) installButton.disabled = true;
      if (uninstallButton) uninstallButton.classList.add("hidden");
      return;
    }

    setText(fields.platform, cliStatus.platform);

    if (!cliStatus.supported) {
      setText(fields.status, "Not available for this platform");
      setText(fields.version, EMPTY);
      setText(fields.path, EMPTY);
      if (pathHint) {
        pathHint.textContent = cliStatus.unsupported_reason || "";
        pathHint.classList.toggle("hidden", !cliStatus.unsupported_reason);
      }
      if (installButton) installButton.disabled = true;
      if (uninstallButton) uninstallButton.classList.add("hidden");
      return;
    }

    if (!cliStatus.installed) {
      setText(fields.status, "Not installed");
      setText(fields.version, EMPTY);
      setText(fields.path, EMPTY);
    } else {
      setText(
        fields.status,
        cliStatus.update_available ? "Update available" : "Installed and up to date",
      );
      setText(fields.version, cliStatus.version || "unknown");
      setText(fields.path, cliStatus.path);
    }

    if (installButton) {
      installButton.textContent = cliStatus.installed
        ? cliStatus.update_available
          ? "Update CLI"
          : "Reinstall CLI"
        : "Install CLI";
    }
    if (uninstallButton) {
      uninstallButton.classList.toggle("hidden", !cliStatus.installed);
    }

    const hint = cliStatus.on_path
      ? ""
      : `Add ${cliStatus.install_dir} to your PATH: export PATH="${cliStatus.install_dir}:$PATH"`;
    if (pathHint) {
      pathHint.textContent = hint;
      pathHint.classList.toggle("hidden", !hint);
    }
  };

  const refresh = async () => {
    try {
      const [loadedSettings, loadedStatus] = await Promise.all([
        invoke("get_automation_settings"),
        invoke("cli_status"),
      ]);
      settings = loadedSettings;
      cliStatus = loadedStatus;
      renderSettings();
      renderCliStatus();
    } catch (error) {
      console.error("Failed to load automation settings:", error);
      setStatus(`Could not load automation settings: ${error}`, "error");
    }
  };

  const openModal = async () => {
    modal.classList.remove("hidden");
    requestAnimationFrame(() => closeButton?.focus());
    await refresh();
  };

  const closeModal = () => modal.classList.add("hidden");

  const saveSettings = async () => {
    if (!settings) return;
    const next = { ...settings, allow_external_automation: toggle.checked };
    try {
      settings = await invoke("set_automation_settings", { settings: next });
      renderSettings();
      showToast(
        settings.allow_external_automation
          ? "External automation enabled"
          : "External automation disabled",
        "info",
      );
    } catch (error) {
      console.error("Failed to save automation settings:", error);
      toggle.checked = Boolean(settings.allow_external_automation);
      showAlert("Settings Not Saved", String(error));
    }
  };

  openButton.addEventListener("click", openModal);
  closeButton?.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });

  toggle.addEventListener("change", async () => {
    if (busy) return;
    setBusy(true);
    await saveSettings();
    setBusy(false);
  });

  refreshButton?.addEventListener("click", async () => {
    setBusy(true);
    await refresh();
    setBusy(false);
  });

  installButton?.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Downloading and verifying the CLI…", "busy");
    try {
      const result = await invoke("install_cli");
      showToast(`CLI ${result.version || ""} installed`, "success");
      if (result.path_hint) showToast(result.path_hint, "warning");
      await refresh();
    } catch (error) {
      console.error("CLI install failed:", error);
      setStatus(`Install failed: ${error}`, "error");
      showAlert("CLI Install Failed", String(error));
    } finally {
      setBusy(false);
    }
  });

  uninstallButton?.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Remove the ssh-thing CLI from this machine? External automation settings are kept.",
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      await invoke("uninstall_cli");
      showToast("CLI removed", "success");
      await refresh();
    } catch (error) {
      console.error("CLI uninstall failed:", error);
      setStatus(`Uninstall failed: ${error}`, "error");
      showAlert("CLI Uninstall Failed", String(error));
    } finally {
      setBusy(false);
    }
  });

  detailButton?.addEventListener("click", () => {
    if (!cliStatus) return;
    const lines = [
      `platform: ${cliStatus.platform}`,
      `expected version: ${cliStatus.expected_version}`,
      `asset: ${cliStatus.asset_name || EMPTY}`,
      `download: ${cliStatus.download_url || EMPTY}`,
      `install dir: ${cliStatus.install_dir}`,
      `on PATH: ${cliStatus.on_path ? "yes" : "no"}`,
    ];
    window.alert(lines.join("\n"));
  });

  return { refresh };
}
