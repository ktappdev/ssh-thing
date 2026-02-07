# Product Requirements Document: Automatic Updates System

## 1. Executive Summary
This document outlines the requirements and implementation plan for adding automatic update capabilities to `ssh-thing`. The system will leverage the Tauri v2 Updater Plugin to enable Over-The-Air (OTA) updates, allowing users to receive the latest features and bug fixes seamlessly.

## 2. Objectives
- **Seamless Delivery**: Automate the delivery of new versions to end-users.
- **User Control**: Provide users with the ability to check for updates and decide when to install them.
- **Security**: Ensure all updates are signed and verified before installation.
- **Automation**: Streamline the release process for developers (push-to-deploy).

## 3. Architecture

### 3.1. Components
- **Tauri Plugin Updater (Rust)**: Handles the low-level logic of checking, downloading, verifying signatures, and replacing the application binary.
- **Tauri Plugin Updater (JavaScript)**: Provides the frontend API to trigger checks and installation from the UI.
- **Update Provider**: A static JSON endpoint that hosts the update manifest.
    - *Recommendation*: **GitHub Releases**. It's free, integrated with source control, and supports hosting binaries and the update manifest.
- **Signing System**: Minisign-based ECDSA keys to sign updates.

### 3.2. Data Flow
1.  **Check**: App requests the update manifest JSON from the Update Provider URL.
2.  **Verify**: App compares current version with the manifest version.
3.  **Prompt**: If newer, App notifies the user via the UI.
4.  **Download**: User initiates update; App downloads the signature and binary.
5.  **Install**: App verifies the signature using the embedded Public Key, installs the update, and restarts.

## 4. User Stories

### 4.1. End User
- **Passive Notification**: "As a user, I want to see a notification badge when a new version is available so I know I'm out of date."
- **Manual Check**: "As a user, I want to click 'Check for Updates' in settings to verify I have the latest version."
- **Consent**: "As a user, I want to choose when to restart the app to apply updates so my current SSH sessions aren't interrupted."

### 4.2. Developer
- **Push-to-Release**: "As a developer, I want to trigger a release by pushing a git tag (e.g., `v1.0.1`) so I don't have to manually build binaries."
- **Security**: "As a developer, I want the signing process to be automated in CI/CD without exposing private keys."

## 5. Functional Requirements

### 5.1. Core Updater Logic
- **FR-01**: The application MUST include the `tauri-plugin-updater` in both Rust and JavaScript contexts.
- **FR-02**: The application MUST be configured with a Public Key to verify update signatures.
- **FR-03**: The application MUST poll or allow manual checking of a remote JSON endpoint for update manifests.

### 5.2. User Interface
- **FR-04**: Add a "Check for Updates" button in the application UI (likely in a Settings modal or Help menu).
- **FR-05**: Display an "Update Available" modal with:
    - Version number (e.g., v1.0.1).
    - Release notes (optional but recommended).
    - "Install & Restart" button.
    - "Cancel" / "Remind Me Later" button.
- **FR-06**: Display download progress if possible (or at least a spinner).

### 5.3. Build & Release Pipeline
- **FR-07**: A GitHub Actions workflow MUST be created to:
    - Build the application for all target platforms (macOS, Windows, Linux).
    - Sign the binaries using the Private Key (stored in GitHub Secrets).
    - Create a GitHub Release.
    - Upload binaries and the `latest.json` manifest to the release.

## 6. Technical Implementation Plan

### Phase 1: Preparation
1.  **Generate Keys**: Run `npm run tauri signer generate -w ~/.tauri/ssh-thing.key` to generate the public/private key pair.
2.  **Store Secrets**: Add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_KEY_PASSWORD` to GitHub Repo Secrets.

### Phase 2: Code Integration
1.  **Rust Backend**:
    - Add `tauri-plugin-updater` to `src-tauri/Cargo.toml`.
    - Register the plugin in `src-tauri/src/lib.rs`.
2.  **Frontend**:
    - Install `@tauri-apps/plugin-updater`.
    - Create a utility service `updater.js` to handle checking and installing.
    - Create the UI components (Update Button, Modal).
3.  **Configuration**:
    - Update `src-tauri/tauri.conf.json`:
        - Add `plugins.updater`.
        - Set `endpoints` to the GitHub Releases URL format.
        - Add the `pubkey`.

### Phase 3: CI/CD Setup
1.  Create `.github/workflows/release.yml`.
2.  Configure it to run on `push` to `tags` (e.g., `v*`).
3.  Use `tauri-apps/tauri-action` to handle building and releasing.

## 7. Risks & Mitigation
- **Risk**: Bad update breaks the app (boot loop).
    - *Mitigation*: Extensive testing of the build artifact before tagging release.
- **Risk**: Private key leak.
    - *Mitigation*: Rotate keys immediately if suspected; users will need to manually reinstall once to get the new public key.
- **Risk**: Platform differences (macOS permissions).
    - *Mitigation*: Ensure code signing (Apple Developer ID) is handled in the pipeline if distributing to macOS users widely (otherwise they get "Unverified Developer" warnings).

## 8. Open Questions / Decisions
- **Distribution Channel**: Confirming GitHub Releases is the target.
- **Auto-Install**: Do we want to download in the background automatically? (Recommendation: No, let user initiate download to save bandwidth/resources until requested).
