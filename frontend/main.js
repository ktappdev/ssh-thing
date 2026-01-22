const { invoke } = window.__TAURI__.core;

let servers = [];

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
        <button class="edit-btn text-blue-500 hover:text-blue-700 text-sm" data-id="${server.id}">Edit</button>
        <button class="delete-btn text-red-500 hover:text-red-700 text-sm" data-id="${server.id}">Delete</button>
      </div>
    `;
    listEl.appendChild(li);
  });

  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.id));
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteServer(btn.dataset.id));
  });
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
  loadServers();
});
