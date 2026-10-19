// File upload UI: the confirmation modal, the header button, drag-and-drop,
// and progress rendering. The transfer itself happens in Rust; this module
// only collects intent and displays the outcome.

const DEFAULT_DESTINATION = "~";

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function basename(path) {
  const parts = String(path ?? "").split(/[\\/]/);
  return parts[parts.length - 1] || String(path ?? "");
}

export function createTransferManager(options) {
  const { invoke, showToast, showAlert, getActiveSession } = options;

  let pendingPaths = [];
  let pendingCandidates = [];
  let uploading = false;
  let lastProgress = null;

  const modal = () => document.getElementById("upload-modal");
  const fileListEl = () => document.getElementById("upload-file-list");
  const fileSummaryEl = () => document.getElementById("upload-file-summary");
  const destinationEl = () => document.getElementById("upload-destination");
  const overwriteEl = () => document.getElementById("upload-overwrite");
  const confirmBtn = () => document.getElementById("upload-confirm");
  const cancelBtn = () => document.getElementById("upload-cancel");
  const progressWrap = () => document.getElementById("upload-progress-wrap");
  const progressBar = () => document.getElementById("upload-progress-bar");
  const progressTrack = () => document.getElementById("upload-progress-bar-track");
  const progressLabel = () => document.getElementById("upload-progress-label");
  const progressCount = () => document.getElementById("upload-progress-count");

  function activeConnection() {
    const session = getActiveSession();
    if (!session?.shellId) return null;
    if (session.connectionState?.type !== "Connected") return null;
    return session;
  }

  function requireConnection() {
    const session = activeConnection();
    if (!session) {
      showToast?.("Connect to a server before uploading.", "warning");
      return null;
    }
    return session;
  }

  function renderFileList() {
    const list = fileListEl();
    if (!list) return;

    list.innerHTML = "";
    for (const candidate of pendingCandidates) {
      const item = document.createElement("li");
      item.className = "flex justify-between gap-3";
      const name = document.createElement("span");
      name.className = "truncate";
      name.textContent = candidate.name;
      const size = document.createElement("span");
      size.className = "text-gray-500 dark:text-gray-400 flex-shrink-0";
      size.textContent = formatBytes(candidate.size);
      item.append(name, size);
      list.appendChild(item);
    }

    const summary = fileSummaryEl();
    if (summary) {
      const count = pendingCandidates.length;
      const label = `${count} ${count === 1 ? "file" : "files"}`;
      // Sizes are unknown for drag-and-drop, so only report a total when every
      // file has one. A bogus "0 B" would be worse than saying nothing.
      const known = pendingCandidates.every((candidate) => candidate.size !== null);
      if (known) {
        const total = pendingCandidates.reduce((sum, candidate) => sum + candidate.size, 0);
        summary.textContent = `${label} · ${formatBytes(total)}`;
      } else {
        summary.textContent = label;
      }
    }
  }

  function resetProgress() {
    progressWrap()?.classList.add("hidden");
    if (progressBar()) progressBar().style.width = "0%";
    if (progressCount()) progressCount().textContent = "";
    if (progressLabel()) progressLabel().textContent = "Uploading...";
    progressTrack()?.setAttribute("aria-valuenow", "0");
  }

  function setBusy(busy) {
    uploading = busy;
    const button = confirmBtn();
    if (button) {
      button.disabled = busy;
      button.classList.toggle("opacity-70", busy);
      button.classList.toggle("cursor-not-allowed", busy);
      button.textContent = busy ? "Uploading..." : "Upload";
    }
    const cancel = cancelBtn();
    if (cancel) cancel.disabled = busy;
    const input = destinationEl();
    if (input) input.disabled = busy;
    if (overwriteEl()) overwriteEl().disabled = busy;
    const headerBtn = document.getElementById("upload-btn");
    if (headerBtn) headerBtn.disabled = busy;
  }

  function openModal(candidates, paths) {
    pendingCandidates = candidates;
    pendingPaths = paths;
    renderFileList();
    resetProgress();
    setBusy(false);
    if (destinationEl()) destinationEl().value = DEFAULT_DESTINATION;
    if (overwriteEl()) overwriteEl().checked = false;

    const el = modal();
    if (!el) return;
    el.classList.remove("hidden");
    requestAnimationFrame(() => destinationEl()?.focus());
  }

  function closeModal() {
    if (uploading) return;
    modal()?.classList.add("hidden");
    pendingPaths = [];
    pendingCandidates = [];
  }

  // Derives display names for paths that arrived by drag-and-drop, which the
  // OS hands over without metadata. `size: null` means "unknown", not zero, so
  // the modal never claims a 4 GB video is empty. The backend reports the real
  // size, and a stat failure surfaces there as a per-file error.
  function describePaths(paths) {
    return paths.map((path) => ({ path, name: basename(path), size: null }));
  }

  async function chooseAndUpload() {
    if (uploading) return;
    if (!requireConnection()) return;

    let candidates = [];
    try {
      candidates = await invoke("pick_upload_files");
    } catch (error) {
      showAlert?.("Upload Failed", String(error));
      return;
    }

    // Cancelling the picker is a no-op, not a failure.
    if (!candidates || candidates.length === 0) return;

    openModal(candidates, candidates.map((candidate) => candidate.path));
  }

  async function uploadPaths(paths) {
    if (uploading) return;
    if (!Array.isArray(paths) || paths.length === 0) return;
    if (!requireConnection()) return;

    openModal(describePaths(paths), paths);
  }

  function handleProgress(payload) {
    if (!payload) return;
    lastProgress = payload;

    const wrap = progressWrap();
    if (wrap) wrap.classList.remove("hidden");

    const total = Number(payload.totalBytes) || 0;
    const sent = Number(payload.bytesSent) || 0;
    const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;

    if (progressBar()) progressBar().style.width = `${percent}%`;
    progressTrack()?.setAttribute("aria-valuenow", String(percent));
    if (progressLabel()) {
      progressLabel().textContent = payload.done
        ? `Uploaded ${payload.name}`
        : `Uploading ${payload.name}`;
    }
    if (progressCount()) {
      const index = Number(payload.index) || 0;
      const count = Number(payload.totalFiles) || 1;
      progressCount().textContent = `${Math.min(index + 1, count)} of ${count}`;
    }
  }

  // Summarise a finished batch without losing per-file detail.
  function reportResults(results) {
    if (!Array.isArray(results) || results.length === 0) return;

    const uploaded = results.filter((result) => result.status === "uploaded");
    const skipped = results.filter((result) => result.status === "skippedExists");
    const failed = results.filter((result) => result.status === "failed");

    if (uploaded.length > 0) {
      const destination = uploaded[0].remotePath || "";
      const directory = destination.includes("/")
        ? destination.slice(0, destination.lastIndexOf("/"))
        : destination;
      showToast?.(
        `Uploaded ${uploaded.length} ${uploaded.length === 1 ? "file" : "files"} to ${directory || "the server"}.`,
        "success",
      );
    }

    if (skipped.length > 0) {
      showToast?.(
        `${skipped.length} ${skipped.length === 1 ? "file was" : "files were"} skipped because ${skipped.length === 1 ? "it" : "they"} already exist.`,
        "warning",
      );
    }

    if (failed.length > 0) {
      const summary = failed
        .map((result) => `${result.name}: ${result.error || "failed"}`)
        .join("\n");
      showAlert?.(
        failed.length === 1 ? "Upload Failed" : `${failed.length} Uploads Failed`,
        summary,
      );
    }
  }

  async function runUpload() {
    if (uploading) return;

    const session = activeConnection();
    if (!session) {
      showAlert?.("Upload Failed", "This session is no longer connected.");
      closeModal();
      return;
    }

    if (pendingPaths.length === 0) {
      closeModal();
      return;
    }

    const destination = destinationEl()?.value ?? DEFAULT_DESTINATION;
    if (!destination.trim()) {
      showAlert?.("Upload Failed", "Enter a destination directory.");
      return;
    }

    setBusy(true);
    resetProgress();
    progressWrap()?.classList.remove("hidden");

    try {
      const results = await invoke("upload_files", {
        request: {
          connectionId: session.id,
          localPaths: pendingPaths,
          remoteDir: destination,
          overwrite: Boolean(overwriteEl()?.checked),
        },
      });
      setBusy(false);
      reportResults(results);
      modal()?.classList.add("hidden");
      pendingPaths = [];
      pendingCandidates = [];
    } catch (error) {
      setBusy(false);
      showAlert?.("Upload Failed", String(error));
    }
  }

  function init() {
    document.getElementById("upload-btn")?.addEventListener("click", chooseAndUpload);
    cancelBtn()?.addEventListener("click", closeModal);

    document.getElementById("upload-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      runUpload();
    });

    modal()?.addEventListener("click", (event) => {
      if (event.target === modal()) closeModal();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal()?.classList.contains("hidden")) {
        closeModal();
      }
    });
  }

  return {
    init,
    chooseAndUpload,
    uploadPaths,
    handleProgress,
    get isUploading() {
      return uploading;
    },
    get lastProgress() {
      return lastProgress;
    },
  };
}
