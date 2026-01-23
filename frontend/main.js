const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let servers = [];
let currentConnectionState = { type: "Disconnected" };
let currentServer = null;
let term;
let fitAddon;
let serverId;
let shellId;
let autoScrollEnabled = true;
let connectionLog = [];
let pendingHostKey = null;
let localEchoEnabled = false;
let terminalTransparent = false;
let serverFilterTerm = "";

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
  if (term) {
    term.setOption('theme', getTerminalTheme());
  }
}

function toggleTerminalBackground() {
  terminalTransparent = !terminalTransparent;
  document.body.classList.toggle('terminal-transparent', terminalTransparent);
  const label = document.getElementById('terminal-bg-label');
  if (label) {
    label.textContent = terminalTransparent ? 'Glass' : 'Solid';
  }
  if (term) {
    term.setOption('theme', getTerminalTheme());
  }
}

function getTerminalTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  return {
    background: terminalTransparent ? 'transparent' : (isDark ? '#11111b' : '#f5f7ff'),
    foreground: isDark ? '#cdd6f4' : '#4c4f69',
    cursor: isDark ? '#f5c2e7' : '#dc8a78',
    selection: isDark ? 'rgba(108, 112, 134, 0.5)' : 'rgba(188, 192, 204, 0.45)',
  };
}

function initTerminal() {
  term = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 14,
    theme: getTerminalTheme(),
  });

  fitAddon = new FitAddon.FitAddon();

  const terminalEl = document.getElementById("terminal-container");
  terminalEl.innerHTML = "";
  term.loadAddon(fitAddon);
  term.open(terminalEl);
  fitAddon.fit();
  syncPtySize();

  term.writeln("\x1b[1;32mSSH Terminal\x1b[0m");
  term.writeln("Connect to a server to begin...\r\n");

  term.onData((data) => {
    if (shellId && currentConnectionState.type === "Connected") {
      invoke("send_input", { shellId, input: data }).catch(console.error);
    }
  });

  term.onKey((event) => {
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

  term.onScroll((newRow) => {
    const maxScroll = term.rows - 1;
    if (newRow < maxScroll) {
      autoScrollEnabled = false;
    } else {
      autoScrollEnabled = true;
    }
  });

  window.addEventListener('resize', () => {
    fitAddon.fit();
    syncPtySize();
  });
}

function updateConnectionState(state, shellFromEvent) {
  const normalizedState = normalizeConnectionState(state);
  currentConnectionState = normalizedState;
  const statusEl = document.getElementById("connection-status");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const statusBarHost = document.getElementById("status-bar-host");
  const statusBarState = document.getElementById("status-bar-state");
  const connectedLabel = currentServer
    ? `${currentServer.user}@${currentServer.host}:${currentServer.port}`
    : "";
  
  const statusIndicator = document.getElementById("status-indicator");
  
  switch (normalizedState.type) {
    case "Connecting":
      term.reset();
      term.writeln("\x1b[1;33mConnecting to server...\x1b[0m");
      statusEl.textContent = "Connecting...";
      statusEl.className = "text-xs font-medium text-white bg-yellow-500 px-2.5 py-0.5 rounded-full";
      statusIndicator.className = "w-2 h-2 rounded-full bg-yellow-500 animate-pulse";
      
      disconnectBtn.classList.add("hidden");
      if (currentServer) {
        statusBarHost.textContent = connectedLabel;
      }
      statusBarState.textContent = "Connecting";
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-yellow-600 dark:text-yellow-400";
      fitAddon.fit();
      logConnectionEvent("Connecting", connectedLabel, "info");
      break;
    case "Connected":
      term.reset();
      term.writeln(`\x1b[1;32mConnected successfully to ${connectedLabel}!\x1b[0m`);
      statusEl.textContent = "Connected";
      statusEl.className = "text-xs font-medium text-white bg-green-500 px-2.5 py-0.5 rounded-full";
      statusIndicator.className = "w-2 h-2 rounded-full bg-green-500";

      disconnectBtn.classList.remove("hidden");
      if (currentServer) {
        statusBarHost.textContent = connectedLabel;
      }
      statusBarState.textContent = "Connected";
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-green-600 dark:text-green-400";
      fitAddon.fit();
      logConnectionEvent("Connected", connectedLabel, "success");
      break;
    case "Disconnected":
      term.reset();
      term.writeln("Disconnected from server.");
      statusEl.textContent = "Disconnected";
      statusEl.className = "text-xs font-medium text-gray-600 bg-gray-200 dark:text-gray-400 dark:bg-gray-700 px-2.5 py-0.5 rounded-full";
      statusIndicator.className = "w-2 h-2 rounded-full bg-gray-400";

      disconnectBtn.classList.add("hidden");
      statusBarHost.textContent = "Not connected";
      statusBarState.textContent = "Disconnected";
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-gray-600 dark:text-gray-400";
      fitAddon.fit();
      const shouldAlert = shellId && (!shellFromEvent || shellFromEvent === shellId);
      if (shouldAlert) {
        showAlert('Connection Lost', 'The SSH connection was unexpectedly disconnected.', 'warning');
      }
      if (!shellFromEvent || shellFromEvent === shellId) {
        shellId = null;
        currentServer = null;
      }
      logConnectionEvent("Disconnected", connectedLabel, "info");
      break;
    case "Error":
      term.reset();
      term.writeln(`\x1b[1;31mConnection error: ${normalizedState.error}\x1b[0m`);
      statusEl.textContent = "Error";
      statusEl.className = "text-xs font-medium text-white bg-red-500 px-2.5 py-0.5 rounded-full";
      statusIndicator.className = "w-2 h-2 rounded-full bg-red-500";

      disconnectBtn.classList.add("hidden");
      if (currentServer) {
        statusBarHost.textContent = `${currentServer.user}@${currentServer.host}:${currentServer.port}`;
      }
      statusBarState.textContent = "Error";
      statusBarState.className = "font-medium text-xs uppercase tracking-wide text-red-600 dark:text-red-400";
      fitAddon.fit();
      showAlert(getErrorType(normalizedState.error), normalizedState.error);
      logConnectionEvent(`Error: ${normalizedState.error}`, connectedLabel, "error");
      break;
  }
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

function syncPtySize() {
  if (!shellId || !term) return;
  const width = term.cols;
  const height = term.rows;
  invoke("resize", { shellId, width, height }).catch(console.error);
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
    const div = document.createElement("div");
    div.className = "server-item bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 shadow-sm hover:shadow-md transition-all group";
    
    // Determine auth type label
    let authLabel = "Key";
    if (server.auth.type === 'Password' || (server.auth.type === 'SecretRef' && server.auth.kind === 'Password')) {
        authLabel = "Password";
    }

    const displayName = server.nickname && server.nickname.trim().length > 0 ? server.nickname : `${server.user}@${server.host}`;
    const subtitle = server.nickname && server.nickname.trim().length > 0 ? `${server.user}@${server.host}` : `Port ${server.port}`;

    div.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <div class="font-medium text-gray-900 dark:text-gray-100 truncate pr-2 flex flex-col" title="${displayName}">
            <span class="text-blue-600 dark:text-blue-400 font-bold">${displayName}</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">${subtitle}</span>
        </div>
        <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="edit-btn p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" data-id="${server.id}" title="Edit">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
            </button>
            <button class="delete-btn p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" data-id="${server.id}" title="Delete">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
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
        <button class="connect-btn bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded shadow-sm hover:shadow transition-all font-medium flex items-center gap-1" data-id="${server.id}">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            Connect
        </button>
      </div>
    `;
    listEl.appendChild(div);
  });
}

async function connectToServer(id) {
  const server = servers.find((s) => s.id === id);
  if (!server) return;

  currentServer = server;
  term.reset();
  term.writeln("\x1b[1;33mConnecting...\x1b[0m");

  try {
    shellId = await invoke("connect", { server });
    syncPtySize();
    logConnectionEvent("Shell opened", `${server.user}@${server.host}:${server.port}`, "success");
  } catch (error) {
    console.error("Failed to connect:", error);
    term.reset();
    term.writeln(`\x1b[1;31mConnection failed: ${error}\x1b[0m`);
    showAlert(getErrorType(error), error);
  }
}

async function disconnectFromServer() {
  if (!currentServer) return;

  try {
    await invoke("disconnect", { serverId: currentServer.id });
    shellId = null;
    currentServer = null;
    logConnectionEvent("Disconnect requested", "", "info");
  } catch (error) {
    console.error("Failed to disconnect:", error);
    alert("Failed to disconnect: " + error);
  }
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
  if (!confirm("Are you sure you want to delete this server?")) return;

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
  if (!term || !shellId) {
    alert("Please connect to a server before running a snippet.");
    return;
  }

  term.writeln(`\r\n\x1b[1;33mRunning snippet: ${snippet.name}\x1b[0m\r\n`);
  try {
    await invoke("send_input", { shellId, input: snippet.command + "\n" });
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
            tabServers.className = 'flex-1 py-3 text-sm font-medium border-b-2 border-blue-500 text-blue-600 dark:text-blue-400 bg-gray-50 dark:bg-gray-700/50';
            tabSnippets.className = 'flex-1 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200';
            viewServers.classList.remove('hidden');
            viewSnippets.classList.add('hidden');
        } else {
            tabSnippets.className = 'flex-1 py-3 text-sm font-medium border-b-2 border-blue-500 text-blue-600 dark:text-blue-400 bg-gray-50 dark:bg-gray-700/50';
            tabServers.className = 'flex-1 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200';
            viewSnippets.classList.remove('hidden');
            viewServers.classList.add('hidden');
        }
    }

    tabServers.addEventListener('click', () => setActiveTab('servers'));
    tabSnippets.addEventListener('click', () => setActiveTab('snippets'));
}

function toggleFocusMode() {
    document.body.classList.toggle('focus-mode-active');
    setTimeout(() => {
        fitAddon.fit();
        syncPtySize();
    }, 300);
}

window.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initTabs(); // Initialize tabs
  
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
  document.getElementById("disconnect-btn").addEventListener("click", disconnectFromServer);
  document.getElementById("server-list").addEventListener("click", (e) => {
    const target = e.target;
    const button = target.closest("button");
    const item = target.closest(".server-item"); // Changed from li to .server-item
    
    // Handle card click (connect) unless clicking a specific button
    if (item && !button) {
       // Optional: make clicking the card connect? Maybe too aggressive.
       // Let's stick to buttons for now, or make double click connect.
    }

    if (!button) return;
    const id = button.dataset.id;
    if (!id) return;
    if (button.classList.contains("connect-btn")) {
      connectToServer(id);
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
  loadServers();
  loadSnippets();

  listen("connection-state", (event) => {
    const { state, shellId: eventShellId } = normalizeConnectionEvent(event.payload);
    if (eventShellId && (!shellId || shellId === eventShellId)) {
      shellId = eventShellId;
    }
    updateConnectionState(state, eventShellId);
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
    if (!term) return;
    const payload = typeof event.payload === 'string'
      ? { shell_id: shellId, output: event.payload }
      : event.payload;

    if (payload.shell_id && shellId && payload.shell_id !== shellId) {
      return;
    }

    const output = payload.output || "";
    term.write(output);
    if (autoScrollEnabled) {
      term.scrollToBottom();
    }
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
