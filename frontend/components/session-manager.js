const SearchAddonCtor =
  typeof window.SearchAddon !== "undefined" && typeof window.SearchAddon.SearchAddon === "function"
    ? window.SearchAddon.SearchAddon
    : null;

const MAX_CONNECTIONS = 5;
const welcomeSessionId = "__welcome__";

function isLiveState(state) {
  return state === "Connected" || state === "Connecting";
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
    return {
      state: normalizeConnectionState(payload),
      connectionId: null,
      serverId: null,
      shellId: null,
    };
  }

  if (payload.state) {
    return {
      state: normalizeConnectionState(payload.state),
      connectionId: payload.connection_id ?? payload.connectionId ?? null,
      serverId: payload.server_id ?? payload.serverId ?? null,
      shellId: payload.shell_id ?? payload.shellId ?? null,
    };
  }

  return {
    state: normalizeConnectionState(payload),
    connectionId: payload.connection_id ?? payload.connectionId ?? null,
    serverId: payload.server_id ?? payload.serverId ?? null,
    shellId: payload.shell_id ?? payload.shellId ?? null,
  };
}

function normalizeTerminalOutput(payload) {
  if (!payload || typeof payload === "string") {
    return {
      connectionId: null,
      serverId: null,
      shellId: null,
      output: payload || "",
    };
  }

  return {
    connectionId: payload.connection_id ?? payload.connectionId ?? null,
    serverId: payload.server_id ?? payload.serverId ?? null,
    shellId: payload.shell_id ?? payload.shellId ?? null,
    output: payload.output || "",
  };
}

export function createSessionManager(options) {
  const sessions = new Map();
  let activeSessionId = null;

  function getTerminalContainer() {
    const container = document.getElementById("terminal-container");
    if (!container) {
      throw new Error("Terminal container not found");
    }
    container.classList.add("relative");
    return container;
  }

  function getServers() {
    return options.getServers?.() || [];
  }

  function getActiveSession() {
    return activeSessionId ? sessions.get(activeSessionId) || null : null;
  }

  function getSessionByShellId(shellId) {
    if (!shellId) return null;
    for (const session of sessions.values()) {
      if (session.shellId === shellId) return session;
    }
    return null;
  }

  function getSessionsForServer(serverId) {
    return Array.from(sessions.values()).filter((session) => session.serverId === serverId);
  }

  function getNonWelcomeSessions() {
    return Array.from(sessions.values()).filter((session) => session.id !== welcomeSessionId);
  }

  function getLiveSessionCount() {
    return getNonWelcomeSessions().filter((session) => isLiveState(session.connectionState.type)).length;
  }

  function markSessionActivated(session) {
    session.lastActivatedAt = Date.now();
  }

  function getMostRecentSessionForServer(serverId, { liveOnly = false } = {}) {
    const matches = getSessionsForServer(serverId).filter((session) => !liveOnly || isLiveState(session.connectionState.type));
    matches.sort((left, right) => {
      const leftScore = left.lastActivatedAt || left.createdAt || 0;
      const rightScore = right.lastActivatedAt || right.createdAt || 0;
      return rightScore - leftScore;
    });
    return matches[0] || null;
  }

  function getHostSummary(serverId) {
    const hostSessions = getSessionsForServer(serverId);
    const connectedCount = hostSessions.filter((session) => session.connectionState.type === "Connected").length;
    const connectingCount = hostSessions.filter((session) => session.connectionState.type === "Connecting").length;
    const errorCount = hostSessions.filter((session) => session.connectionState.type === "Error").length;
    const liveCount = connectedCount + connectingCount;
    const focusSession = getMostRecentSessionForServer(serverId, { liveOnly: liveCount > 0 })
      || getMostRecentSessionForServer(serverId);

    let primaryState = "Disconnected";
    if (connectedCount > 0) {
      primaryState = "Connected";
    } else if (connectingCount > 0) {
      primaryState = "Connecting";
    } else if (errorCount > 0) {
      primaryState = "Error";
    }

    return {
      totalCount: hostSessions.length,
      connectedCount,
      connectingCount,
      liveCount,
      primaryState,
      focusSessionId: focusSession?.id || null,
      isActiveHost: hostSessions.some((session) => session.id === activeSessionId),
    };
  }

  function updateSessionCount() {
    const countEl = document.getElementById("session-count");
    if (!countEl) return;
    countEl.textContent = `Sessions: ${getLiveSessionCount()}`;
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

    disconnectBtn.classList.remove("hidden");
    reconnectBtn.classList.toggle("hidden", !["Disconnected", "Error"].includes(session.connectionState.type));
  }

  function renderActiveSessionChrome({ resetTerminal = false } = {}) {
    const statusEl = document.getElementById("connection-status");
    const statusIndicator = document.getElementById("status-indicator");
    const statusBarHost = document.getElementById("status-bar-host");
    const statusBarState = document.getElementById("status-bar-state");
    const session = getActiveSession();

    updateSessionCount();

    if (!session || !session.server) {
      if (statusEl) {
        statusEl.textContent = "Disconnected";
        statusEl.className = "text-xs font-medium text-gray-600 bg-gray-200 dark:text-gray-400 dark:bg-gray-700 px-2.5 py-0.5 rounded-full";
      }
      if (statusIndicator) {
        statusIndicator.className = "w-2 h-2 rounded-full bg-gray-400";
      }
      if (statusBarHost) {
        statusBarHost.textContent = "Not connected";
      }
      if (statusBarState) {
        statusBarState.textContent = "Idle";
        statusBarState.className = "font-medium text-xs uppercase tracking-wide text-gray-500";
      }
      updateHeaderButtons();
      return;
    }

    const label = `${session.server.user}@${session.server.host}:${session.server.port}`;
    const state = session.connectionState?.type || "Disconnected";

    if (statusBarHost) {
      statusBarHost.textContent = label;
    }
    if (statusBarState) {
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

    if (statusEl && statusIndicator) {
      switch (state) {
        case "Connecting":
          if (resetTerminal) {
            session.term.reset();
            session.term.writeln("\x1b[1;33mConnecting to server...\x1b[0m");
          }
          statusEl.textContent = "Connecting...";
          statusEl.className = "text-xs font-medium text-white bg-yellow-500 px-2.5 py-0.5 rounded-full";
          statusIndicator.className = "w-2 h-2 rounded-full bg-yellow-500 animate-pulse";
          break;
        case "Connected":
          if (resetTerminal) {
            session.term.reset();
            session.term.writeln(`\x1b[1;32mConnected successfully to ${label}!\x1b[0m`);
          }
          statusEl.textContent = "Connected";
          statusEl.className = "text-xs font-medium text-white bg-green-500 px-2.5 py-0.5 rounded-full";
          statusIndicator.className = "w-2 h-2 rounded-full bg-green-500";
          break;
        case "Error":
          if (resetTerminal) {
            session.term.reset();
            session.term.writeln(`\x1b[1;31mConnection error: ${session.connectionState.error}\x1b[0m`);
          }
          statusEl.textContent = "Error";
          statusEl.className = "text-xs font-medium text-white bg-red-500 px-2.5 py-0.5 rounded-full";
          statusIndicator.className = "w-2 h-2 rounded-full bg-red-500";
          break;
        default:
          if (resetTerminal) {
            session.term.reset();
            session.term.writeln("Disconnected from server.");
          }
          statusEl.textContent = "Disconnected";
          statusEl.className = "text-xs font-medium text-gray-600 bg-gray-200 dark:text-gray-400 dark:bg-gray-700 px-2.5 py-0.5 rounded-full";
          statusIndicator.className = "w-2 h-2 rounded-full bg-gray-400";
      }
    }

    updateHeaderButtons();
  }

  function updateSessionTabs() {
    const tabsContainer = document.getElementById("session-tabs");
    if (!tabsContainer) return;

    const tabSessions = getNonWelcomeSessions().sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
    if (tabSessions.length <= 1) {
      tabsContainer.classList.add("hidden");
      tabsContainer.innerHTML = "";
      return;
    }

    tabsContainer.classList.remove("hidden");
    tabsContainer.innerHTML = "";

    tabSessions.forEach((session) => {
      const isActive = activeSessionId === session.id;
      const tab = document.createElement("button");
      const state = session.connectionState.type;
      const dotClass = state === "Connected"
        ? "bg-green-400"
        : state === "Connecting"
          ? "bg-yellow-400 animate-pulse"
          : state === "Error"
            ? "bg-red-400"
            : "bg-gray-400";

      tab.className = `flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
        isActive
          ? "bg-blue-500 text-white"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
      }`;
      tab.innerHTML = `
        <div class="w-1.5 h-1.5 rounded-full ${dotClass}"></div>
        <span class="truncate max-w-36">${getSessionTabLabel(session)}</span>
      `;
      tab.addEventListener("click", () => setActiveSession(session.id));
      tabsContainer.appendChild(tab);
    });
  }

  function notifySessionsChanged() {
    renderActiveSessionChrome();
    updateSessionTabs();
    options.onSessionsChanged?.();
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

  function syncPtySize(session) {
    if (!session || !session.shellId || !session.term) return;
    const width = session.term.cols;
    const height = session.term.rows;
    options.invoke("resize", { shellId: session.shellId, width, height }).catch(console.error);
  }

  function applyTerminalSettings() {
    const settings = options.getTerminalSettings();
    sessions.forEach((session) => {
      setTerminalOption(session.term, "fontSize", settings.fontSize);
      setTerminalOption(session.term, "scrollback", settings.scrollback);
      session.fitAddon?.fit();
      syncPtySize(session);
    });
  }

  function refreshTerminalTheme() {
    sessions.forEach((session) => {
      setTerminalOption(session.term, "theme", options.getTerminalTheme());
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

    const settings = options.getTerminalSettings();
    const termInstance = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: settings.fontSize,
      theme: options.getTerminalTheme(),
      scrollback: settings.scrollback,
      fastScrollModifier: "alt",
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

    termInstance.onData((data) => {
      const session = sessions.get(sessionId);
      if (session && session.shellId && session.connectionState.type === "Connected") {
        options.invoke("send_input", { shellId: session.shellId, input: data }).catch(console.error);
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
          case "c": input = "\x03"; break;
          case "d": input = "\x04"; break;
          case "z": input = "\x1a"; break;
          case "l": input = "\x0c"; break;
          case "a": input = "\x01"; break;
          case "e": input = "\x05"; break;
          case "u": input = "\x15"; break;
          case "k": input = "\x0b"; break;
        }
        if (input && shellId) {
          options.invoke("send_input", { shellId, input }).catch(console.error);
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

  function createSession(server, connectionId = crypto.randomUUID()) {
    const { term, fitAddon, searchAddon, container } = createTerminalPane(connectionId);
    const now = Date.now();
    const session = {
      id: connectionId,
      serverId: server?.id || null,
      server,
      shellId: null,
      term,
      fitAddon,
      searchAddon,
      container,
      connectionState: { type: "Disconnected" },
      autoScrollEnabled: true,
      outputBuffer: "",
      outputTimeout: null,
      createdAt: now,
      lastActivatedAt: now,
      pendingExplicitDisconnect: false,
    };
    sessions.set(connectionId, session);
    return session;
  }

  function ensureWelcomeSession() {
    if (sessions.has(welcomeSessionId)) return;
    const { term, fitAddon, searchAddon, container } = createTerminalPane(welcomeSessionId);
    sessions.set(welcomeSessionId, {
      id: welcomeSessionId,
      serverId: null,
      server: null,
      shellId: null,
      term,
      fitAddon,
      searchAddon,
      container,
      connectionState: { type: "Disconnected" },
      autoScrollEnabled: true,
      createdAt: Date.now(),
      lastActivatedAt: Date.now(),
      pendingExplicitDisconnect: false,
    });
    setActiveSession(welcomeSessionId);
  }

  function removeWelcomeSession() {
    if (!sessions.has(welcomeSessionId)) return;
    const session = sessions.get(welcomeSessionId);
    session?.container?.remove();
    sessions.delete(welcomeSessionId);
    if (activeSessionId === welcomeSessionId) {
      activeSessionId = null;
    }
  }

  function setActiveSession(sessionId) {
    if (!sessionId || !sessions.has(sessionId)) return;
    const hostContainer = getTerminalContainer();
    Array.from(hostContainer.children).forEach((child) => {
      child.style.display = child.dataset.sessionId === sessionId ? "block" : "none";
    });
    activeSessionId = sessionId;
    const session = sessions.get(sessionId);
    markSessionActivated(session);
    if (session?.fitAddon) {
      session.fitAddon.fit();
      syncPtySize(session);
    }
    renderActiveSessionChrome();
    updateSessionTabs();
    options.onSessionsChanged?.();
    focusActiveTerminal({ defer: true });
  }

  function getSessionTabLabel(session) {
    if (!session.server) return "Welcome";
    const baseLabel = session.server.nickname?.trim() || `${session.server.user}@${session.server.host}`;
    const siblings = getSessionsForServer(session.serverId).sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
    if (siblings.length <= 1) {
      return baseLabel;
    }
    const position = siblings.findIndex((item) => item.id === session.id);
    return position <= 0 ? baseLabel : `${baseLabel} #${position + 1}`;
  }

  function writeToSessionTerminal(session, output) {
    if (!session?.term) return;
    session.outputBuffer = `${session.outputBuffer || ""}${output}`;
    if (session.outputTimeout) return;

    session.outputTimeout = setTimeout(() => {
      if (session.outputBuffer) {
        session.term.write(session.outputBuffer);
        if (session.autoScrollEnabled) {
          session.term.scrollToBottom();
        }
        session.outputBuffer = "";
      }
      session.outputTimeout = null;
    }, 16);
  }

  function removeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.outputTimeout) {
      clearTimeout(session.outputTimeout);
    }
    session.container?.remove();
    sessions.delete(sessionId);

    if (activeSessionId === sessionId) {
      const remainingSessions = getNonWelcomeSessions().sort((left, right) => (right.lastActivatedAt || 0) - (left.lastActivatedAt || 0));
      if (remainingSessions.length > 0) {
        setActiveSession(remainingSessions[0].id);
      } else {
        ensureWelcomeSession();
        setActiveSession(welcomeSessionId);
      }
    } else if (getNonWelcomeSessions().length === 0) {
      ensureWelcomeSession();
    }

    notifySessionsChanged();
  }

  function getErrorTitle(message) {
    if (!message) return "Connection Error";
    const normalized = String(message).toLowerCase();
    if (normalized.includes("timed out")) return "Connection Timed Out";
    if (normalized.includes("authentication")) return "Authentication Failed";
    if (normalized.includes("refused")) return "Connection Refused";
    if (normalized.includes("host key")) return "Host Key Error";
    return "Connection Error";
  }

  function updateConnectionState(session, state) {
    const previousType = session.connectionState?.type || "Disconnected";
    const normalizedState = normalizeConnectionState(state);
    session.connectionState = normalizedState;
    session.serverId = session.server?.id || session.serverId;

    if (session.id === activeSessionId) {
      renderActiveSessionChrome({ resetTerminal: previousType !== normalizedState.type });
      session.fitAddon?.fit();
    }

    const label = session.server
      ? `${session.server.user}@${session.server.host}:${session.server.port}`
      : "";

    switch (normalizedState.type) {
      case "Connecting":
        options.logConnectionEvent?.("Connecting", label, "info");
        break;
      case "Connected":
        options.logConnectionEvent?.("Connected", label, "success");
        session.pendingExplicitDisconnect = false;
        break;
      case "Disconnected":
        if (!session.pendingExplicitDisconnect) {
          options.logConnectionEvent?.("Disconnected", label, "info");
        }
        session.shellId = normalizedState.type === "Disconnected" ? null : session.shellId;
        break;
      case "Error":
        session.shellId = null;
        options.logConnectionEvent?.(`Error: ${normalizedState.error}`, label, "error");
        if (session.id === activeSessionId && normalizedState.error) {
          options.showAlert?.(getErrorTitle(normalizedState.error), normalizedState.error);
        }
        break;
    }

    if (
      session.server &&
      session.id !== activeSessionId &&
      !session.pendingExplicitDisconnect &&
      previousType === "Connected" &&
      ["Disconnected", "Error"].includes(normalizedState.type)
    ) {
      const name = session.server.nickname || `${session.server.user}@${session.server.host}`;
      const suffix = normalizedState.type === "Error" && normalizedState.error ? `: ${normalizedState.error}` : "";
      options.showToast?.(`${name} disconnected${suffix}`, normalizedState.type === "Error" ? "error" : "warning");
    }

    notifySessionsChanged();
  }

  async function connectSession(session, { refreshServers = true } = {}) {
    const liveCount = getLiveSessionCount();
    const isExistingLive = isLiveState(session.connectionState.type);
    if (!isExistingLive && liveCount >= MAX_CONNECTIONS) {
      options.showAlert?.(
        "Session Limit Reached",
        `You can have up to ${MAX_CONNECTIONS} active sessions. Disconnect one to open another.`,
        "warning",
      );
      return;
    }

    removeWelcomeSession();
    session.server = getServers().find((item) => item.id === session.serverId) || session.server;
    session.pendingExplicitDisconnect = false;
    session.shellId = null;
    setActiveSession(session.id);
    updateConnectionState(session, "Connecting");

    try {
      const newShellId = await options.invoke("connect", {
        server: session.server,
        connectionId: session.id,
      });
      session.shellId = newShellId;
      syncPtySize(session);
      updateConnectionState(session, "Connected");
      options.logConnectionEvent?.(
        "Shell opened",
        `${session.server.user}@${session.server.host}:${session.server.port}`,
        "success",
      );
      if (refreshServers) {
        options.onRefreshServers?.();
      }
    } catch (error) {
      console.error("Failed to connect:", error);
      updateConnectionState(session, { type: "Error", error: String(error) });
    }
  }

  async function connectToServer(serverId) {
    const server = getServers().find((item) => item.id === serverId);
    if (!server) return;
    const session = createSession(server);
    await connectSession(session);
  }

  async function reconnectActiveSession() {
    const session = getActiveSession();
    if (!session?.server || isLiveState(session.connectionState.type)) return;
    await connectSession(session, { refreshServers: false });
  }

  async function disconnectSession(sessionId = null, { requireConfirm = false } = {}) {
    const resolvedId = typeof sessionId === "string" ? sessionId : activeSessionId;
    const session = resolvedId ? sessions.get(resolvedId) : getActiveSession();
    if (!session || !session.server) return;

    if (requireConfirm) {
      const label = session.server.nickname?.trim() || `${session.server.user}@${session.server.host}`;
      const confirmed = await options.confirmDisconnect?.(label);
      if (!confirmed) return;
    }

    if (!isLiveState(session.connectionState.type) || !session.shellId) {
      removeSession(session.id);
      return;
    }

    const headerDisconnect = document.getElementById("disconnect-btn");
    if (headerDisconnect) {
      headerDisconnect.disabled = true;
      headerDisconnect.classList.add("opacity-70", "cursor-not-allowed");
    }

    try {
      session.pendingExplicitDisconnect = true;
      await options.invoke("disconnect", { connectionId: session.id });
      options.logConnectionEvent?.("Disconnect requested", getSessionTabLabel(session), "info");
      removeSession(session.id);
    } catch (error) {
      session.pendingExplicitDisconnect = false;
      console.error("Failed to disconnect:", error);
      options.showAlert?.("Disconnect Failed", String(error));
    } finally {
      if (headerDisconnect) {
        headerDisconnect.disabled = false;
        headerDisconnect.classList.remove("opacity-70", "cursor-not-allowed");
      }
    }
  }

  function focusMostRecentSessionForServer(serverId) {
    const target = getMostRecentSessionForServer(serverId, { liveOnly: true });
    if (target) {
      setActiveSession(target.id);
    }
  }

  function hasActiveConnections() {
    return getLiveSessionCount() > 0;
  }

  function getKeyboardSessions() {
    return getNonWelcomeSessions().sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  }

  function init() {
    const terminalEl = document.getElementById("terminal-container");
    if (terminalEl) {
      terminalEl.innerHTML = "";
    }
    ensureWelcomeSession();
    window.addEventListener("resize", () => {
      const active = getActiveSession();
      if (active?.fitAddon) {
        active.fitAddon.fit();
        syncPtySize(active);
      }
    });
  }

  function handleConnectionEvent(payload) {
    const { state, connectionId, shellId, serverId } = normalizeConnectionEvent(payload);
    const session = (connectionId && sessions.get(connectionId)) || (shellId && getSessionByShellId(shellId));
    if (!session) return;

    if (serverId) {
      session.serverId = serverId;
      session.server = getServers().find((server) => server.id === serverId) || session.server;
    }
    if (shellId) {
      session.shellId = shellId;
    }

    if (session.pendingExplicitDisconnect && state.type === "Disconnected") {
      return;
    }

    updateConnectionState(session, state);
  }

  function handleTerminalOutput(payload) {
    const normalized = normalizeTerminalOutput(payload);
    const session = (normalized.connectionId && sessions.get(normalized.connectionId))
      || (normalized.shellId && getSessionByShellId(normalized.shellId));
    if (!session) return;
    writeToSessionTerminal(session, normalized.output);
  }

  return {
    init,
    applyTerminalSettings,
    refreshTerminalTheme,
    getActiveSession,
    getActiveSessionId: () => activeSessionId,
    getHostSummary,
    getKeyboardSessions,
    hasActiveConnections,
    connectToServer,
    reconnectActiveSession,
    disconnectSession,
    focusMostRecentSessionForServer,
    handleConnectionEvent,
    handleTerminalOutput,
    setActiveSession,
    isSearchAvailable: () => Boolean(SearchAddonCtor),
  };
}
