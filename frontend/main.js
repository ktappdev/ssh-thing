import { initAboutModal } from "./components/about-modal.js";
import { initActionManager } from "./components/actions-manager.js";
import { initHeaderMenu } from "./components/header-menu.js";
import { createSessionManager } from "./components/session-manager.js";
import { renderServerList as renderServerCards } from "./components/server-list.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const tauriWindow = window.__TAURI__.window || null;
const SearchAddonCtor =
  typeof window.SearchAddon !== "undefined" && typeof window.SearchAddon.SearchAddon === "function"
    ? window.SearchAddon.SearchAddon
    : null;

const DEFAULT_TERMINAL_SETTINGS = {
  fontSize: 14,
  scrollback: 5000,
};

let servers = [];
let connectionLog = [];
let pendingHostKey = null;
let queuedHostKeys = [];
let pendingDeleteTarget = null;
let pendingDisconnectResolve = null;
let pendingCloseAppResolve = null;
let terminalTransparent = false;
let serverFilterTerm = "";
let terminalSettings = loadTerminalSettings();
let closeRequestInProgress = false;
let actionManager = null;
let sessionManager = null;

function loadTerminalSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("terminal-settings") || "{}");
    return {
      fontSize: Number(saved.fontSize) || DEFAULT_TERMINAL_SETTINGS.fontSize,
      scrollback: Number(saved.scrollback) || DEFAULT_TERMINAL_SETTINGS.scrollback,
    };
  } catch {
    return { ...DEFAULT_TERMINAL_SETTINGS };
  }
}

function persistTerminalSettings() {
  localStorage.setItem("terminal-settings", JSON.stringify(terminalSettings));
}

function getActiveSession() {
  return sessionManager?.getActiveSession() || null;
}

function hasActiveConnections() {
  return sessionManager?.hasActiveConnections() || false;
}

function formatLastConnected(timestamp) {
  if (!timestamp) return "Never connected";
  const date = new Date(timestamp * 1000);
  return `Last: ${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function showToast(message, type = "info") {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;

  const toast = document.createElement("div");
  const tone = {
    info: "bg-gray-900/90 text-white",
    success: "bg-green-600/95 text-white",
    warning: "bg-amber-500/95 text-white",
    error: "bg-red-600/95 text-white",
  }[type] || "bg-gray-900/90 text-white";

  toast.className = `pointer-events-auto rounded-lg px-4 py-3 shadow-lg text-sm ${tone}`;
  toast.textContent = message;
  stack.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3200);
}

function showAlert(title, message, type = "error") {
  const alertModal = document.getElementById("alert-modal");
  const alertTitle = document.getElementById("alert-title");
  const alertMessage = document.getElementById("alert-message");
  const alertIcon = document.getElementById("alert-icon");
  const alertIconSvg = document.getElementById("alert-icon-svg");

  alertTitle.textContent = title;
  alertMessage.textContent = message;

  alertIcon.className = `flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${type}`;
  alertIconSvg.innerHTML = getIconForType(type);

  alertModal.classList.remove("hidden");

  document.getElementById("alert-ok-btn").onclick = () => {
    alertModal.classList.add("hidden");
  };

  alertModal.onclick = (event) => {
    if (event.target === alertModal) {
      alertModal.classList.add("hidden");
    }
  };
}

function getIconForType(type) {
  switch (type) {
    case "error":
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
    case "warning":
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />';
    case "success":
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />';
    default:
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
  }
}

async function confirmDeleteTarget() {
  if (!pendingDeleteTarget) return;
  const { kind, id, onConfirm } = pendingDeleteTarget;
  closeDeleteModal();
  try {
    if (typeof onConfirm === "function") {
      await onConfirm(id);
    } else if (kind === "server") {
      await invoke("delete_server", { id });
      loadServers();
    } else if (kind === "snippet") {
      await invoke("delete_snippet", { id });
      loadSnippets();
    }
  } catch (error) {
    console.error(`Failed to delete ${kind}:`, error);
    showAlert("Delete Failed", `Failed to delete ${kind}: ${error}`);
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = savedTheme ? savedTheme === "dark" : prefersDark;
  document.documentElement.classList.toggle("dark", isDark);
}

function renderHostKeyPrompt(prompt) {
  pendingHostKey = prompt;
  document.getElementById("host-key-host").textContent = `${prompt.host}:${prompt.port}`;
  document.getElementById("host-key-type").textContent = prompt.key_type;
  document.getElementById("host-key-fingerprint").textContent = prompt.fingerprint;
  document.getElementById("host-key-modal").classList.remove("hidden");
}

function openHostKeyModal(prompt) {
  if (pendingHostKey) {
    queuedHostKeys.push(prompt);
    return;
  }
  renderHostKeyPrompt(prompt);
}

function openDeleteModal({ kind, id, label, onConfirm = null }) {
  const modal = document.getElementById("delete-confirm-modal");
  const title = document.getElementById("delete-confirm-title");
  const message = document.getElementById("delete-confirm-message");
  if (title) {
    title.textContent = kind === "snippet"
      ? "Delete snippet?"
      : kind === "action"
        ? "Delete action?"
        : "Delete host?";
  }
  if (message) {
    message.textContent = `Delete ${label}? This action cannot be undone.`;
  }
  pendingDeleteTarget = { kind, id, onConfirm };
  modal?.classList.remove("hidden");
}

function closeHostKeyModal() {
  document.getElementById("host-key-modal").classList.add("hidden");
}

function drainHostKeyQueue() {
  if (pendingHostKey || queuedHostKeys.length === 0) return;
  const nextPrompt = queuedHostKeys.shift();
  renderHostKeyPrompt(nextPrompt);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  sessionManager?.refreshTerminalTheme();
}

function toggleTerminalBackground() {
  const isDark = document.documentElement.classList.contains("dark");
  terminalTransparent = isDark ? !terminalTransparent : false;
  document.body.classList.toggle("terminal-transparent", terminalTransparent && isDark);
  const label = document.getElementById("header-terminal-bg-label");
  if (label) {
    label.textContent = terminalTransparent && isDark ? "Glass" : "Solid";
  }
  sessionManager?.refreshTerminalTheme();
}

function getTerminalTheme() {
  const isDark = document.documentElement.classList.contains("dark");
  const background = !isDark ? "#0f111a" : (terminalTransparent ? "transparent" : "#0f111a");
  return {
    background,
    foreground: isDark ? "#cdd6f4" : "#e6e9ef",
    cursor: isDark ? "#f5c2e7" : "#82aaff",
    selection: "rgba(148, 163, 184, 0.35)",
  };
}

function initTerminal() {
  sessionManager?.init();
}

function applyTerminalSettings() {
  persistTerminalSettings();
  sessionManager?.applyTerminalSettings();
}

async function loadServers() {
  try {
    servers = await invoke("get_servers");
    renderServerList();
    actionManager?.renderActions();
    actionManager?.refreshServerOptionsIfOpen();
  } catch (error) {
    console.error("Failed to load servers:", error);
    const listEl = document.getElementById("server-list");
    if (listEl) {
      listEl.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 mt-10 text-sm">Failed to load servers.</div>`;
    }
    showAlert("Load Failed", `Failed to load servers: ${error}`);
  }
}

function renderServerList() {
  const listEl = document.getElementById("server-list");
  const filterWrap = document.getElementById("server-filter-wrap");
  if (!listEl || !sessionManager) return;

  renderServerCards({
    listEl,
    filterWrap,
    servers,
    filterTerm: serverFilterTerm,
    getHostSummary: (serverId) => sessionManager.getHostSummary(serverId),
    formatLastConnected,
    onPrimaryAction: (serverId) => connectToServer(serverId),
    onFocusServer: (serverId) => sessionManager.focusMostRecentSessionForServer(serverId),
    onDuplicate: duplicateServer,
    onEdit: openEditModal,
    onDelete: deleteServer,
  });
}

async function connectToServer(id) {
  await sessionManager?.connectToServer(id);
}

async function disconnectFromServer(serverId = null, { requireConfirm = false } = {}) {
  await sessionManager?.disconnectSession(serverId, { requireConfirm });
}

function logConnectionEvent(message, detail = "", type = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const entry = { timestamp, message, detail, type };
  connectionLog.push(entry);
  if (connectionLog.length > 50) {
    connectionLog.shift();
  }
  const listEl = document.getElementById("connection-log-list");
  if (listEl) {
    listEl.innerHTML = connectionLog
      .slice()
      .reverse()
      .map((item) => {
        const color = item.type === "error" ? "text-red-500" : item.type === "warning" ? "text-yellow-500" : "text-green-500";
        const detailText = item.detail ? ` — ${item.detail}` : "";
        return `<li class=\"flex justify-between text-xs py-0.5 border-b border-gray-100 dark:border-gray-700\"><span class=\"text-gray-500 dark:text-gray-400\">${item.timestamp}</span><span class=\"ml-2 ${color}\">${item.message}${detailText}</span></li>`;
      })
      .join("");
  }
}

function openModal() {
  const modal = document.getElementById("server-modal");
  modal.classList.remove("hidden");
  document.getElementById("modal-title").textContent = "Add Server";
  document.getElementById("server-form").reset();
  document.getElementById("server-id").value = "";
  const nicknameInput = document.getElementById("server-nickname");
  if (nicknameInput) {
    nicknameInput.value = "";
  }
  document.getElementById("auth-type").value = "password";
  document.getElementById("password-field").classList.remove("hidden");
  document.getElementById("key-field").classList.add("hidden");
  document.getElementById("server-password").placeholder = "";
  document.getElementById("server-key").placeholder = "";
  const timeoutInput = document.getElementById("server-timeout");
  if (timeoutInput) {
    timeoutInput.value = "30";
  }
}

function closeModal() {
  document.getElementById("server-modal").classList.add("hidden");
  const keyFileInput = document.getElementById("server-key-file");
  if (keyFileInput) {
    keyFileInput.value = "";
  }
}

function openEditModal(id) {
  const server = servers.find((s) => s.id === id);
  if (!server) return;

  document.getElementById("server-modal").classList.remove("hidden");
  document.getElementById("modal-title").textContent = "Edit Server";
  document.getElementById("server-id").value = server.id;
  const nicknameInput = document.getElementById("server-nickname");
  if (nicknameInput) {
    nicknameInput.value = server.nickname || "";
  }
  document.getElementById("server-host").value = server.host;
  document.getElementById("server-port").value = server.port;
  document.getElementById("server-user").value = server.user;
  const timeoutInput = document.getElementById("server-timeout");
  if (timeoutInput) {
    timeoutInput.value = String(server.timeout_seconds || 30);
  }

  if (server.auth.type === "Password") {
    document.getElementById("auth-type").value = "password";
    document.getElementById("password-field").classList.remove("hidden");
    document.getElementById("key-field").classList.add("hidden");
    document.getElementById("server-password").value = server.auth.password || "";
    document.getElementById("server-password").placeholder = "";
  } else if (server.auth.type === "SecretRef") {
    const isPassword = !server.auth.kind || server.auth.kind === "Password";
    if (isPassword) {
      document.getElementById("auth-type").value = "password";
      document.getElementById("password-field").classList.remove("hidden");
      document.getElementById("key-field").classList.add("hidden");
      document.getElementById("server-password").value = "";
      document.getElementById("server-password").placeholder = "Stored in keychain. Enter to replace.";
    } else {
      document.getElementById("auth-type").value = "key";
      document.getElementById("password-field").classList.add("hidden");
      document.getElementById("key-field").classList.remove("hidden");
      document.getElementById("server-key").value = "";
      document.getElementById("server-key").placeholder = "Stored in keychain. Paste new key to replace.";
    }
  } else {
    document.getElementById("auth-type").value = "key";
    document.getElementById("password-field").classList.add("hidden");
    document.getElementById("key-field").classList.remove("hidden");
    document.getElementById("server-key").value = server.auth.private_key || "";
    document.getElementById("server-key").placeholder = "";
  }
}

async function saveServer(e) {
  e.preventDefault();

  const id = document.getElementById("server-id").value || crypto.randomUUID();
  const nicknameInput = document.getElementById("server-nickname");
  const nickname = nicknameInput ? nicknameInput.value.trim() : "";
  const host = document.getElementById("server-host").value;
  const port = parseInt(document.getElementById("server-port").value);
  const user = document.getElementById("server-user").value;
  const timeoutInput = document.getElementById("server-timeout");
  const timeoutValue = timeoutInput ? timeoutInput.value : "30";
  const timeout_seconds = Math.max(5, parseInt(timeoutValue, 10) || 30);
  const authType = document.getElementById("auth-type").value;
  const existing = servers.find((s) => s.id === id);

  let auth;
  if (authType === "password") {
    const passwordValue = document.getElementById("server-password").value;
    const existingSecretId = existing && existing.auth && existing.auth.type === "SecretRef" && (existing.auth.kind === "Password" || !existing.auth.kind)
      ? existing.auth.secret_id
      : null;

    if (passwordValue) {
      const secret_id = await invoke("upsert_secret", {
        secret_id: existingSecretId ?? null,
        secret: passwordValue,
        kind: "Password",
      });
      auth = { type: "SecretRef", secret_id, kind: "Password" };
    } else if (existingSecretId) {
      auth = { type: "SecretRef", secret_id: existingSecretId, kind: "Password" };
    } else if (existing && existing.auth && existing.auth.type === "Password" && existing.auth.password) {
      // Legacy plaintext fallback: require user to re-enter
      showAlert("Password Required", "Please enter a password to store in the keychain.", "warning");
      return;
    } else {
      showAlert("Password Required", "Please enter a password.", "warning");
      return;
    }
  } else {
    const keyValue = document.getElementById("server-key").value;
    const existingSecretId = existing && existing.auth && existing.auth.type === "SecretRef" && existing.auth.kind === "PrivateKey"
      ? existing.auth.secret_id
      : null;

    if (keyValue) {
      const secret_id = await invoke("upsert_secret", {
        secret_id: existingSecretId ?? null,
        secret: keyValue,
        kind: "PrivateKey",
      });
      auth = { type: "SecretRef", secret_id, kind: "PrivateKey" };
    } else if (existingSecretId) {
      auth = { type: "SecretRef", secret_id: existingSecretId, kind: "PrivateKey" };
    } else if (existing && existing.auth && existing.auth.type === "Key" && existing.auth.private_key) {
      showAlert("Private Key Required", "Please paste your private key to store in the keychain.", "warning");
      return;
    } else {
      showAlert("Private Key Required", "Please paste your private key.", "warning");
      return;
    }
  }

  const server = {
    id,
    nickname: nickname.length > 0 ? nickname : null,
    host,
    port,
    user,
    timeout_seconds,
    last_connected_at: existing?.last_connected_at || null,
    auth,
  };

  try {
    if (document.getElementById("server-id").value) {
      await invoke("update_server", { id, server });
    } else {
      await invoke("add_server", { server });
    }
    closeModal();
    loadServers();
  } catch (error) {
    console.error("Failed to save server:", error);
    showAlert("Save Failed", `Failed to save server: ${error}`);
  }
}

async function deleteServer(id) {
  const server = servers.find((item) => item.id === id);
  const label = server
    ? server.nickname && server.nickname.trim().length > 0
      ? server.nickname
      : `${server.user}@${server.host}`
    : "this host";
  openDeleteModal({ kind: "server", id, label });
}

async function duplicateServer(id) {
  try {
    await invoke("duplicate_server", { id });
    await loadServers();
    showToast("Server duplicated.", "success");
  } catch (error) {
    console.error("Failed to duplicate server:", error);
    showAlert("Duplicate Failed", `Failed to duplicate server: ${error}`);
  }
}

let snippets = [];

async function loadSnippets() {
  try {
    snippets = await invoke("get_snippets");
    renderSnippetList();
  } catch (error) {
    console.error("Failed to load snippets:", error);
    const listEl = document.getElementById("snippet-list");
    if (listEl) {
      listEl.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 mt-10 text-sm">Failed to load snippets.</div>`;
    }
    showAlert("Load Failed", `Failed to load snippets: ${error}`);
  }
}

function renderSnippetList() {
  const listEl = document.getElementById("snippet-list");
  listEl.innerHTML = "";
  
  if (snippets.length === 0) {
    listEl.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 mt-10 text-sm">No snippets added yet.</div>`;
    return;
  }

  snippets.forEach((snippet) => {
    const div = document.createElement("div");
    div.className = "snippet-item bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/80 rounded-lg px-3 py-2.5 shadow-sm group flex items-center gap-3 relative";
    div.dataset.id = snippet.id;
    
    const firstPart = snippet.command.split('&&')[0].trim();
    const displayCommand = firstPart.length > 28 ? firstPart.substring(0, 28) + '...' : firstPart;
    const hasMore = snippet.command.includes('&&') || snippet.command.length > 28;
    
    div.innerHTML = `
      <div class="w-2 h-2 rounded-full bg-blue-400 dark:bg-blue-500/60 flex-shrink-0"></div>
      <div class="min-w-0 flex-1">
        <div class="server-card-name truncate">${snippet.name}</div>
        <div class="server-card-subtitle font-mono truncate text-blue-600/70 dark:text-blue-400/70">${displayCommand}${hasMore ? ' <span class="text-gray-400 dark:text-gray-500">+more</span>' : ''}</div>
      </div>
      <div class="server-actions flex gap-1 flex-shrink-0">
        <button class="server-action-btn snippet-edit-btn" data-id="${snippet.id}" title="Edit">
          <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
        </button>
        <button class="server-action-btn delete snippet-delete-btn" data-id="${snippet.id}" title="Delete">
          <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
      </div>
      <button class="ghost-btn ghost-btn-primary snippet-run-btn flex-shrink-0" data-id="${snippet.id}">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        Run
      </button>
      <div class="snippet-tooltip hidden absolute left-0 right-0 top-full mt-1 z-50 bg-gray-900 dark:bg-gray-700 text-white text-xs font-mono p-3 rounded-lg shadow-lg whitespace-pre-wrap break-all max-h-48 overflow-y-auto">${snippet.command}</div>
    `;
    
    const tooltip = div.querySelector('.snippet-tooltip');
    div.addEventListener('mouseenter', () => {
      tooltip.classList.remove('hidden');
    });
    div.addEventListener('mouseleave', () => {
      tooltip.classList.add('hidden');
    });
    
    listEl.appendChild(div);
  });
}

async function executeSnippet(snippet) {
  const session = getActiveSession();
  if (!session || !session.shellId || !session.term) {
    showAlert("No Active Session", "Please connect to a server before running a snippet.", "warning");
    return;
  }

  session.term.writeln(`\r\n\x1b[1;33mRunning snippet: ${snippet.name}\x1b[0m\r\n`);
  try {
    const snippetCard = document.querySelector(`.snippet-item[data-id="${snippet.id}"]`);
    snippetCard?.classList.add("status-connected");
    showToast(`Running snippet: ${snippet.name}`, "info");
    await invoke("send_input", { shellId: session.shellId, input: snippet.command + "\n" });
    setTimeout(() => {
      snippetCard?.classList.remove("status-connected");
    }, 1200);
  } catch (error) {
    console.error("Failed to run snippet:", error);
    showAlert("Snippet Error", `${snippet.name} failed: ${error}`);
  }
}

function openSnippetModal() {
  document.getElementById("snippet-modal").classList.remove("hidden");
  document.getElementById("snippet-modal-title").textContent = "Add Snippet";
  document.getElementById("snippet-form").reset();
  document.getElementById("snippet-id").value = "";
}

function closeSnippetModal() {
  document.getElementById("snippet-modal").classList.add("hidden");
}

function openTerminalSettingsModal() {
  const fontSizeInput = document.getElementById("terminal-font-size");
  const scrollbackInput = document.getElementById("terminal-scrollback");
  const modal = document.getElementById("terminal-settings-modal");
  if (!fontSizeInput || !scrollbackInput || !modal) return;
  fontSizeInput.value = String(terminalSettings.fontSize);
  scrollbackInput.value = String(terminalSettings.scrollback);
  modal.classList.remove("hidden");
}

function closeTerminalSettingsModal() {
  document.getElementById("terminal-settings-modal")?.classList.add("hidden");
}

function openTerminalSearch() {
  if (!SearchAddonCtor) {
    showAlert("Search Unavailable", "Terminal search addon did not load. The rest of the app will continue working.", "warning");
    return;
  }
  const searchBar = document.getElementById("terminal-search-bar");
  const input = document.getElementById("terminal-search-input");
  if (!searchBar || !input) return;
  searchBar.classList.remove("hidden");
  input.focus();
  input.select();
}

function closeTerminalSearch() {
  document.getElementById("terminal-search-bar")?.classList.add("hidden");
}

function searchTerminal(direction = "next") {
  const query = document.getElementById("terminal-search-input")?.value || "";
  const session = getActiveSession();
  if (!query || !session?.searchAddon) return;
  if (direction === "previous") {
    session.searchAddon.findPrevious(query, { incremental: true });
  } else {
    session.searchAddon.findNext(query, { incremental: true });
  }
}

function closeDeleteModal() {
  const modal = document.getElementById("delete-confirm-modal");
  if (modal) {
    modal.classList.add("hidden");
  }
  pendingDeleteTarget = null;
}

function closeDisconnectConfirmModal() {
  const modal = document.getElementById("disconnect-confirm-modal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function closeAppConfirmModal() {
  document.getElementById("close-app-modal")?.classList.add("hidden");
}

function resolveCloseAppConfirm(result) {
  const resolve = pendingCloseAppResolve;
  pendingCloseAppResolve = null;
  closeAppConfirmModal();
  if (resolve) {
    resolve(result);
  }
}

function confirmCloseApp() {
  document.getElementById("close-app-modal")?.classList.remove("hidden");
  return new Promise((resolve) => {
    pendingCloseAppResolve = resolve;
  });
}

function resolveDisconnectConfirm(result) {
  const resolve = pendingDisconnectResolve;
  pendingDisconnectResolve = null;
  closeDisconnectConfirmModal();
  if (resolve) {
    resolve(result);
  }
}

function confirmDisconnect(label) {
  const modal = document.getElementById("disconnect-confirm-modal");
  const message = document.getElementById("disconnect-confirm-message");
  if (message) {
    message.textContent = `Disconnect from ${label}?`;
  }
  if (modal) {
    modal.classList.remove("hidden");
  }
  return new Promise((resolve) => {
    pendingDisconnectResolve = resolve;
  });
}

function openSnippetEditModal(id) {
  const snippet = snippets.find((s) => s.id === id);
  if (!snippet) return;

  document.getElementById("snippet-modal").classList.remove("hidden");
  document.getElementById("snippet-modal-title").textContent = "Edit Snippet";
  document.getElementById("snippet-id").value = snippet.id;
  document.getElementById("snippet-name").value = snippet.name;
  document.getElementById("snippet-command").value = snippet.command;
  document.getElementById("snippet-description").value = snippet.description || "";
}

async function saveSnippet(e) {
  e.preventDefault();

  const id = document.getElementById("snippet-id").value || crypto.randomUUID();
  const name = document.getElementById("snippet-name").value;
  const command = document.getElementById("snippet-command").value;
  const description = document.getElementById("snippet-description").value;

  const snippet = {
    id,
    name,
    command,
    description: description || null,
  };

  try {
    if (document.getElementById("snippet-id").value) {
      await invoke("update_snippet", { id, snippet });
    } else {
      await invoke("add_snippet", { snippet });
    }
    closeSnippetModal();
    loadSnippets();
  } catch (error) {
    console.error("Failed to save snippet:", error);
    showAlert("Save Failed", `Failed to save snippet: ${error}`);
  }
}

async function deleteSnippet(id) {
  const snippet = snippets.find((item) => item.id === id);
  openDeleteModal({
    kind: "snippet",
    id,
    label: snippet?.name || "this snippet",
  });
}

function initTabs() {
    const tabs = [
      { key: "servers", button: document.getElementById("tab-servers"), view: document.getElementById("view-servers") },
      { key: "snippets", button: document.getElementById("tab-snippets"), view: document.getElementById("view-snippets") },
      { key: "actions", button: document.getElementById("tab-actions"), view: document.getElementById("view-actions") },
    ].filter((tab) => tab.button && tab.view);

    if (tabs.length === 0) return;

    function setActiveTab(activeKey) {
      tabs.forEach(({ key, button, view }) => {
        const isActive = key === activeKey;
        button.classList.toggle("active", isActive);
        button.classList.toggle("inactive", !isActive);
        view.classList.toggle("hidden", !isActive);
      });
    }

    tabs.forEach(({ key, button }) => {
      button.classList.add("tab-btn");
      button.addEventListener("click", () => setActiveTab(key));
    });

    setActiveTab("servers");
}

function toggleFocusMode() {
    document.body.classList.toggle('focus-mode-active');
    setTimeout(() => {
        const active = getActiveSession();
        if (active?.id) {
          sessionManager?.setActiveSession(active.id);
        }
        active?.term?.focus?.();
    }, 300);
}

function disableInputCorrections() {
  const fields = document.querySelectorAll("input, textarea");
  fields.forEach((field) => {
    field.setAttribute("autocorrect", "off");
    field.setAttribute("autocapitalize", "off");
    field.setAttribute("spellcheck", "false");
  });
}

async function setupWindowCloseGuard() {
  const currentWindow = tauriWindow?.getCurrentWindow?.();
  if (!currentWindow?.onCloseRequested) return;

  await currentWindow.onCloseRequested(async (event) => {
    if (!hasActiveConnections()) {
      return;
    }

    if (closeRequestInProgress) {
      event.preventDefault();
      return;
    }

    closeRequestInProgress = true;
    const confirmed = await confirmCloseApp();
    closeRequestInProgress = false;

    if (!confirmed) {
      event.preventDefault();
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  try {
    initTheme();
    initTabs();
    initHeaderMenu();
    actionManager = initActionManager({
      invoke,
      listen,
      getServers: () => servers,
      showToast,
      showAlert,
      requestDelete: openDeleteModal,
    });
    sessionManager = createSessionManager({
      invoke,
      getServers: () => servers,
      getTerminalSettings: () => terminalSettings,
      getTerminalTheme,
      showAlert,
      showToast,
      logConnectionEvent,
      confirmDisconnect,
      onRefreshServers: loadServers,
      onSessionsChanged: renderServerList,
    });
    initAboutModal().catch((error) => console.error("About modal init failed:", error));
    disableInputCorrections();
    setupWindowCloseGuard();
    if (!SearchAddonCtor) {
      document.getElementById("terminal-search-btn")?.classList.add("hidden");
    }
    
    document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
    document.getElementById("terminal-settings-btn")?.addEventListener("click", openTerminalSettingsModal);
    document.getElementById("terminal-settings-cancel")?.addEventListener("click", closeTerminalSettingsModal);
    document.getElementById("terminal-settings-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const fontSizeInput = document.getElementById("terminal-font-size");
      const scrollbackInput = document.getElementById("terminal-scrollback");
      if (!fontSizeInput || !scrollbackInput) return;
      terminalSettings.fontSize = parseInt(fontSizeInput.value, 10);
      terminalSettings.scrollback = parseInt(scrollbackInput.value, 10);
      applyTerminalSettings();
      closeTerminalSettingsModal();
      showToast("Terminal settings updated.", "success");
    });
    document.getElementById("terminal-search-btn")?.addEventListener("click", openTerminalSearch);
    document.getElementById("terminal-search-close")?.addEventListener("click", closeTerminalSearch);
    document.getElementById("terminal-search-next")?.addEventListener("click", () => searchTerminal("next"));
    document.getElementById("terminal-search-prev")?.addEventListener("click", () => searchTerminal("previous"));
    document.getElementById("terminal-search-input")?.addEventListener("input", () => searchTerminal("next"));
    
    document.getElementById("focus-btn")?.addEventListener("click", toggleFocusMode);
    document.getElementById("exit-focus-btn")?.addEventListener("click", toggleFocusMode);
    document.getElementById("focus-toggle-btn")?.addEventListener("click", toggleFocusMode);
    document.getElementById("terminal-bg-toggle")?.addEventListener("click", toggleTerminalBackground);
    document.getElementById("reconnect-btn")?.addEventListener("click", () => {
      sessionManager?.reconnectActiveSession();
    });
    document.getElementById("server-key-browse-btn")?.addEventListener("click", () => {
      document.getElementById("server-key-file")?.click();
    });
    document.getElementById("server-key-file")?.addEventListener("change", async (event) => {
      const [file] = event.target.files || [];
      if (!file) return;
      const content = await file.text();
      const keyInput = document.getElementById("server-key");
      if (keyInput) {
        keyInput.value = content;
      }
      showToast(`Loaded key file: ${file.name}`, "success");
    });
    document.getElementById("close-app-cancel")?.addEventListener("click", () => resolveCloseAppConfirm(false));
    document.getElementById("close-app-confirm")?.addEventListener("click", () => resolveCloseAppConfirm(true));

    const serverFilterInput = document.getElementById("server-filter");
    if (serverFilterInput) {
      serverFilterInput.addEventListener("input", (event) => {
        serverFilterTerm = event.target.value || "";
        renderServerList();
      });
    }

    document.getElementById("clear-log-btn")?.addEventListener("click", () => {
        connectionLog = [];
        const listEl = document.getElementById("connection-log-list");
        if (listEl) listEl.innerHTML = "";
    });

    initTerminal();
    applyTerminalSettings();
    
    document.getElementById("add-server-btn")?.addEventListener("click", openModal);
    
    document.getElementById("cancel-btn")?.addEventListener("click", closeModal);
    document.getElementById("server-form")?.addEventListener("submit", saveServer);
    document.getElementById("disconnect-btn")?.addEventListener("click", () => disconnectFromServer(null, { requireConfirm: true }));
    document.getElementById("delete-cancel-btn")?.addEventListener("click", closeDeleteModal);
    document.getElementById("delete-confirm-btn")?.addEventListener("click", confirmDeleteTarget);
    document.getElementById("disconnect-cancel-btn")?.addEventListener("click", () => resolveDisconnectConfirm(false));
    document.getElementById("disconnect-confirm-btn")?.addEventListener("click", () => resolveDisconnectConfirm(true));
    const disconnectModal = document.getElementById("disconnect-confirm-modal");
    if (disconnectModal) {
      disconnectModal.addEventListener("click", (event) => {
        if (event.target === disconnectModal) {
          resolveDisconnectConfirm(false);
        }
      });
    }
    const deleteModal = document.getElementById("delete-confirm-modal");
    if (deleteModal) {
      deleteModal.addEventListener("click", (event) => {
        if (event.target === deleteModal) {
          closeDeleteModal();
        }
      });
    }
    const terminalSettingsModal = document.getElementById("terminal-settings-modal");
    if (terminalSettingsModal) {
      terminalSettingsModal.addEventListener("click", (event) => {
        if (event.target === terminalSettingsModal) {
          closeTerminalSettingsModal();
        }
      });
    }
    const closeAppModal = document.getElementById("close-app-modal");
    if (closeAppModal) {
      closeAppModal.addEventListener("click", (event) => {
        if (event.target === closeAppModal) {
          resolveCloseAppConfirm(false);
        }
      });
    }
    document.getElementById("add-snippet-btn")?.addEventListener("click", openSnippetModal);
    document.getElementById("snippet-cancel-btn")?.addEventListener("click", closeSnippetModal);
    document.getElementById("snippet-form")?.addEventListener("submit", saveSnippet);
    document.getElementById("snippet-list")?.addEventListener("click", (e) => {
    const target = e.target;
    const button = target.closest("button");
    if (button) {
      const id = button.dataset.id;
      if (!id) return;
      if (button.classList.contains("snippet-run-btn")) {
        const snippet = snippets.find((s) => s.id === id);
        if (snippet) executeSnippet(snippet);
        return;
      }
      if (button.classList.contains("snippet-edit-btn")) {
        openSnippetEditModal(id);
        return;
      }
      if (button.classList.contains("snippet-delete-btn")) {
        deleteSnippet(id);
      }
      return;
    }

    const item = target.closest(".snippet-item"); // Changed from li to .snippet-item
    if (!item) return;
    const id = item.querySelector(".snippet-run-btn")?.dataset.id; // Look for run button data id
    if (!id) return;
    const snippet = snippets.find((s) => s.id === id);
    if (snippet) executeSnippet(snippet);
  });
    document.getElementById("auth-type")?.addEventListener("change", (e) => {
    if (e.target.value === "password") {
      document.getElementById("password-field").classList.remove("hidden");
      document.getElementById("key-field").classList.add("hidden");
    } else {
      document.getElementById("password-field").classList.add("hidden");
      document.getElementById("key-field").classList.remove("hidden");
    }
  });
  
  // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const sessionIndex = parseInt(e.key) - 1;
        const tabSessions = sessionManager?.getKeyboardSessions() || [];
        if (tabSessions[sessionIndex]) {
          sessionManager?.setActiveSession(tabSessions[sessionIndex].id);
        }
      }
      else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        openModal();
      }
      else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        openTerminalSearch();
      }
      else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        terminalSettings.fontSize = Math.min(24, terminalSettings.fontSize + 1);
        applyTerminalSettings();
      }
      else if (e.key === "-") {
        e.preventDefault();
        terminalSettings.fontSize = Math.max(10, terminalSettings.fontSize - 1);
        applyTerminalSettings();
      }
      else if (e.key === "w") {
        e.preventDefault();
        const activeSession = getActiveSession();
        if (activeSession && activeSession.server) {
          disconnectFromServer(null, { requireConfirm: true });
        }
      }
    }
    if (e.key === "Escape") {
      closeTerminalSearch();
    }
  });
  
    loadServers();
    loadSnippets();
    actionManager.loadActions();

    listen("connection-state", (event) => {
      sessionManager?.handleConnectionEvent(event.payload);
    });

    listen("host-key-prompt", (event) => {
    openHostKeyModal(event.payload);
    logConnectionEvent("Host key prompt", `${event.payload.host}:${event.payload.port}`, "warning");
  });

    listen("host-key-mismatch", (event) => {
    const payload = event.payload;
    const message = `Host key mismatch for ${payload.host}:${payload.port}`;
    showAlert("Host Key Mismatch", `${message}. Stored fingerprint: ${payload.stored_fingerprint}`);
    logConnectionEvent("Host key mismatch", `${payload.host}:${payload.port}`, "error");
  });

    listen("terminal-output", (event) => {
      sessionManager?.handleTerminalOutput(event.payload);
    });

    document.getElementById("host-key-trust")?.addEventListener("click", async () => {
    if (!pendingHostKey) return;
    try {
      await invoke("trust_host_key", {
        id: pendingHostKey.id,
      });
      logConnectionEvent("Host key trusted", `${pendingHostKey.host}:${pendingHostKey.port}`, "success");
    } catch (error) {
      console.error("Failed to trust host key:", error);
      showAlert("Trust Failed", error);
    } finally {
      pendingHostKey = null;
      closeHostKeyModal();
      drainHostKeyQueue();
    }
  });

    document.getElementById("host-key-reject")?.addEventListener("click", async () => {
    if (!pendingHostKey) return;
    try {
      await invoke("reject_host_key", {
        id: pendingHostKey.id,
      });
      logConnectionEvent("Host key rejected", `${pendingHostKey.host}:${pendingHostKey.port}`, "warning");
      showAlert("Host Key Rejected", "Connection aborted by user.", "warning");
    } catch (error) {
      console.error("Failed to reject host key:", error);
      showAlert("Reject Failed", error);
    } finally {
      pendingHostKey = null;
      closeHostKeyModal();
      drainHostKeyQueue();
    }
    });
  } catch (error) {
    console.error("Startup error:", error);
    showAlert("Startup Error", String(error));
    loadServers();
    loadSnippets();
  }
});
