const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const MAX_CONNECTIONS = 5;
let servers = [];
let sessions = new Map(); // Map<serverId | welcomeId, SessionState>
let activeSessionId = null;
const welcomeSessionId = "__welcome__";
let connectionLog = [];
let pendingHostKey = null;
let pendingDeleteServerId = null;
let pendingDisconnectResolve = null;
let localEchoEnabled = false;
let terminalTransparent = false;
let serverFilterTerm = "";

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
}

function getActiveSession() {
  return activeSessionId ? sessions.get(activeSessionId) : null;
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

function ensureSession(server) {
  const existing = sessions.get(server.id);
  if (existing) {
    existing.server = server;
    return existing;
  }

  const { term, fitAddon, container } = createTerminalPane(server.id);
  const session = {
    id: server.id,
    server,
    shellId: null,
    term,
    fitAddon,
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

  const termInstance = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 14,
    theme: getTerminalTheme(),
    // Performance optimizations
    scrollback: 1000,
    fastScrollModifier: 'alt',
    rightClickSelectsWord: true,
    rendererType: 'dom', // Use DOM renderer for better performance
  });

  const paneFitAddon = new FitAddon.FitAddon();
  termInstance.loadAddon(paneFitAddon);
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

  return { term: termInstance, fitAddon: paneFitAddon, container: pane };
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
  const { term, fitAddon, container } = createTerminalPane(welcomeSessionId);
  sessions.set(welcomeSessionId, {
    id: welcomeSessionId,
    server: null,
    shellId: null,
    term,
    fitAddon,
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

async function confirmDeleteServer() {
  if (!pendingDeleteServerId) return;
  const id = pendingDeleteServerId;
  closeDeleteModal();
  try {
    await invoke("delete_server", { id });
    loadServers();
  } catch (error) {
    console.error("Failed to delete server:", error);
    alert("Failed to delete server: " + error);
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

function closeHostKeyModal() {
  document.getElementById("host-key-modal").classList.add("hidden");
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  sessions.forEach((session) => {
    session.term?.setOption('theme', getTerminalTheme());
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
  const label = document.getElementById('terminal-bg-label');
  if (label) {
    label.textContent = terminalTransparent && isDark ? 'Glass' : 'Solid';
  }
  sessions.forEach((session) => {
    session.term?.setOption('theme', getTerminalTheme());
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
        break;
      case "Connected":
        session.term.reset();
        session.term.writeln(`\x1b[1;32mConnected successfully to ${label}!\x1b[0m`);
        statusEl.textContent = "Connected";
        statusEl.className = "text-xs font-medium text-white bg-green-500 px-2.5 py-0.5 rounded-full";
        statusIndicator.className = "w-2 h-2 rounded-full bg-green-500";
        disconnectBtn.classList.remove("hidden");
        break;
      case "Disconnected":
        session.term.reset();
        session.term.writeln("Disconnected from server.");
        statusEl.textContent = "Disconnected";
        statusEl.className = "text-xs font-medium text-gray-600 bg-gray-200 dark:text-gray-400 dark:bg-gray-700 px-2.5 py-0.5 rounded-full";
        statusIndicator.className = "w-2 h-2 rounded-full bg-gray-400";
        disconnectBtn.classList.add("hidden");
        break;
      case "Error":
        session.term.reset();
        session.term.writeln(`\x1b[1;31mConnection error: ${normalizedState.error}\x1b[0m`);
        statusEl.textContent = "Error";
        statusEl.className = "text-xs font-medium text-white bg-red-500 px-2.5 py-0.5 rounded-full";
        statusIndicator.className = "w-2 h-2 rounded-full bg-red-500";
        disconnectBtn.classList.add("hidden");
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
  } catch (error) {
    console.error("Failed to load servers:", error);
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
  });

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

  filteredServers.forEach((server) => {
    const session = sessions.get(server.id);
    const connectionState = session?.connectionState || { type: "Disconnected" };
    const isActive = activeSessionId === server.id;
    const isConnected = connectionState.type === "Connected";
    const isConnecting = connectionState.type === "Connecting";
    const isErrored = connectionState.type === "Error";
    const isDisconnected = connectionState.type === "Disconnected";
    
    const div = document.createElement("div");
    div.className = `server-item bg-white dark:bg-[#1f2335] border ${isActive ? 'border-blue-400' : 'border-gray-200 dark:border-gray-700'} rounded-2xl p-4 shadow-lg hover:shadow-xl transition-all group flex flex-col gap-3`;
    
    // Determine auth type label
    let authLabel = "Key";
    if (server.auth.type === 'Password' || (server.auth.type === 'SecretRef' && server.auth.kind === 'Password')) {
        authLabel = "Password";
    }

    const displayName = server.nickname && server.nickname.trim().length > 0 ? server.nickname : `${server.user}@${server.host}`;
    const subtitle = server.nickname && server.nickname.trim().length > 0 ? `${server.user}@${server.host}` : `Port ${server.port}`;

    // Connection status dot
    let statusDot = "";
    let statusText = "";
    switch (connectionState.type) {
      case "Connecting":
        statusDot = '<div class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></div>';
        statusText = "Connecting";
        break;
      case "Connected":
        statusDot = '<div class="w-2 h-2 rounded-full bg-green-500"></div>';
        statusText = isActive ? "Active" : "Connected";
        break;
      case "Error":
        statusDot = '<div class="w-2 h-2 rounded-full bg-red-500"></div>';
        statusText = "Error";
        break;
      default:
        statusDot = '<div class="w-2 h-2 rounded-full bg-gray-400"></div>';
        statusText = "Disconnected";
    }

    let statusBadge = "";
    let buttonLabel = "Connect";
    let buttonClass = "bg-emerald-500 hover:bg-emerald-600";
    let buttonIcon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>';
    if (isConnected) {
      statusBadge = '<span class="inline-flex items-center px-2.5 py-0.5 text-[10px] font-semibold rounded-full bg-green-600 text-white leading-tight shadow-sm">Connected</span>';
      buttonLabel = "Disconnect";
      buttonClass = "bg-rose-600 hover:bg-rose-700 focus:ring-2 focus:ring-rose-300";
      buttonIcon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>';
    } else if (isConnecting) {
      statusBadge = '<span class="inline-flex items-center px-2.5 py-0.5 text-[10px] font-semibold rounded-full bg-yellow-500 text-white leading-tight">Connecting</span>';
      buttonLabel = "Connecting";
      buttonClass = "bg-yellow-500 hover:bg-yellow-600";
    } else if (isErrored || isDisconnected) {
      statusBadge = '<span class="inline-flex items-center px-2.5 py-0.5 text-[10px] font-semibold rounded-full bg-amber-500 text-white leading-tight">Offline</span>';
      buttonLabel = "Connect";
      buttonClass = "bg-emerald-500 hover:bg-emerald-600";
    }

    div.innerHTML = `
      <div class="flex justify-between items-start gap-3">
        <div class="font-medium text-gray-900 dark:text-gray-100 truncate pr-2 flex flex-col gap-1" title="${displayName}">
            <div class="flex items-center gap-2 flex-wrap">
                ${statusDot}
                <span class="text-blue-600 dark:text-blue-400 font-bold">${displayName}</span>
                ${statusBadge}
            </div>
            <span class="text-xs text-gray-500 dark:text-gray-400">${subtitle}</span>
        </div>
        <div class="server-actions flex gap-1" style="z-index: 5;">
            <button class="server-action-btn edit-btn" data-id="${server.id}" title="Edit">
                <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
            </button>
            <button class="server-action-btn delete delete-btn" data-id="${server.id}" title="Delete">
                <svg class="server-action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
        </div>
      </div>
      <div class="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
        <div class="flex items-center gap-2">
            <span class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-[10px] font-mono border border-gray-200 dark:border-gray-600">:${server.port}</span>
            <span class="flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                ${authLabel}
            </span>
        </div>
        <button onclick="window.handleCardDisconnect?.('${server.id}')" class="connect-btn ${buttonClass} text-white px-4 py-2 rounded-lg shadow-sm hover:shadow transition-all font-semibold flex items-center gap-2" data-id="${server.id}">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${buttonIcon}</svg>
            ${buttonLabel}
        </button>
      </div>
    `;
    const actions = div.querySelector(".server-actions");
    if (actions) {
      div.addEventListener("mouseenter", () => {
        actions.style.opacity = "1";
        actions.style.visibility = "visible";
        actions.style.pointerEvents = "auto";
      });
      div.addEventListener("mouseleave", () => {
        actions.style.opacity = "0";
        actions.style.visibility = "hidden";
        actions.style.pointerEvents = "none";
      });
    }
    listEl.appendChild(div);
  });
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
  } catch (error) {
    console.error("Failed to connect:", error);
    updateConnectionState(session, { type: "Error", error: String(error) });
    showAlert(getErrorType(String(error)), String(error));
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
    alert("Failed to disconnect: " + error);
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
  document.getElementById("server-password").placeholder = "";
  document.getElementById("server-key").placeholder = "";
}

function closeModal() {
  document.getElementById("server-modal").classList.add("hidden");
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
      alert("Please enter a password to store in the keychain.");
      return;
    } else {
      alert("Please enter a password.");
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
      alert("Please paste your private key to store in the keychain.");
      return;
    } else {
      alert("Please paste your private key.");
      return;
    }
  }

  const server = {
    id,
    nickname: nickname.length > 0 ? nickname : null,
    host,
    port,
    user,
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
    alert("Failed to save server: " + error);
  }
}

async function deleteServer(id) {
  const modal = document.getElementById("delete-confirm-modal");
  const message = document.getElementById("delete-confirm-message");
  if (message) {
    const server = servers.find((item) => item.id === id);
    const label = server
      ? server.nickname && server.nickname.trim().length > 0
        ? server.nickname
        : `${server.user}@${server.host}`
      : "this host";
    message.textContent = `Delete ${label}? This action cannot be undone.`;
  }
  pendingDeleteServerId = id;
  if (modal) {
    modal.classList.remove("hidden");
  }
  return;

  try {
    await invoke("delete_server", { id });
    loadServers();
  } catch (error) {
    console.error("Failed to delete server:", error);
    alert("Failed to delete server: " + error);
  }
}

let snippets = [];

async function loadSnippets() {
  try {
    snippets = await invoke("get_snippets");
    renderSnippetList();
  } catch (error) {
    console.error("Failed to load snippets:", error);
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
    div.className = "snippet-item bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 shadow-sm hover:shadow-md transition-all group cursor-pointer";
    div.innerHTML = `
      <div class="flex justify-between items-center mb-1">
        <span class="font-medium text-gray-800 dark:text-gray-200 truncate flex-1">${snippet.name}</span>
        <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="snippet-edit-btn p-1 rounded text-gray-400 hover:text-blue-500 transition-colors" data-id="${snippet.id}">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
          </button>
          <button class="snippet-delete-btn p-1 rounded text-gray-400 hover:text-red-500 transition-colors" data-id="${snippet.id}">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      </div>
      <div class="text-xs font-mono bg-gray-50 dark:bg-gray-900 p-1.5 rounded text-gray-600 dark:text-gray-400 truncate mb-2">
        ${snippet.command}
      </div>
      <div class="flex justify-between items-end">
        <p class="text-xs text-gray-500 dark:text-gray-500 truncate max-w-[70%]">${snippet.description || ''}</p>
        <button class="snippet-run-btn bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 px-2 py-1 rounded text-xs font-medium transition-colors" data-id="${snippet.id}">Run</button>
      </div>
    `;
    listEl.appendChild(div);
  });
}

async function executeSnippet(snippet) {
  const session = getActiveSession();
  if (!session || !session.shellId || !session.term) {
    alert("Please connect to a server before running a snippet.");
    return;
  }

  session.term.writeln(`\r\n\x1b[1;33mRunning snippet: ${snippet.name}\x1b[0m\r\n`);
  try {
    await invoke("send_input", { shellId: session.shellId, input: snippet.command + "\n" });
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

function closeDeleteModal() {
  const modal = document.getElementById("delete-confirm-modal");
  if (modal) {
    modal.classList.add("hidden");
  }
  pendingDeleteServerId = null;
}

function closeDisconnectConfirmModal() {
  const modal = document.getElementById("disconnect-confirm-modal");
  if (modal) {
    modal.classList.add("hidden");
  }
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
    alert("Failed to save snippet: " + error);
  }
}

async function deleteSnippet(id) {
  if (!confirm("Are you sure you want to delete this snippet?")) return;

  try {
    await invoke("delete_snippet", { id });
    loadSnippets();
  } catch (error) {
    console.error("Failed to delete snippet:", error);
    alert("Failed to delete snippet: " + error);
  }
}

function initTabs() {
    const tabServers = document.getElementById('tab-servers');
    const tabSnippets = document.getElementById('tab-snippets');
    const viewServers = document.getElementById('view-servers');
    const viewSnippets = document.getElementById('view-snippets');

    if (!tabServers || !tabSnippets) return;

    function setActiveTab(tab) {
        if (tab === 'servers') {
            tabServers.classList.add('active');
            tabServers.classList.remove('inactive');
            tabSnippets.classList.add('inactive');
            tabSnippets.classList.remove('active');
            viewServers.classList.remove('hidden');
            viewSnippets.classList.add('hidden');
        } else {
            tabSnippets.classList.add('active');
            tabSnippets.classList.remove('inactive');
            tabServers.classList.add('inactive');
            tabServers.classList.remove('active');
            viewSnippets.classList.remove('hidden');
            viewServers.classList.add('hidden');
        }
    }

    tabServers.addEventListener('click', () => setActiveTab('servers'));
    tabSnippets.addEventListener('click', () => setActiveTab('snippets'));

    // initialize
    tabServers.classList.add('tab-btn');
    tabSnippets.classList.add('tab-btn');
    setActiveTab('servers');
}

function toggleFocusMode() {
    document.body.classList.toggle('focus-mode-active');
    setTimeout(() => {
        const active = getActiveSession();
        if (active?.fitAddon) {
          active.fitAddon.fit();
          syncPtySize(active);
        }
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

window.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initTabs(); // Initialize tabs
  disableInputCorrections();
  
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  
  // Focus mode
  document.getElementById("focus-btn").addEventListener("click", toggleFocusMode);
  document.getElementById("exit-focus-btn").addEventListener("click", toggleFocusMode);
  document.getElementById("focus-toggle-btn").addEventListener("click", toggleFocusMode);
  document.getElementById("terminal-bg-toggle").addEventListener("click", toggleTerminalBackground);

  const serverFilterInput = document.getElementById("server-filter");
  if (serverFilterInput) {
    serverFilterInput.addEventListener("input", (event) => {
      serverFilterTerm = event.target.value || "";
      renderServerList();
    });
  }

  // Clear log
  document.getElementById("clear-log-btn").addEventListener("click", () => {
      connectionLog = [];
      const listEl = document.getElementById("connection-log-list");
      if (listEl) listEl.innerHTML = "";
  });

  initTerminal();
  
  document.getElementById("add-server-btn").addEventListener("click", openModal);
  
  document.getElementById("cancel-btn").addEventListener("click", closeModal);
  document.getElementById("server-form").addEventListener("submit", saveServer);
  document.getElementById("disconnect-btn").addEventListener("click", () => disconnectFromServer(null, { requireConfirm: true }));
  document.getElementById("delete-cancel-btn").addEventListener("click", closeDeleteModal);
  document.getElementById("delete-confirm-btn").addEventListener("click", confirmDeleteServer);
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
  document.getElementById("server-list").addEventListener("click", (e) => {
    const target = e.target;
    const button = target.closest("button");
    const item = target.closest(".server-item");
    
    // Handle card click for session switching
    if (item && !button) {
       const id = item.querySelector(".connect-btn")?.dataset.id;
       if (id) {
         const session = sessions.get(id);
         if (session && session.connectionState.type === "Connected") {
           setActiveSession(id);
           return;
         }
       }
    }

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
    if (button.classList.contains("edit-btn")) {
      openEditModal(id);
      return;
    }
    if (button.classList.contains("delete-btn")) {
      deleteServer(id);
    }
  });
  document.getElementById("add-snippet-btn").addEventListener("click", openSnippetModal);
  document.getElementById("snippet-cancel-btn").addEventListener("click", closeSnippetModal);
  document.getElementById("snippet-form").addEventListener("submit", saveSnippet);
  document.getElementById("snippet-list").addEventListener("click", (e) => {
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
  document.getElementById("auth-type").addEventListener("change", (e) => {
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
      // Cmd/Ctrl + 1-9 for session switching
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
      // Cmd/Ctrl + W to close active session
      else if (e.key === "w") {
        e.preventDefault();
        const activeSession = getActiveSession();
        if (activeSession && activeSession.server) {
          disconnectFromServer(null, { requireConfirm: true });
        }
      }
    }
  });
  
  loadServers();
  loadSnippets();

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

  document.getElementById("host-key-trust").addEventListener("click", async () => {
    if (!pendingHostKey) return;
    try {
      await invoke("trust_host_key", {
        host: pendingHostKey.host,
        port: pendingHostKey.port,
        keyType: pendingHostKey.key_type,
        fingerprint: pendingHostKey.fingerprint,
        publicKeyBase64: pendingHostKey.public_key_base64,
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

  document.getElementById("host-key-reject").addEventListener("click", async () => {
    if (!pendingHostKey) return;
    try {
      await invoke("reject_host_key", {
        host: pendingHostKey.host,
        port: pendingHostKey.port,
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
});
