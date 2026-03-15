function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildMeta(server, summary, formatLastConnected) {
  const meta = [`:${server.port}`, formatLastConnected(server.last_connected_at)];

  if (summary.liveCount > 0) {
    const liveLabel = summary.connectingCount > 0 && summary.connectedCount > 0
      ? `${summary.connectedCount} connected • ${summary.connectingCount} opening`
      : summary.connectedCount > 0
        ? pluralize(summary.connectedCount, "session")
        : `${summary.connectingCount} opening`;
    meta.unshift(liveLabel);
  } else if (summary.totalCount > 1) {
    meta.unshift(pluralize(summary.totalCount, "tab"));
  }

  return meta;
}

function statusDot(summary) {
  switch (summary.primaryState) {
    case "Connecting":
      return '<div class="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0"></div>';
    case "Connected":
      return '<div class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></div>';
    case "Error":
      return '<div class="w-2 h-2 rounded-full bg-red-500 flex-shrink-0"></div>';
    default:
      return '<div class="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500 flex-shrink-0"></div>';
  }
}

function createServerCard({ server, summary, formatLastConnected, onPrimaryAction, onFocusServer, onDuplicate, onEdit, onDelete }) {
  const div = document.createElement("div");
  const hasLiveSessions = summary.liveCount > 0;
  const isActiveHost = summary.isActiveHost && hasLiveSessions;

  let statusClass = "";
  if (isActiveHost) {
    statusClass = "status-active";
  } else if (summary.primaryState === "Connected") {
    statusClass = "status-connected";
  } else if (summary.primaryState === "Connecting") {
    statusClass = "status-connecting";
  } else if (summary.primaryState === "Error") {
    statusClass = "status-error";
  }

  div.className = `server-item bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700/80 rounded-lg px-3 py-2.5 shadow-sm group flex items-center gap-3 cursor-pointer ${statusClass}`;

  const displayName = server.nickname && server.nickname.trim().length > 0 ? server.nickname : `${server.user}@${server.host}`;
  const subtitle = server.nickname && server.nickname.trim().length > 0
    ? `${server.user}@${server.host}`
    : `Port ${server.port}`;
  const meta = buildMeta(server, summary, formatLastConnected);

  const buttonLabel = hasLiveSessions ? "New Session" : "Connect";
  const buttonClass = hasLiveSessions ? "ghost-btn-primary" : "ghost-btn-success";
  const buttonIcon = hasLiveSessions
    ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>'
    : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>';

  div.innerHTML = `
    <div class="flex items-center gap-2.5 min-w-0 flex-1">
      ${statusDot(summary)}
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

  div.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    if (hasLiveSessions) {
      onFocusServer(server.id);
    }
  });

  div.querySelector(".connect-btn")?.addEventListener("click", () => onPrimaryAction(server.id));
  div.querySelector(".duplicate-btn")?.addEventListener("click", () => onDuplicate(server.id));
  div.querySelector(".edit-btn")?.addEventListener("click", () => onEdit(server.id));
  div.querySelector(".delete-btn")?.addEventListener("click", () => onDelete(server.id));

  return div;
}

export function renderServerList({
  listEl,
  filterWrap,
  servers,
  filterTerm,
  getHostSummary,
  formatLastConnected,
  onPrimaryAction,
  onFocusServer,
  onDuplicate,
  onEdit,
  onDelete,
}) {
  listEl.innerHTML = "";

  const normalizedTerm = filterTerm.trim().toLowerCase();
  const filteredServers = servers
    .filter((server) => {
      if (!normalizedTerm) return true;
      const nickname = server.nickname || "";
      const haystack = `${nickname} ${server.user} ${server.host}`.toLowerCase();
      return haystack.includes(normalizedTerm);
    })
    .sort((left, right) => (right.last_connected_at || 0) - (left.last_connected_at || 0));

  if (filterWrap) {
    filterWrap.classList.toggle("hidden", servers.length < 6);
  }

  if (servers.length === 0) {
    listEl.innerHTML = '<div class="text-center text-gray-500 dark:text-gray-400 mt-10 text-sm">No servers added yet.<br>Click "Add" to get started.</div>';
    return;
  }

  if (filteredServers.length === 0) {
    listEl.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 mt-10 text-sm">No matches for "${filterTerm}".</div>`;
    return;
  }

  const connectedServers = [];
  const otherServers = [];

  filteredServers.forEach((server) => {
    const summary = getHostSummary(server.id);
    if (summary.liveCount > 0) {
      connectedServers.push({ server, summary });
    } else {
      otherServers.push({ server, summary });
    }
  });

  if (connectedServers.length > 0) {
    const connectedLabel = document.createElement("div");
    connectedLabel.className = "server-section-label";
    connectedLabel.textContent = "Connected";
    listEl.appendChild(connectedLabel);

    connectedServers.forEach(({ server, summary }) => {
      listEl.appendChild(createServerCard({
        server,
        summary,
        formatLastConnected,
        onPrimaryAction,
        onFocusServer,
        onDuplicate,
        onEdit,
        onDelete,
      }));
    });
  }

  if (otherServers.length > 0) {
    const otherLabel = document.createElement("div");
    otherLabel.className = "server-section-label";
    otherLabel.textContent = connectedServers.length > 0 ? "Other Servers" : "Servers";
    listEl.appendChild(otherLabel);

    otherServers.forEach(({ server, summary }) => {
      listEl.appendChild(createServerCard({
        server,
        summary,
        formatLastConnected,
        onPrimaryAction,
        onFocusServer,
        onDuplicate,
        onEdit,
        onDelete,
      }));
    });
  }
}
