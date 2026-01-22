const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let servers = [];
let currentConnectionState = { type: "Disconnected" };
let term;
let fitAddon;
let shellId;

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
    if (shellId) {
      invoke("send_input", { shellId, input: data }).catch(console.error);
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
  
  if (!term) return;
  
  switch (state.type) {
    case "Connecting":
      term.reset();
      term.writeln("\x1b[1;33mConnecting to server...\x1b[0m");
      statusEl.textContent = "Connecting...";
      statusEl.className = "text-sm text-yellow-600 dark:text-yellow-400";
      disconnectBtn.classList.add("hidden");
      fitAddon.fit();
      break;
    case "Connected":
      term.reset();
      term.writeln("\x1b[1;32mConnected successfully!\x1b[0m");
      statusEl.textContent = "Connected";
      statusEl.className = "text-sm text-green-600 dark:text-green-400";
      disconnectBtn.classList.remove("hidden");
      fitAddon.fit();
      break;
    case "Disconnected":
      term.reset();
      term.writeln("Disconnected from server.");
      statusEl.textContent = "Disconnected";
      statusEl.className = "text-sm text-gray-600 dark:text-gray-400";
      disconnectBtn.classList.add("hidden");
      fitAddon.fit();
      break;
    case "Error":
      term.reset();
      term.writeln(`\x1b[1;31mConnection error: ${state.error}\x1b[0m`);
      statusEl.textContent = "Error: " + state.error;
      statusEl.className = "text-sm text-red-600 dark:text-red-400";
      disconnectBtn.classList.add("hidden");
      fitAddon.fit();
      break;
  }
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

  term.reset();
  term.writeln("\x1b[1;33mConnecting...\x1b[0m");

  try {
    shellId = await invoke("connect", { server });
  } catch (error) {
    console.error("Failed to connect:", error);
    term.reset();
    term.writeln(`\x1b[1;31mConnection failed: ${error}\x1b[0m`);
  }
}

async function disconnectFromServer() {
  if (!shellId) return;

  try {
    await invoke("disconnect", { serverId: shellId });
    shellId = null;
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
  loadServers();

  listen("connection-state", (event) => {
    updateConnectionState(event.payload);
  });

  listen("terminal-output", (event) => {
    if (term) {
      term.write(event.payload);
    }
  });
});
