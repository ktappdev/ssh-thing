const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let servers = [];
let currentConnectionState = { type: "Disconnected" };

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

function updateConnectionState(state) {
  currentConnectionState = state;
  const terminal = document.getElementById("terminal");
  const statusEl = document.getElementById("connection-status");
  const disconnectBtn = document.getElementById("disconnect-btn");
  
  switch (state.type) {
    case "Connecting":
      terminal.innerHTML = `<p class="text-yellow-400">Connecting to server...</p>`;
      statusEl.textContent = "Connecting...";
      statusEl.className = "text-sm text-yellow-600 dark:text-yellow-400";
      disconnectBtn.classList.add("hidden");
      break;
    case "Connected":
      terminal.innerHTML = `<p class="text-green-400">Connected successfully!</p>`;
      statusEl.textContent = "Connected";
      statusEl.className = "text-sm text-green-600 dark:text-green-400";
      disconnectBtn.classList.remove("hidden");
      break;
    case "Disconnected":
      terminal.innerHTML = `<p>Disconnected from server.</p>`;
      statusEl.textContent = "Disconnected";
      statusEl.className = "text-sm text-gray-600 dark:text-gray-400";
      disconnectBtn.classList.add("hidden");
      break;
    case "Error":
      terminal.innerHTML = `<p class="text-red-400">Connection error: ${state.error}</p>`;
      statusEl.textContent = "Error: " + state.error;
      statusEl.className = "text-sm text-red-600 dark:text-red-400";
      disconnectBtn.classList.add("hidden");
      break;
  }
}

async function connectToServer(id) {
  const server = servers.find((s) => s.id === id);
  if (!server) return;

  try {
    await invoke("connect_to_server", { server });
  } catch (error) {
    console.error("Failed to connect:", error);
    alert("Failed to connect: " + error);
  }
}

async function disconnectFromServer() {
  try {
    await invoke("disconnect_from_server");
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
  document.getElementById("add-server-btn").addEventListener("click", openModal);
  document.getElementById("cancel-btn").addEventListener("click", closeModal);
  document.getElementById("server-form").addEventListener("submit", saveServer);
  document.getElementById("disconnect-btn").addEventListener("click", disconnectFromServer);
  loadServers();
  
  listen("connection-state", (event) => {
    updateConnectionState(event.payload);
  });
});
