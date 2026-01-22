const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let servers = [];
let currentConnectionState = { type: "Disconnected" };
let currentServer = null;
let term;
let fitAddon;
let serverId;

function initTerminal() {
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'monospace',
    fontSize: 14,
    theme: {
      background: '#000000',
      foreground: '#00ff00',
    },
  });

  fitAddon = new FitAddon.FitAddon();

  const terminalEl = document.getElementById("terminal-container");
  terminalEl.innerHTML = "";
  term.loadAddon(fitAddon);
  term.open(terminalEl);
  fitAddon.fit();

  term.writeln("\x1b[1;32mSSH Terminal\x1b[0m");
  term.writeln("Connect to a server to begin...\r\n");

  term.onData((data) => {
    if (serverId) {
      invoke("send_input", { shellId: serverId, input: data }).catch(console.error);
    }
  });

  window.addEventListener('resize', () => {
    fitAddon.fit();
  });
}

function updateConnectionState(state) {
  currentConnectionState = state;
  const statusEl = document.getElementById("connection-status");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const statusBarHost = document.getElementById("status-bar-host");
  const statusBarState = document.getElementById("status-bar-state");
  
  if (!term) return;
  
  switch (state.type) {
    case "Connecting":
      term.reset();
      term.writeln("\x1b[1;33mConnecting to server...\x1b[0m");
      statusEl.textContent = "Connecting...";
      statusEl.className = "text-sm text-yellow-600 dark:text-yellow-400";
      disconnectBtn.classList.add("hidden");
      if (currentServer) {
        statusBarHost.textContent = `${currentServer.user}@${currentServer.host}:${currentServer.port}`;
      }
      statusBarState.textContent = "Connecting";
      statusBarState.className = "font-medium text-yellow-600 dark:text-yellow-400";
      fitAddon.fit();
      break;
    case "Connected":
      term.reset();
      term.writeln("\x1b[1;32mConnected successfully!\x1b[0m");
      statusEl.textContent = "Connected";
      statusEl.className = "text-sm text-green-600 dark:text-green-400";
      disconnectBtn.classList.remove("hidden");
      if (currentServer) {
        statusBarHost.textContent = `${currentServer.user}@${currentServer.host}:${currentServer.port}`;
      }
      statusBarState.textContent = "Connected";
      statusBarState.className = "font-medium text-green-600 dark:text-green-400";
      fitAddon.fit();
      break;
    case "Disconnected":
      term.reset();
      term.writeln("Disconnected from server.");
      statusEl.textContent = "Disconnected";
      statusEl.className = "text-sm text-gray-600 dark:text-gray-400";
      disconnectBtn.classList.add("hidden");
      statusBarHost.textContent = "Not connected";
      statusBarState.textContent = "Disconnected";
      statusBarState.className = "font-medium text-gray-600 dark:text-gray-400";
      fitAddon.fit();
      if (serverId) {
        showAlert('Connection Lost', 'The SSH connection was unexpectedly disconnected.', 'warning');
      }
      serverId = null;
      currentServer = null;
      break;
    case "Error":
      term.reset();
      term.writeln(`\x1b[1;31mConnection error: ${state.error}\x1b[0m`);
      statusEl.textContent = "Error: " + state.error;
      statusEl.className = "text-sm text-red-600 dark:text-red-400";
      disconnectBtn.classList.add("hidden");
      if (currentServer) {
        statusBarHost.textContent = `${currentServer.user}@${currentServer.host}:${currentServer.port}`;
      }
      statusBarState.textContent = "Error";
      statusBarState.className = "font-medium text-red-600 dark:text-red-400";
      fitAddon.fit();
      showAlert(getErrorType(state.error), state.error);
      break;
  }
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

function renderServerList() {
  const listEl = document.getElementById("server-list");
  listEl.innerHTML = "";
  servers.forEach((server) => {
    const li = document.createElement("li");
    li.className = "flex justify-between items-center bg-gray-50 dark:bg-gray-700 p-2 rounded";
    li.innerHTML = `
      <span>${server.user}@${server.host}:${server.port}</span>
      <div class="flex gap-1">
        <button class="connect-btn text-green-500 hover:text-green-700 text-sm" data-id="${server.id}">Connect</button>
        <button class="edit-btn text-blue-500 hover:text-blue-700 text-sm" data-id="${server.id}">Edit</button>
        <button class="delete-btn text-red-500 hover:text-red-700 text-sm" data-id="${server.id}">Delete</button>
      </div>
    `;
    listEl.appendChild(li);
  });

  document.querySelectorAll(".connect-btn").forEach((btn) => {
    btn.addEventListener("click", () => connectToServer(btn.dataset.id));
  });

  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.id));
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteServer(btn.dataset.id));
  });
}

async function connectToServer(id) {
  const server = servers.find((s) => s.id === id);
  if (!server) return;

  currentServer = server;
  term.reset();
  term.writeln("\x1b[1;33mConnecting...\x1b[0m");

  try {
    serverId = await invoke("connect", { server });
  } catch (error) {
    console.error("Failed to connect:", error);
    term.reset();
    term.writeln(`\x1b[1;31mConnection failed: ${error}\x1b[0m`);
    showAlert(getErrorType(error), error);
  }
}

async function disconnectFromServer() {
  if (!serverId) return;

  try {
    await invoke("disconnect", { serverId });
    serverId = null;
    currentServer = null;
  } catch (error) {
    console.error("Failed to disconnect:", error);
    alert("Failed to disconnect: " + error);
  }
}

function openModal() {
  document.getElementById("server-modal").classList.remove("hidden");
  document.getElementById("modal-title").textContent = "Add Server";
  document.getElementById("server-form").reset();
  document.getElementById("server-id").value = "";
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
  document.getElementById("server-host").value = server.host;
  document.getElementById("server-port").value = server.port;
  document.getElementById("server-user").value = server.user;

  if (server.auth.type === "Password") {
    document.getElementById("auth-type").value = "password";
    document.getElementById("password-field").classList.remove("hidden");
    document.getElementById("key-field").classList.add("hidden");
    document.getElementById("server-password").value = server.auth.password;
  } else {
    document.getElementById("auth-type").value = "key";
    document.getElementById("password-field").classList.add("hidden");
    document.getElementById("key-field").classList.remove("hidden");
    document.getElementById("server-key").value = server.auth.private_key;
  }
}

async function saveServer(e) {
  e.preventDefault();

  const id = document.getElementById("server-id").value || crypto.randomUUID();
  const host = document.getElementById("server-host").value;
  const port = parseInt(document.getElementById("server-port").value);
  const user = document.getElementById("server-user").value;
  const authType = document.getElementById("auth-type").value;

  let auth;
  if (authType === "password") {
    auth = {
      type: "Password",
      password: document.getElementById("server-password").value,
    };
  } else {
    auth = {
      type: "Key",
      private_key: document.getElementById("server-key").value,
    };
  }

  const server = {
    id,
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
  snippets.forEach((snippet) => {
    const li = document.createElement("li");
    li.className = "flex flex-col bg-gray-50 dark:bg-gray-700 p-2 rounded cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600";
    li.innerHTML = `
      <div class="flex justify-between items-center">
        <span class="font-medium truncate flex-1">${snippet.name}</span>
        <div class="flex gap-1">
          <button class="snippet-run-btn text-green-500 hover:text-green-700 text-sm" data-id="${snippet.id}">Run</button>
          <button class="snippet-edit-btn text-blue-500 hover:text-blue-700 text-sm" data-id="${snippet.id}">Edit</button>
          <button class="snippet-delete-btn text-red-500 hover:text-red-700 text-sm" data-id="${snippet.id}">Delete</button>
        </div>
      </div>
      ${snippet.description ? `<p class="text-xs text-gray-500 dark:text-gray-400 truncate">${snippet.description}</p>` : ''}
    `;
    listEl.appendChild(li);

    li.addEventListener("click", (e) => {
      if (!e.target.classList.contains("snippet-run-btn") && !e.target.classList.contains("snippet-edit-btn") && !e.target.classList.contains("snippet-delete-btn")) {
        executeSnippet(snippet);
      }
    });
  });

  document.querySelectorAll(".snippet-run-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const snippet = snippets.find((s) => s.id === btn.dataset.id);
      if (snippet) executeSnippet(snippet);
    });
  });

  document.querySelectorAll(".snippet-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSnippetEditModal(btn.dataset.id);
    });
  });

  document.querySelectorAll(".snippet-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSnippet(btn.dataset.id);
    });
  });
}

function executeSnippet(snippet) {
  if (term && serverId) {
    term.writeln(`\r\n\x1b[1;33mRunning snippet: ${snippet.name}\x1b[0m\r\n`);
    term.write(snippet.command + "\r\n");
  } else {
    alert("Please connect to a server first");
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

document.getElementById("auth-type").addEventListener("change", (e) => {
  if (e.target.value === "password") {
    document.getElementById("password-field").classList.remove("hidden");
    document.getElementById("key-field").classList.add("hidden");
  } else {
    document.getElementById("password-field").classList.add("hidden");
    document.getElementById("key-field").classList.remove("hidden");
  }
});

window.addEventListener("DOMContentLoaded", () => {
  initTerminal();
  document.getElementById("add-server-btn").addEventListener("click", openModal);
  document.getElementById("cancel-btn").addEventListener("click", closeModal);
  document.getElementById("server-form").addEventListener("submit", saveServer);
  document.getElementById("disconnect-btn").addEventListener("click", disconnectFromServer);
  document.getElementById("add-snippet-btn").addEventListener("click", openSnippetModal);
  document.getElementById("snippet-cancel-btn").addEventListener("click", closeSnippetModal);
  document.getElementById("snippet-form").addEventListener("submit", saveSnippet);
  loadServers();
  loadSnippets();

  listen("connection-state", (event) => {
    updateConnectionState(event.payload);
  });

  listen("terminal-output", (event) => {
    if (term) {
      term.write(event.payload);
    }
  });
});
