const GITHUB_URL = "https://github.com/ktappdev";
const TWITTER_URL = "https://twitter.com/ktappdev";
const FALLBACK_VERSION = "unknown";

async function getAppVersion() {
  const tauriApp = window.__TAURI__?.app;
  if (tauriApp) {
    const getVersion =
      typeof tauriApp.getVersion === "function"
        ? tauriApp.getVersion.bind(tauriApp)
        : typeof tauriApp.version === "function"
          ? tauriApp.version.bind(tauriApp)
          : null;
    if (getVersion) {
      try {
        return await getVersion();
      } catch (error) {
        console.warn("Failed to load app version:", error);
      }
    }
  }

  return FALLBACK_VERSION;
}

async function openExternal(url) {
  const opener = window.__TAURI__?.opener;
  if (opener && typeof opener.openUrl === "function") {
    await opener.openUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

export async function initAboutModal() {
  const modal = document.getElementById("about-modal");
  const openButton = document.getElementById("about-btn");
  const closeButton = document.getElementById("about-close-btn");
  const versionLabel = document.getElementById("about-version");
  const githubButton = document.getElementById("about-github");
  const twitterButton = document.getElementById("about-twitter");

  if (!modal || !openButton || !closeButton || !versionLabel || !githubButton || !twitterButton) {
    return;
  }

  const openModal = () => modal.classList.remove("hidden");
  const closeModal = () => modal.classList.add("hidden");

  versionLabel.textContent = `Version ${await getAppVersion()}`;

  openButton.addEventListener("click", openModal);
  closeButton.addEventListener("click", closeModal);
  githubButton.addEventListener("click", () => openExternal(GITHUB_URL));
  twitterButton.addEventListener("click", () => openExternal(TWITTER_URL));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });
}
