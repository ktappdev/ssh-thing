function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "Never run";
  return new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeStatus(action) {
  if (!action.last_executed_at) return "Never run";
  const status = action.last_execution_status || "unknown";
  return `${status} · ${formatTimestamp(action.last_executed_at)}`;
}

function formatStatusLabel(status) {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function clampTimeout(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(600, Math.max(5, Math.round(value)));
}

function getStatusTone(status) {
  switch (status) {
    case "success":
      return "action-status-success";
    case "error":
      return "action-status-error";
    case "connecting":
    case "running":
      return "action-status-running";
    default:
      return "action-status-idle";
  }
}

function buildServerOptions(servers, selectedServerId) {
  if (!servers.length) {
    return '<option value="">No servers available</option>';
  }

  return [
    '<option value="">Select a server</option>',
    ...servers.map((server) => {
      const label = server.nickname && server.nickname.trim().length > 0
        ? `${server.nickname} (${server.user}@${server.host})`
        : `${server.user}@${server.host}:${server.port}`;
      const selected = server.id === selectedServerId ? " selected" : "";
      return `<option value="${escapeHtml(server.id)}"${selected}>${escapeHtml(label)}</option>`;
    }),
  ].join("");
}

export function initActionManager({ invoke, listen, getServers, showToast, showAlert, requestDelete }) {
  const state = {
    actions: [],
    running: new Map(),
    historyActionId: null,
    historyActionName: "",
  };

  function getActionList() {
    return document.getElementById("action-list");
  }

  function getActionById(id) {
    return state.actions.find((action) => action.id === id) || null;
  }

  function renderActions() {
    const list = getActionList();
    if (!list) return;

    if (state.actions.length === 0) {
      const hasServers = getServers().length > 0;
      list.innerHTML = `
        <div class="action-empty-state text-center text-sm">
          <div class="action-empty-icon">${hasServers ? ">" : "!"}</div>
          <div class="action-empty-title">${hasServers ? "No actions yet" : "Add a server first"}</div>
          <div class="action-empty-copy">${hasServers ? "Create one-click tasks for repeatable remote commands." : "Actions need a saved server before they can run."}</div>
          ${hasServers ? '<button id="action-empty-add" class="ghost-btn ghost-btn-primary">Create Action</button>' : ""}
        </div>
      `;
      document.getElementById("action-empty-add")?.addEventListener("click", () => openActionModal());
      return;
    }

    const servers = getServers();
    list.innerHTML = "";

    const orderedActions = [...state.actions].sort((left, right) => {
      const leftRunning = state.running.has(left.id) ? 1 : 0;
      const rightRunning = state.running.has(right.id) ? 1 : 0;
      if (leftRunning !== rightRunning) {
        return rightRunning - leftRunning;
      }

      const leftExecuted = left.last_executed_at || 0;
      const rightExecuted = right.last_executed_at || 0;
      if (leftExecuted !== rightExecuted) {
        return rightExecuted - leftExecuted;
      }

      return left.name.localeCompare(right.name);
    });

    orderedActions.forEach((action) => {
      const runningState = state.running.get(action.id);
      const server = servers.find((item) => item.id === action.server_id);
      const canRun = Boolean(server) && !runningState;
      const needsRepair = !server;
      const serverLabel = server
        ? (server.nickname && server.nickname.trim().length > 0
          ? server.nickname
          : `${server.user}@${server.host}:${server.port}`)
        : "Missing server";
      const status = runningState?.status || action.last_execution_status || "idle";
      const buttonLabel = runningState ? "Running" : "Run";
      const item = document.createElement("div");
      item.className = `action-item bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/80 rounded-lg px-3 py-3 shadow-sm group relative ${runningState ? "status-running" : ""}`;
      item.dataset.id = action.id;
      item.innerHTML = `
        <div class="flex items-start gap-3">
          <div class="action-accent ${runningState ? "action-accent-live" : ""}"></div>
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="server-card-name truncate">${escapeHtml(action.name)}</div>
                <div class="server-card-subtitle truncate">${escapeHtml(serverLabel)}</div>
              </div>
              <span class="action-status-pill ${getStatusTone(status)}">${escapeHtml(formatStatusLabel(status))}</span>
            </div>
            <div class="action-command-preview">${escapeHtml(action.command)}</div>
            <div class="action-meta-row">
              <span>${escapeHtml(action.description || "One-shot remote command")}</span>
              <span>${escapeHtml(formatRelativeStatus(action))}</span>
            </div>
            ${!server ? '<div class="action-missing-note">Saved server no longer exists. Edit this action to reassign it.</div>' : ""}
            ${runningState?.message ? `<div class="action-live-note">${escapeHtml(runningState.message)}</div>` : ""}
          </div>
        </div>
        <div class="action-toolbar mt-3 flex items-center justify-between gap-2">
          <div class="action-secondary-actions flex gap-1 flex-shrink-0">
            <button class="server-action-btn action-history-btn" data-id="${escapeHtml(action.id)}" title="History">
              <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3M3.05 11A9 9 0 1 1 6 17.3L3 20m0-5h5" /></svg>
            </button>
            <button class="server-action-btn action-edit-btn" data-id="${escapeHtml(action.id)}" title="Edit">
              <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.414-9.414a2 2 0 1 1 2.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            <button class="server-action-btn delete action-delete-btn" data-id="${escapeHtml(action.id)}" title="Delete">
              <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" /></svg>
            </button>
          </div>
          <button class="ghost-btn ${needsRepair ? "action-repair-btn" : "ghost-btn-primary"} action-run-btn" data-id="${escapeHtml(action.id)}" ${runningState ? "disabled" : ""} title="${needsRepair ? "Repair action server" : canRun ? "Run action" : "Action is already running"}">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0 0 10 9.87v4.263a1 1 0 0 0 1.555.832l3.197-2.132a1 1 0 0 0 0-1.664z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /></svg>
            ${needsRepair ? "Repair" : buttonLabel}
          </button>
        </div>
      `;
      list.appendChild(item);
    });
  }

  async function loadActions() {
    try {
      state.actions = await invoke("get_actions");
      renderActions();
      if (state.historyActionId) {
        await loadHistory(state.historyActionId, { preserveOpen: true });
      }
    } catch (error) {
      console.error("Failed to load actions:", error);
      const list = getActionList();
      if (list) {
        list.innerHTML = '<div class="text-center text-gray-500 dark:text-gray-400 text-sm">Failed to load actions.</div>';
      }
      showAlert("Load Failed", `Failed to load actions: ${error}`);
    }
  }

  function openActionModal(action = null) {
    const modal = document.getElementById("action-modal");
    const title = document.getElementById("action-modal-title");
    const idInput = document.getElementById("action-id");
    const nameInput = document.getElementById("action-name");
    const descriptionInput = document.getElementById("action-description");
    const serverSelect = document.getElementById("action-server");
    const commandInput = document.getElementById("action-command");
    const timeoutInput = document.getElementById("action-timeout");
    if (!modal || !title || !idInput || !nameInput || !descriptionInput || !serverSelect || !commandInput || !timeoutInput) {
      return;
    }

    title.textContent = action ? "Edit Action" : "Add Action";
    idInput.value = action?.id || "";
    nameInput.value = action?.name || "";
    descriptionInput.value = action?.description || "";
    serverSelect.innerHTML = buildServerOptions(getServers(), action?.server_id || "");
    commandInput.value = action?.command || "";
    timeoutInput.value = action?.timeout_seconds ? String(action.timeout_seconds) : "60";
    modal.classList.remove("hidden");
    requestAnimationFrame(() => nameInput.focus());
  }

  function closeActionModal() {
    document.getElementById("action-modal")?.classList.add("hidden");
  }

  async function saveAction(event) {
    event.preventDefault();
    const idInput = document.getElementById("action-id");
    const nameInput = document.getElementById("action-name");
    const descriptionInput = document.getElementById("action-description");
    const serverSelect = document.getElementById("action-server");
    const commandInput = document.getElementById("action-command");
    const timeoutInput = document.getElementById("action-timeout");
    if (!idInput || !nameInput || !descriptionInput || !serverSelect || !commandInput || !timeoutInput) {
      return;
    }

    const id = idInput.value || crypto.randomUUID();
    const existing = getActionById(id);
    const timeoutSeconds = clampTimeout(Number(timeoutInput.value));
    timeoutInput.value = timeoutSeconds ? String(timeoutSeconds) : "60";
    const action = {
      id,
      name: nameInput.value.trim(),
      description: descriptionInput.value.trim() || null,
      server_id: serverSelect.value,
      command: commandInput.value.trim(),
      timeout_seconds: timeoutSeconds,
      last_executed_at: existing?.last_executed_at || null,
      last_execution_status: existing?.last_execution_status || null,
    };

    if (!action.name) {
      showAlert("Missing Name", "Give the action a short name.", "warning");
      nameInput.focus();
      return;
    }
    if (!action.server_id) {
      showAlert("Missing Server", "Choose a server for this action.", "warning");
      serverSelect.focus();
      return;
    }
    if (!action.command) {
      showAlert("Missing Command", "Enter the command this action should run.", "warning");
      commandInput.focus();
      return;
    }

    try {
      if (idInput.value) {
        await invoke("update_action", { id, action });
      } else {
        await invoke("add_action", { action });
      }
      closeActionModal();
      await loadActions();
      showToast(`Saved action: ${action.name}`, "success");
    } catch (error) {
      console.error("Failed to save action:", error);
      showAlert("Save Failed", `Failed to save action: ${error}`);
    }
  }

  async function executeAction(actionId) {
    const action = getActionById(actionId);
    if (!action || state.running.has(actionId)) {
      return;
    }
    const server = getServers().find((item) => item.id === action.server_id);
    if (!server) {
      openActionModal(action);
      return;
    }

    state.running.set(actionId, {
      status: "connecting",
      message: "Starting remote execution...",
    });
    renderActions();

    try {
      await invoke("execute_action", { actionId });
    } catch (error) {
      console.error("Action execution failed:", error);
    }
  }

  async function deleteAction(actionId) {
    const action = getActionById(actionId);
    if (!action) return;

    requestDelete({
      kind: "action",
      id: actionId,
      label: action.name,
      onConfirm: async () => {
        await invoke("delete_action", { id: actionId });
        await loadActions();
      },
    });
  }

  function renderHistory(entries) {
    const list = document.getElementById("action-history-list");
    const title = document.getElementById("action-history-title");
    const summary = document.getElementById("action-history-summary");
    if (!list || !title) return;

    title.textContent = state.historyActionName || "Action History";
    if (summary) {
      const latest = entries[0];
      summary.textContent = latest
        ? `Latest: ${formatStatusLabel(latest.status)} on ${formatTimestamp(latest.completed_at)}`
        : "No runs recorded yet.";
    }
    if (entries.length === 0) {
      list.innerHTML = '<div class="text-center text-gray-500 dark:text-gray-400 text-sm">No runs recorded yet.</div>';
      return;
    }

    list.innerHTML = entries.map((entry) => `
      <article class="action-history-entry ${getStatusTone(entry.status)}">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="server-card-name">${escapeHtml(formatTimestamp(entry.completed_at))}</div>
            <div class="server-card-subtitle">${escapeHtml(entry.server_label)}</div>
          </div>
          <span class="action-status-pill ${getStatusTone(entry.status)}">${escapeHtml(entry.status)}</span>
        </div>
        <div class="action-history-command">${escapeHtml(entry.command)}</div>
        ${entry.error ? `<div class="action-history-error">${escapeHtml(entry.error)}</div>` : ""}
        ${entry.output ? `<pre class="action-history-output">${escapeHtml(entry.output)}</pre>` : '<div class="action-history-empty">No output captured.</div>'}
      </article>
    `).join("");
  }

  async function loadHistory(actionId, { preserveOpen = false } = {}) {
    const action = getActionById(actionId);
    if (!action) return;
    state.historyActionId = actionId;
    state.historyActionName = action.name;
    const list = document.getElementById("action-history-list");
    if (list) {
      list.innerHTML = '<div class="text-center text-gray-500 dark:text-gray-400 text-sm">Loading history...</div>';
    }

    try {
      const entries = await invoke("get_action_history", { actionId });
      renderHistory(entries);
      if (!preserveOpen) {
        document.getElementById("action-history-modal")?.classList.remove("hidden");
      }
    } catch (error) {
      console.error("Failed to load action history:", error);
      showAlert("History Failed", `Failed to load history: ${error}`);
    }
  }

  function closeHistoryModal() {
    document.getElementById("action-history-modal")?.classList.add("hidden");
    state.historyActionId = null;
    state.historyActionName = "";
  }

  function handleActionListClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    const id = button.dataset.id;
    if (!id) return;

    if (button.classList.contains("action-run-btn")) {
      executeAction(id);
      return;
    }
    if (button.classList.contains("action-edit-btn")) {
      openActionModal(getActionById(id));
      return;
    }
    if (button.classList.contains("action-delete-btn")) {
      deleteAction(id);
      return;
    }
    if (button.classList.contains("action-history-btn")) {
      loadHistory(id);
    }
  }

  function refreshServerOptionsIfOpen() {
    const modal = document.getElementById("action-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    const serverSelect = document.getElementById("action-server");
    if (!serverSelect) return;
    const currentValue = serverSelect.value;
    serverSelect.innerHTML = buildServerOptions(getServers(), currentValue);
  }

  listen("action-execution", async (event) => {
    const payload = event.payload || {};
    if (!payload.action_id) {
      return;
    }

    if (["connecting", "running"].includes(payload.status)) {
      state.running.set(payload.action_id, {
        status: payload.status,
        message: payload.message || "Running...",
      });
      renderActions();
      return;
    }

    state.running.delete(payload.action_id);
    await loadActions();

    if (payload.status === "success") {
      showToast(payload.message || `${payload.action_name} completed`, "success");
      return;
    }

    if (payload.status === "error") {
      const detail = payload.entry?.error || payload.message || `${payload.action_name} failed`;
      showAlert("Action Failed", detail);
    }
  });

  document.getElementById("add-action-btn")?.addEventListener("click", () => openActionModal());
  document.getElementById("action-cancel-btn")?.addEventListener("click", closeActionModal);
  document.getElementById("action-form")?.addEventListener("submit", saveAction);
  document.getElementById("action-list")?.addEventListener("click", handleActionListClick);
  document.getElementById("action-history-close")?.addEventListener("click", closeHistoryModal);

  const actionModal = document.getElementById("action-modal");
  if (actionModal) {
    actionModal.addEventListener("click", (event) => {
      if (event.target === actionModal) {
        closeActionModal();
      }
    });
  }

  const historyModal = document.getElementById("action-history-modal");
  if (historyModal) {
    historyModal.addEventListener("click", (event) => {
      if (event.target === historyModal) {
        closeHistoryModal();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("action-modal")?.classList.contains("hidden")) {
      closeActionModal();
    }
    if (!document.getElementById("action-history-modal")?.classList.contains("hidden")) {
      closeHistoryModal();
    }
  });

  return {
    loadActions,
    renderActions,
    refreshServerOptionsIfOpen,
  };
}
