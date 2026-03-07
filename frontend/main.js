import { initAboutModal } from "./components/about-modal.js";
import { initActionManager } from "./components/actions-manager.js";
import { initHeaderMenu } from "./components/header-menu.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const tauriWindow = window.__TAURI__.window || null;
const SearchAddonCtor =
  typeof window.SearchAddon !== "undefined" && typeof window.SearchAddon.SearchAddon === "function"
    ? window.SearchAddon.SearchAddon
    : null;

const MAX_CONNECTIONS = 5;
const DEFAULT_TERMINAL_SETTINGS = {
  fontSize: 14,
  scrollback: 5000,
};
let servers = [];
let sessions = new Map(); // Map<serverId | welcomeId, SessionState>
let activeSessionId = null;
const welcomeSessionId = "__welcome__";
let connectionLog = [];
let pendingHostKey = null;
let pendingDeleteTarget = null;
let pendingDisconnectResolve = null;
let pendingCloseAppResolve = null;
let localEchoEnabled = false;
let terminalTransparent = false;
let serverFilterTerm = "";
let terminalSettings = loadTerminalSettings();
let closeRequestInProgress = false;
let actionManager = null;

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

function getTerminalContainer() {
  const container = document.getElementById("terminal-container");
  if (!container) {
    throw new Error("Terminal container not found");
  }
  container.classList.add("relative");
  return container;
}

function updateStatusBarForActiveSession() {
  const statusBarHost = document.getElementById("status-bar-host");
  const statusBarState = document.getElementById("status-bar-state");
  updateSessionCount();
  const session = getActiveSession();
  if (!session || !session.server) {
    statusBarHost.textContent = "Not connected";
    statusBarState.textContent = "Idle";
    statusBarState.className = "font-medium text-xs uppercase tracking-wide text-gray-500";
    updateHeaderButtons();
    return;
  }

  const label = `${session.server.user}@${session.server.host}:${session.server.port}`;
  statusBarHost.textContent = label;

  const state = session.connectionState?.type || "Disconnected";
  statusBarState.textContent = state;
  switch (state) {
    case "Connecting":
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-yellow-600 dark:text-yellow-400";
      break;
    case "Connected":
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-green-600 dark:text-green-400";
      break;
    case "Error":
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-red-600 dark:text-red-400";
      break;
    default:
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-gray-600 dark:text-gray-400";
  }
  updateHeaderButtons();
}

function updateHeaderButtons() {
  const session = getActiveSession();
  const disconnectBtn = document.getElementById("disconnect-btn");
  const reconnectBtn = document.getElementById("reconnect-btn");
  if (!disconnectBtn || !reconnectBtn) return;

  if (!session?.server) {
    disconnectBtn.classList.add("hidden");
    reconnectBtn.classList.add("hidden");
    return;
  }

  const state = session.connectionState?.type;
  disconnectBtn.classList.toggle("hidden", state !== "Connected");
  reconnectBtn.classList.toggle("hidden", !["Disconnected", "Error"].includes(state));
}

function getActiveSession() {
  return activeSessionId ? sessions.get(activeSessionId) : null;
}

function hasActiveConnections() {
  return Array.from(sessions.values()).some((session) => {
    const type = session.connectionState?.type;
    return type === "Connected" || type === "Connecting";
  });
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

function setTerminalOption(term, key, value) {
  if (!term) return;
  if (typeof term.setOption === "function") {
    term.setOption(key, value);
    return;
  }
  if (term.options && typeof term.options === "object") {
    term.options[key] = value;
  }
}

function applyTerminalSettings() {
  persistTerminalSettings();
  sessions.forEach((session) => {
    setTerminalOption(session.term, "fontSize", terminalSettings.fontSize);
    setTerminalOption(session.term, "scrollback", terminalSettings.scrollback);
    session.fitAddon?.fit();
    syncPtySize(session);
  });
}

function focusActiveTerminal({ defer = false } = {}) {
  const session = getActiveSession();
  const term = session?.term;
  if (!term) return;
  const focusFn = () => term.focus();
  if (defer) {
    requestAnimationFrame(focusFn);
  } else {
    focusFn();
  }
}

function getSessionByShellId(shellId) {
  if (!shellId) return null;
  for (const session of sessions.values()) {
    if (session.shellId === shellId) return session;
  }
  return null;
}

function getSessionByServerId(serverId) {
  if (!serverId) return null;
  return sessions.get(serverId) || null;
}

function writeToSessionTerminal(session, output) {
  if (!session?.term) return;
  
  // Create a buffer for batching output if it doesn't exist
  if (!session.outputBuffer) {
    session.outputBuffer = '';
    session.outputTimeout = null;
    
    // Flush buffer every 16ms (60fps) for smoother, more responsive feel
    const flushBuffer = () => {
      if (session.outputBuffer) {
        session.term.write(session.outputBuffer);
        if (session.autoScrollEnabled) {
          session.term.scrollToBottom();
        }
        session.outputBuffer = '';
      }
      session.outputTimeout = null;
    };
    
    session.flushBuffer = flushBuffer;
  }
  
  // Add output to buffer
  session.outputBuffer += output;
  
  // Schedule flush if not already scheduled - reduced from 50ms to 16ms
  if (!session.outputTimeout) {
    session.outputTimeout = setTimeout(session.flushBuffer, 16);
  }
}

function createFallbackTerminal(pane, reason) {
  pane.innerHTML = `<div class="text-xs text-gray-500 dark:text-gray-400 p-4">${reason}</div>`;
  return {
    cols: 80,
    rows: 24,
    write: () => {},
    writeln: () => {},
    reset: () => {},
    focus: () => {},
    setOption: () => {},
    onData: () => {},
    onKey: () => {},
    onScroll: () => {},
    scrollToBottom: () => {},
  };
}

function ensureSession(server) {
  const existing = sessions.get(server.id);
  if (existing) {
    existing.server = server;
    return existing;
  }

  const { term, fitAddon, searchAddon, container } = createTerminalPane(server.id);
  const session = {
    id: server.id,
    server,
    shellId: null,
    term,
    fitAddon,
    searchAddon,
    container,
    connectionState: { type: "Disconnected" },
    autoScrollEnabled: true,
  };
  sessions.set(server.id, session);
  return session;
}

function createTerminalPane(sessionId) {
  const hostContainer = getTerminalContainer();
  const pane = document.createElement("div");
  pane.className = "terminal-pane";
  pane.dataset.sessionId = sessionId;
  pane.style.display = "none";
  hostContainer.appendChild(pane);

  if (typeof window.Terminal !== "function") {
    const term = createFallbackTerminal(pane, "Terminal engine failed to load. Connection list still works.");
    return { term, fitAddon: { fit: () => {} }, searchAddon: null, container: pane };
  }
  if (!window.FitAddon || typeof window.FitAddon.FitAddon !== "function") {
    const term = createFallbackTerminal(pane, "Terminal resize addon failed to load. Connection list still works.");
    return { term, fitAddon: { fit: () => {} }, searchAddon: null, container: pane };
  }

  const termInstance = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: terminalSettings.fontSize,
    theme: getTerminalTheme(),
    scrollback: terminalSettings.scrollback,
    fastScrollModifier: 'alt',
    rightClickSelectsWord: true,
  });

  const paneFitAddon = new FitAddon.FitAddon();
  const searchAddon = SearchAddonCtor ? new SearchAddonCtor() : null;
  termInstance.loadAddon(paneFitAddon);
  if (searchAddon) {
    termInstance.loadAddon(searchAddon);
  }
  termInstance.open(pane);
  paneFitAddon.fit();

  if (sessionId === welcomeSessionId) {
    termInstance.writeln("\x1b[1;32mSSH Thing\x1b[0m");
    termInstance.writeln("Connect to a server to begin...\r\n");
  } else {
    termInstance.writeln("\x1b[1;32mConnecting...\x1b[0m\r\n");
  }

  // Optimized input handling - send immediately for maximum responsiveness
  termInstance.onData((data) => {
    const session = sessions.get(sessionId);
    if (session && session.shellId && session.connectionState.type === "Connected") {
      // Send immediately without await for maximum responsiveness
      invoke("send_input", { shellId: session.shellId, input: data }).catch(console.error);
    }
  });

  termInstance.onKey((event) => {
    const session = sessions.get(sessionId);
    const shellId = session?.shellId;
    if (!shellId) return;
    const { domEvent } = event;
    if (domEvent.ctrlKey || domEvent.metaKey) {
      let input = null;
      switch (domEvent.key) {
        case 'c':
          input = '\x03';
          break;
        case 'd':
          input = '\x04';
          break;
        case 'z':
          input = '\x1a';
          break;
        case 'l':
          input = '\x0c';
          break;
        case 'a':
          input = '\x01';
          break;
        case 'e':
          input = '\x05';
          break;
        case 'u':
          input = '\x15';
          break;
        case 'k':
          input = '\x0b';
          break;
      }
      if (input && shellId) {
        invoke("send_input", { shellId, input }).catch(console.error);
        domEvent.preventDefault();
        domEvent.stopPropagation();
      }
    }
  });

  termInstance.onScroll((newRow) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const maxScroll = termInstance.rows - 1;
    session.autoScrollEnabled = newRow >= maxScroll;
  });

  return { term: termInstance, fitAddon: paneFitAddon, searchAddon, container: pane };
}

function setActiveSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return;
  const hostContainer = getTerminalContainer();
  Array.from(hostContainer.children).forEach((child) => {
    child.style.display = child.dataset.sessionId === sessionId ? "block" : "none";
  });
  activeSessionId = sessionId;
  const session = sessions.get(sessionId);
  if (session?.fitAddon) {
    session.fitAddon.fit();
    syncPtySize(session);
  }
  updateStatusBarForActiveSession();
  updateSessionTabs();
  focusActiveTerminal({ defer: true });
}

function updateSessionTabs() {
  const tabsContainer = document.getElementById("session-tabs");
  const connectedSessions = Array.from(sessions.entries()).filter(([id, session]) => 
    session.connectionState.type === "Connected"
  );

  if (connectedSessions.length <= 1) {
    tabsContainer.classList.add("hidden");
    return;
  }

  tabsContainer.classList.remove("hidden");
  tabsContainer.innerHTML = "";

  connectedSessions.forEach(([id, session]) => {
    const isActive = activeSessionId === id;
    const server = session.server;
    const displayName = server?.nickname || `${server?.user}@${server?.host}` || "Unknown";
    
    const tab = document.createElement("button");
    tab.className = `flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
      isActive 
        ? "bg-blue-500 text-white" 
        : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
    }`;
    tab.innerHTML = `
      <div class="w-1.5 h-1.5 rounded-full bg-green-400"></div>
      <span class="truncate max-w-32">${displayName}</span>
    `;
    tab.addEventListener("click", () => setActiveSession(id));
    tabsContainer.appendChild(tab);
  });
  updateSessionCount();
}

function updateSessionCount() {
  const countEl = document.getElementById("session-count");
  if (!countEl) return;
  const connectedCount = Array.from(sessions.values()).filter((s) => s.connectionState.type === "Connected").length;
  countEl.textContent = `Sessions: ${connectedCount}`;
}

function ensureWelcomeSession() {
  if (sessions.has(welcomeSessionId)) return;
  const { term, fitAddon, searchAddon, container } = createTerminalPane(welcomeSessionId);
  sessions.set(welcomeSessionId, {
    id: welcomeSessionId,
    server: null,
    shellId: null,
    term,
    fitAddon,
    searchAddon,
    container,
    connectionState: { type: "Disconnected" },
    autoScrollEnabled: true,
  });
  setActiveSession(welcomeSessionId);
}

function removeWelcomeSession() {
  if (!sessions.has(welcomeSessionId)) return;
  const session = sessions.get(welcomeSessionId);
  if (session?.container?.parentElement) {
    session.container.parentElement.removeChild(session.container);
  }
  sessions.delete(welcomeSessionId);
  if (activeSessionId === welcomeSessionId) {
    activeSessionId = null;
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
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = savedTheme ? savedTheme === 'dark' : prefersDark;
  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

function openHostKeyModal(prompt) {
  pendingHostKey = prompt;
  document.getElementById("host-key-host").textContent = `${prompt.host}:${prompt.port}`;
  document.getElementById("host-key-type").textContent = prompt.key_type;
  document.getElementById("host-key-fingerprint").textContent = prompt.fingerprint;
  document.getElementById("host-key-modal").classList.remove("hidden");
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

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  sessions.forEach((session) => {
    setTerminalOption(session.term, "theme", getTerminalTheme());
  });
}

function toggleTerminalBackground() {
  const isDark = document.documentElement.classList.contains('dark');
  if (!isDark) {
    // Disable glass in light mode
    terminalTransparent = false;
  } else {
    terminalTransparent = !terminalTransparent;
  }
  document.body.classList.toggle('terminal-transparent', terminalTransparent && isDark);
  const label = document.getElementById('header-terminal-bg-label');
  if (label) {
    label.textContent = terminalTransparent && isDark ? 'Glass' : 'Solid';
  }
  sessions.forEach((session) => {
    setTerminalOption(session.term, "theme", getTerminalTheme());
  });
}

function getTerminalTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  const background = !isDark ? '#0f111a' : (terminalTransparent ? 'transparent' : '#0f111a');
  return {
    background,
    foreground: isDark ? '#cdd6f4' : '#e6e9ef',
    cursor: isDark ? '#f5c2e7' : '#82aaff',
    selection: 'rgba(148, 163, 184, 0.35)',
  };
}

function initTerminal() {
  const terminalEl = document.getElementById("terminal-container");
  if (terminalEl) {
    terminalEl.innerHTML = "";
  }
  ensureWelcomeSession();
  window.addEventListener('resize', () => {
    const active = getActiveSession();
    if (active?.fitAddon) {
      active.fitAddon.fit();
      syncPtySize(active);
    }
  });
}

function updateConnectionState(session, state) {
  const previousType = session.connectionState?.type || "Disconnected";
  const normalizedState = normalizeConnectionState(state);
  session.connectionState = normalizedState;

  const statusEl = document.getElementById("connection-status");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const statusIndicator = document.getElementById("status-indicator");

  const label = session.server
    ? `${session.server.user}@${session.server.host}:${session.server.port}`
    : "";

  if (session.id === activeSessionId) {
    switch (normalizedState.type) {
      case "Connecting":
        session.term.reset();
        session.term.writeln("\x1b[1;33mConnecting to server...\x1b[0m");
        statusEl.textContent = "Connecting...";
        statusEl.className = "text-xs font-medium text-white bg-yellow-500 px-2.5 py-0.5 rounded-full";
        statusIndicator.className = "w-2 h-2 rounded-full bg-yellow-500 animate-pulse";
        disconnectBtn.classList.add("hidden");
        document.getElementById("reconnect-btn")?.classList.add("hidden");
        break;
      case "Connected":
        session.term.reset();
        session.term.writeln(`\x1b[1;32mConnected successfully to ${label}!\x1b[0m`);
        statusEl.textContent = "Connected";
        statusEl.className = "text-xs font-medium text-white bg-green-500 px-2.5 py-0.5 rounded-full";
        statusIndicator.className = "w-2 h-2 rounded-full bg-green-500";
        disconnectBtn.classList.remove("hidden");
        document.getElementById("reconnect-btn")?.classList.add("hidden");
        break;
      case "Disconnected":
        session.term.reset();
        session.term.writeln("Disconnected from server.");
        statusEl.textContent = "Disconnected";
        statusEl.className = "text-xs font-medium text-gray-600 bg-gray-200 dark:text-gray-400 dark:bg-gray-700 px-2.5 py-0.5 rounded-full";
        statusIndicator.className = "w-2 h-2 rounded-full bg-gray-400";
        disconnectBtn.classList.add("hidden");
        document.getElementById("reconnect-btn")?.classList.remove("hidden");
        break;
      case "Error":
        session.term.reset();
        session.term.writeln(`\x1b[1;31mConnection error: ${normalizedState.error}\x1b[0m`);
        statusEl.textContent = "Error";
        statusEl.className = "text-xs font-medium text-white bg-red-500 px-2.5 py-0.5 rounded-full";
        statusIndicator.className = "w-2 h-2 rounded-full bg-red-500";
        disconnectBtn.classList.add("hidden");
        document.getElementById("reconnect-btn")?.classList.remove("hidden");
        showAlert(getErrorType(normalizedState.error), normalizedState.error);
        break;
    }
    updateStatusBarForActiveSession();
    updateSessionTabs();
    session.fitAddon?.fit();
  }

  switch (normalizedState.type) {
    case "Connecting":
      logConnectionEvent("Connecting", label, "info");
      break;
    case "Connected":
      logConnectionEvent("Connected", label, "success");
      break;
    case "Disconnected":
      logConnectionEvent("Disconnected", label, "info");
      break;
    case "Error":
      logConnectionEvent(`Error: ${normalizedState.error}`, label, "error");
      break;
  }

  if (
    session.server &&
    session.id !== activeSessionId &&
    previousType === "Connected" &&
    ["Disconnected", "Error"].includes(normalizedState.type)
  ) {
    const name = session.server.nickname || `${session.server.user}@${session.server.host}`;
    const suffix = normalizedState.type === "Error" && normalizedState.error
      ? `: ${normalizedState.error}`
      : "";
    showToast(`${name} disconnected${suffix}`, normalizedState.type === "Error" ? "error" : "warning");
  }

  // Refresh server list so badges/buttons reflect latest state
  renderServerList();
}
function normalizeConnectionState(state) {
  if (!state) {
    return { type: "Disconnected" };
  }
  if (typeof state === "string") {
    return { type: state };
  }
  if (state.type) {
    return state;
  }
  if (state.Error) {
    return { type: "Error", error: state.Error };
  }
  if (state.state && state.state.type) {
    return state.state;
  }
  return { type: "Disconnected" };
}

function normalizeConnectionEvent(payload) {
  if (!payload || typeof payload === "string") {
    return { state: normalizeConnectionState(payload), serverId: null, shellId: null };
  }
  if (payload.state) {
    return {
      state: normalizeConnectionState(payload.state),
      serverId: payload.server_id ?? payload.serverId ?? null,
      shellId: payload.shell_id ?? payload.shellId ?? null,
    };
  }
  return { state: normalizeConnectionState(payload), serverId: null, shellId: null };
}

function showAlert(title, message, type = 'error') {
  const alertModal = document.getElementById('alert-modal');
  const alertTitle = document.getElementById('alert-title');
  const alertMessage = document.getElementById('alert-message');
  const alertIcon = document.getElementById('alert-icon');
  const alertIconSvg = document.getElementById('alert-icon-svg');

  alertTitle.textContent = title;
  alertMessage.textContent = message;

  alertIcon.className = 'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ' + type;
  alertIconSvg.innerHTML = getIconForType(type);

  alertModal.classList.remove('hidden');

  document.getElementById('alert-ok-btn').onclick = () => {
    alertModal.classList.add('hidden');
  };

  alertModal.onclick = (e) => {
    if (e.target === alertModal) {
      alertModal.classList.add('hidden');
    }
  };
}

function getIconForType(type) {
  switch (type) {
    case 'error':
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
    case 'warning':
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />';
    case 'success':
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />';
    default:
      return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
  }
}

function getErrorType(error) {
  const errorLower = error.toLowerCase();
  if (errorLower.includes('authentication') || errorLower.includes('auth') || errorLower.includes('password') || errorLower.includes('key')) {
    return 'Authentication Error';
  }
  if (errorLower.includes('timeout') || errorLower.includes('timed out') || errorLower.includes('connection timed')) {
    return 'Connection Timeout';
  }
  if (errorLower.includes('disconnect') || errorLower.includes('closed') || errorLower.includes('broken pipe') || errorLower.includes('eof')) {
    return 'Connection Disconnected';
  }
  return 'Connection Error';
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

function syncPtySize(session) {
  if (!session || !session.shellId || !session.term) return;
  const width = session.term.cols;
  const height = session.term.rows;
  invoke("resize", { shellId: session.shellId, width, height }).catch(console.error);
}
function renderServerList() {
  const listEl = document.getElementById("server-list");
  listEl.innerHTML = "";
  const filterWrap = document.getElementById("server-filter-wrap");
  const normalizedTerm = serverFilterTerm.trim().toLowerCase();
  const filteredServers = servers.filter((server) => {
    if (!normalizedTerm) return true;
    const nickname = server.nickname || "";
    const haystack = `${nickname} ${server.user} ${server.host}`.toLowerCase();
    return haystack.includes(normalizedTerm);
  }).sort((left, right) => (right.last_connected_at || 0) - (left.last_connected_at || 0));

  if (filterWrap) {
    filterWrap.classList.toggle("hidden", servers.length < 6);
  }

  if (servers.length === 0) {
    listEl.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 mt-10 text-sm">No servers added yet.<br>Click "Add" to get started.</div>`;
    return;
  }

  if (filteredServers.length === 0) {
    listEl.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 mt-10 text-sm">No matches for "${serverFilterTerm}".</div>`;
    return;
  }

  const connectedServers = [];
  const otherServers = [];

  filteredServers.forEach((server) => {
    const session = sessions.get(server.id);
    const connectionState = session?.connectionState || { type: "Disconnected" };
    const isConnected = connectionState.type === "Connected";
    const isConnecting = connectionState.type === "Connecting";
    
    if (isConnected || isConnecting) {
      connectedServers.push({ server, session, connectionState });
    } else {
      otherServers.push({ server, session, connectionState });
    }
  });

  function createServerCard(server, connectionState) {
    const session = sessions.get(server.id);
    const isActive = activeSessionId === server.id;
    const isConnected = connectionState.type === "Connected";
    const isConnecting = connectionState.type === "Connecting";
    const isErrored = connectionState.type === "Error";
    
    const div = document.createElement("div");
    
    let statusClass = "";
    if (isActive && isConnected) {
      statusClass = "status-active";
    } else if (isConnected) {
      statusClass = "status-connected";
    } else if (isConnecting) {
      statusClass = "status-connecting";
    } else if (isErrored) {
      statusClass = "status-error";
    }
    
    div.className = `server-item bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/80 rounded-lg px-3 py-2.5 shadow-sm group flex items-center gap-3 cursor-pointer ${statusClass}`;

    const displayName = server.nickname && server.nickname.trim().length > 0 ? server.nickname : `${server.user}@${server.host}`;
    const subtitle = server.nickname && server.nickname.trim().length > 0
      ? `${server.user}@${server.host}`
      : `Port ${server.port}`;
    const meta = [];
    meta.push(`:${server.port}`);
    meta.push(formatLastConnected(server.last_connected_at));

    let statusDot = "";
    switch (connectionState.type) {
      case "Connecting":
        statusDot = '<div class="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0"></div>';
        break;
      case "Connected":
        statusDot = '<div class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></div>';
        break;
      case "Error":
        statusDot = '<div class="w-2 h-2 rounded-full bg-red-500 flex-shrink-0"></div>';
        break;
      default:
        statusDot = '<div class="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500 flex-shrink-0"></div>';
    }

    let buttonLabel = "Connect";
    let buttonClass = "ghost-btn-success";
    let buttonIcon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>';
    if (isConnected) {
      buttonLabel = "Disconnect";
      buttonClass = "ghost-btn-danger";
      buttonIcon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>';
    } else if (isConnecting) {
      buttonLabel = "...";
      buttonClass = "";
      buttonIcon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>';
    }

    div.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        ${statusDot}
        <div class="min-w-0 flex-1">
          <div class="server-card-name truncate">${displayName}</div>
          <div class="server-card-subtitle truncate">${subtitle}</div>
          <div class="server-card-meta truncate">${meta.join(" • ")}</div>
        </div>
      </div>
      <div class="server-actions flex gap-1 flex-shrink-0">
        <button class="server-action-btn duplicate-btn" data-id="${server.id}" title="Duplicate">
          <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M10 20h8a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z"></path></svg>
        </button>
        <button class="server-action-btn edit-btn" data-id="${server.id}" title="Edit">
          <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
        </button>
        <button class="server-action-btn delete delete-btn" data-id="${server.id}" title="Delete">
          <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
      </div>
      <button class="ghost-btn connect-btn ${buttonClass} flex-shrink-0" data-id="${server.id}">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${buttonIcon}</svg>
        ${buttonLabel}
      </button>
    `;
    
    div.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (isConnected) {
        setActiveSession(server.id);
      }
    });

    return div;
  }

  if (connectedServers.length > 0) {
    const connectedLabel = document.createElement("div");
    connectedLabel.className = "server-section-label";
    connectedLabel.textContent = "Connected";
    listEl.appendChild(connectedLabel);

    connectedServers.forEach(({ server, connectionState }) => {
      listEl.appendChild(createServerCard(server, connectionState));
    });
  }

  if (otherServers.length > 0) {
    const otherLabel = document.createElement("div");
    otherLabel.className = "server-section-label";
    otherLabel.textContent = connectedServers.length > 0 ? "Other Servers" : "Servers";
    listEl.appendChild(otherLabel);

    otherServers.forEach(({ server, connectionState }) => {
      listEl.appendChild(createServerCard(server, connectionState));
    });
  }

  updateSessionTabs();
}

async function connectToServer(id) {
  const server = servers.find((s) => s.id === id);
  if (!server) return;

  const existingSession = sessions.get(id);
  const activeSessionsCount = Array.from(sessions.values()).filter((s) =>
    s.connectionState.type === "Connected" || s.connectionState.type === "Connecting"
  ).length;

  const isExistingActive =
    existingSession && (existingSession.connectionState.type === "Connected" || existingSession.connectionState.type === "Connecting");

  if (!isExistingActive && activeSessionsCount >= MAX_CONNECTIONS) {
    showAlert(
      "Session Limit Reached",
      `You can have up to ${MAX_CONNECTIONS} active sessions. Disconnect one to open another.`,
      "warning"
    );
    return;
  }

  removeWelcomeSession();
  const session = existingSession || ensureSession(server);
  if (session.connectionState.type === "Connected" && session.shellId) {
    setActiveSession(session.id);
    return;
  }
  setActiveSession(session.id);
  updateConnectionState(session, "Connecting");

  try {
    const newShellId = await invoke("connect", { server });
    session.shellId = newShellId;
    syncPtySize(session);
    updateConnectionState(session, "Connected");
    logConnectionEvent("Shell opened", `${server.user}@${server.host}:${server.port}`, "success");
    loadServers();
  } catch (error) {
    console.error("Failed to connect:", error);
    updateConnectionState(session, { type: "Error", error: String(error) });
  }
}

async function disconnectFromServer(serverId = null, { requireConfirm = false } = {}) {
  // Normalize to serverId string (ignore PointerEvent payloads)
  const resolvedId = (() => {
    if (!serverId) return null;
    if (typeof serverId === "string") return serverId;
    if (serverId && typeof serverId === "object" && "target" in serverId) {
      const target = serverId.target?.closest?.(".connect-btn") || serverId.currentTarget?.closest?.(".connect-btn");
      return target?.dataset?.id || null;
    }
    return null;
  })();

  console.log("[disconnect] click", { serverId, resolvedId, activeSessionId, passedId: serverId });

  const session = resolvedId ? sessions.get(resolvedId) : getActiveSession();
  if (!session || !session.server) {
    console.warn("[disconnect] no session/server", { serverId, resolvedId, activeSessionId });
    return;
  }

  if (requireConfirm) {
    const label = session.server.nickname && session.server.nickname.trim().length > 0
      ? session.server.nickname
      : `${session.server.user}@${session.server.host}`;
    const confirmed = await confirmDisconnect(label);
    if (!confirmed) return;
  }

  try {
    // Show immediate UI feedback
    const headerDisconnect = document.getElementById("disconnect-btn");
    const cardDisconnect = document.querySelector(`.connect-btn[data-id="${session.server.id}"]`);
    if (headerDisconnect) {
      headerDisconnect.disabled = true;
      headerDisconnect.classList.add("opacity-70", "cursor-not-allowed");
    }
    if (cardDisconnect) {
      cardDisconnect.disabled = true;
      cardDisconnect.textContent = "Disconnecting...";
      cardDisconnect.classList.add("opacity-70", "cursor-wait");
    }

    const payload = { serverId: session.server.id };
    console.log("[disconnect] invoking", payload);
    await invoke("disconnect", payload);
    
    // Clean up session
    if (session.container?.parentElement) {
      session.container.parentElement.removeChild(session.container);
    }
    sessions.delete(session.server.id);
    
    // Switch to another session or show welcome
    const remainingSessions = Array.from(sessions.values()).filter(s => s.connectionState.type === "Connected");
    if (remainingSessions.length > 0) {
      setActiveSession(remainingSessions[0].id);
    } else {
      ensureWelcomeSession();
      setActiveSession(welcomeSessionId);
    }
    
    logConnectionEvent("Disconnect requested", "", "info");
  } catch (error) {
    console.error("Failed to disconnect:", error);
    showAlert("Disconnect Failed", String(error));
  } finally {
    renderServerList();
    updateStatusBarForActiveSession();
    // Restore button states
    const headerDisconnect = document.getElementById("disconnect-btn");
    const cardDisconnect = document.querySelector(`.connect-btn[data-id="${session?.server?.id}"]`);
    if (headerDisconnect) {
      headerDisconnect.disabled = false;
      headerDisconnect.classList.remove("opacity-70", "cursor-not-allowed");
    }
    if (cardDisconnect) {
      cardDisconnect.disabled = false;
      cardDisconnect.classList.remove("opacity-70", "cursor-wait");
    }
  }
}

// Global handlers for inline fallback clicks
window.handleHeaderDisconnect = () => disconnectFromServer(null, { requireConfirm: true });
window.handleCardDisconnect = (id) => {
  const session = sessions.get(id);
  const state = session?.connectionState?.type;
  if (state === "Connected" || state === "Connecting") {
    setActiveSession(id);
    disconnectFromServer(id, { requireConfirm: true });
  } else {
    connectToServer(id);
  }
};

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
        if (active?.fitAddon) {
          active.fitAddon.fit();
          syncPtySize(active);
        }
        focusActiveTerminal();
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
      const session = getActiveSession();
      if (session?.server) {
        connectToServer(session.server.id);
      }
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
    document.getElementById("server-list")?.addEventListener("click", (e) => {
    const target = e.target;
    const button = target.closest("button");
    const item = target.closest(".server-item");
    
    if (!button) return;
    const id = button.dataset.id;
    if (!id) return;
    
    if (button.classList.contains("connect-btn")) {
      const session = sessions.get(id);
      if (session && session.connectionState.type === "Connected") {
        setActiveSession(id);
        disconnectFromServer(id, { requireConfirm: true });
      } else {
        connectToServer(id);
      }
      return;
    }
    if (button.classList.contains("duplicate-btn")) {
      duplicateServer(id);
      return;
    }
    if (button.classList.contains("edit-btn")) {
      openEditModal(id);
      return;
    }
    if (button.classList.contains("delete-btn")) {
      deleteServer(id);
    }
  });
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
        const connectedSessions = Array.from(sessions.entries()).filter(([id, session]) => 
          session.connectionState.type === "Connected"
        );
        if (connectedSessions[sessionIndex]) {
          setActiveSession(connectedSessions[sessionIndex][0]);
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
    const { state, shellId: eventShellId, serverId: eventServerId } = normalizeConnectionEvent(event.payload);

    let session = getSessionByServerId(eventServerId) || getSessionByShellId(eventShellId);
    if (!session) {
      const server = servers.find((s) => s.id === eventServerId);
      if (server) {
        session = ensureSession(server);
      }
    }
    if (!session) return;

    if (eventShellId) {
      session.shellId = eventShellId;
    }

    updateConnectionState(session, state);
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
    const payload = typeof event.payload === 'string'
      ? { shell_id: null, output: event.payload }
      : event.payload;

    const targetShellId = payload.shell_id || payload.shellId || null;
    const session = getSessionByShellId(targetShellId) || getActiveSession();
    if (!session) return;

    writeToSessionTerminal(session, payload.output || "");
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
    }
    });
  } catch (error) {
    console.error("Startup error:", error);
    showAlert("Startup Error", String(error));
    loadServers();
    loadSnippets();
  }
});
