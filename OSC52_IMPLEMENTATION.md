# OSC 52 Clipboard Support Implementation Plan

## Overview
Implement support for the OSC 52 escape sequence to enable seamless copying of text from remote servers to the local macOS clipboard in the Rust-based SSH terminal app. This allows remote commands to directly set the local clipboard without manual selection.

## How OSC 52 Works
- OSC 52 is an ANSI escape code with the format: `\x1b]52;c;<base64-encoded-text>\x07` (or `\a` for bell)
- On the remote server, users can run commands like: `printf "\033]52;c;$(base64 <<< 'your text here')\a"`
- The local terminal app parses incoming terminal output, detects OSC 52 sequences, decodes the Base64, and sets the clipboard
- **Formatting Preservation**: Base64 encoding preserves all bytes exactly, including newlines, tabs, spaces, and special characters, ensuring the copied text retains its original formatting

## Implementation Steps

### 1. Add Dependencies
Update `src-tauri/Cargo.toml` to include the required crates:

```toml
[dependencies]
# Existing dependencies...
vte = "0.11"          # For ANSI escape sequence parsing
arboard = "3.4"       # For clipboard access (works on macOS)
base64 = "0.22"       # Already included - for decoding base64 text
```

### 2. Create VTE Parser Handler
Create a handler struct to implement the `vte::Perform` trait, which will handle OSC 52 sequence detection and clipboard setting:

```rust
use vte::{Parser, Perform};
use arboard::Clipboard;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

struct TerminalOutputHandler {
    clipboard: Clipboard,
    output: Vec<u8>, // Buffer to store non-OSC 52 output
}

impl TerminalOutputHandler {
    fn new() -> Result<Self, arboard::Error> {
        Ok(TerminalOutputHandler {
            clipboard: Clipboard::new()?,
            output: Vec::new(),
        })
    }
}

impl Perform for TerminalOutputHandler {
    fn print(&mut self, c: char) {
        self.output.extend(c.to_string().as_bytes());
    }

    fn execute(&mut self, b: u8) {
        self.output.push(b);
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.len() >= 2 && params[0] == b"52" && params[1].starts_with(b"c;") {
            let encoded = &params[1][2..]; // Skip "c;" prefix
            if let Ok(decoded) = BASE64.decode(encoded) {
                if let Ok(text) = String::from_utf8(decoded) {
                    let _ = self.clipboard.set_text(text); // Set local clipboard
                }
            }
        }
    }

    // Implement other required Perform methods with default behavior that stores output
    fn csi_dispatch(&mut self, _params: &[i64], _intermediates: &[u8], _ignore: bool, _c: char) {}
    fn hook(&mut self, _params: &[i64], _intermediates: &[u8], _ignore: bool, _c: char) {}
    fn put(&mut self, _b: u8) {}
    fn unhook(&mut self) {}
    fn osc_end(&mut self) {}
}
```

### 3. Modify Terminal Output Processing
Update the SSH channel message handling in `/Users/kentaylor/developer/ssh-thing/src-tauri/src/lib.rs` (lines 1179-1187) to use the VTE parser:

```rust
// Replace existing ChannelMsg::Data handling:
match msg {
    russh::ChannelMsg::Data { ref data } => {
        // Process incoming data with VTE parser to extract OSC 52 sequences
        let mut handler = TerminalOutputHandler::new().unwrap(); // Handle error properly in production
        let mut parser = vte::Parser::new();

        for byte in data {
            parser.advance(&mut handler, *byte);
        }

        // Send only non-OSC 52 output to frontend
        if !handler.output.is_empty() {
            if let Ok(s) = std::str::from_utf8(&handler.output) {
                let payload = TerminalOutput {
                    shell_id: shell_id_for_task.clone(),
                    output: s.to_string(),
                };
                let _ = app_for_task.emit("terminal-output", payload);
            }
        }
    }
    // Other message types remain the same...
}
```

### 4. Error Handling
Implement proper error handling for:
- Failed clipboard initialization
- Invalid UTF-8 sequences
- Invalid base64 encoding
- OSC 52 sequence parsing errors

### 5. Testing
Test the implementation by:
1. Running remote commands that emit OSC 52 sequences
2. Verifying the clipboard is correctly updated
3. Testing with various text types (UTF-8 characters, multiline text)
4. Verifying formatting is preserved (newlines, tabs, spaces, etc.) - base64 encoding preserves all bytes exactly
5. Ensuring normal terminal output is unaffected

## Remote-Side Usage Examples
Users can use OSC 52 on remote servers with simple commands:

```bash
# Copy "Hello, world!" to local clipboard
printf "\033]52;c;$(base64 <<< 'Hello, world!')\a"

# Create a convenient alias
alias clip='printf "\033]52;c;$(base64 <<< "$1")\a"'
clip "Text to copy"
```

## Benefits
- Secure: All clipboard operations are local to the user's machine
- Works across SSH without additional channels
- Seamless integration with remote tools like Vim/Neovim/tmux (can be configured to use OSC 52 for yanking)
- No need for X11 forwarding or other complex setups

## Alternatives Considered
- X11 forwarding: Overkill and less reliable on macOS
- Custom clipboard sync protocol: Requires additional software on remote servers
- Manual selection: Inconvenient and error-prone for large text
