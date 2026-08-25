# macOS Install Notes (Gatekeeper)

ssh-thing is currently not signed/notarized. On macOS, this means Gatekeeper may block it the first time you run it.

## Recommended install

For the latest release, the repository includes an installer that selects the
correct Intel or Apple Silicon DMG, installs it into `/Applications`, removes
the quarantine attribute, and launches the app:

```bash
curl -fsSL https://raw.githubusercontent.com/ktappdev/ssh-thing/main/scripts/install-latest-macos.sh \
  -o /tmp/install-ssh-thing.sh && \
bash /tmp/install-ssh-thing.sh
```

The script downloads only from the official GitHub repository and may ask for
your administrator password when replacing an existing application. Because
the current release is unsigned/not notarized, it removes `com.apple.quarantine`
to avoid the first-launch Gatekeeper block. Review the script before running it
if you prefer to keep the normal Gatekeeper prompt.

1. Download the `.dmg` from the GitHub release.
2. Open the `.dmg`.
3. Drag **SSH Thing** to **Applications**.
4. Open **Applications** and launch **SSH Thing**.

## If macOS blocks it

### Option A (recommended)

1. In **Applications**, right-click **SSH Thing**.
2. Click **Open**.
3. In the dialog, click **Open**.

### Option B (Privacy & Security)

1. Try launching the app once (so macOS records the block).
2. Open **System Settings**.
3. Go to **Privacy & Security**.
4. Scroll down to **Security**.
5. Click **Open Anyway** for SSH Thing.

## If it says “damaged” (advanced)

Sometimes the file quarantine flag causes a “damaged” message.

```bash
sudo xattr -dr com.apple.quarantine "/Applications/SSH THING.app"
```

## Requirements

- macOS 11.0 or later
