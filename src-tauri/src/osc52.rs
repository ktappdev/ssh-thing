use arboard::Clipboard;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tracing::debug;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const MAX_OSC_SEQUENCE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParserState {
    Ground,
    Escape,
    Osc,
    OscEscape,
}

pub trait ClipboardSink {
    fn set_text(&mut self, text: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct SystemClipboard {
    clipboard: Option<Clipboard>,
}

impl ClipboardSink for SystemClipboard {
    fn set_text(&mut self, text: &str) -> Result<(), String> {
        if self.clipboard.is_none() {
            self.clipboard = Some(
                Clipboard::new().map_err(|e| format!("Failed to initialize clipboard: {}", e))?,
            );
        }

        self.clipboard
            .as_mut()
            .ok_or_else(|| "Clipboard unavailable".to_string())?
            .set_text(text)
            .map_err(|e| format!("Failed to set clipboard text: {}", e))
    }
}

pub struct Osc52Processor<C> {
    clipboard: C,
    state: ParserState,
    sequence: Vec<u8>,
}

impl<C> Osc52Processor<C>
where
    C: ClipboardSink,
{
    pub fn new(clipboard: C) -> Self {
        Self {
            clipboard,
            state: ParserState::Ground,
            sequence: Vec::new(),
        }
    }

    pub fn process(&mut self, data: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(data.len());

        for &byte in data {
            match self.state {
                ParserState::Ground => {
                    if byte == ESC {
                        self.sequence.clear();
                        self.sequence.push(byte);
                        self.state = ParserState::Escape;
                    } else {
                        output.push(byte);
                    }
                }
                ParserState::Escape => {
                    if byte == b']' {
                        self.sequence.push(byte);
                        self.state = ParserState::Osc;
                    } else {
                        output.extend_from_slice(&self.sequence);
                        self.sequence.clear();
                        self.state = ParserState::Ground;

                        if byte == ESC {
                            self.sequence.push(byte);
                            self.state = ParserState::Escape;
                        } else {
                            output.push(byte);
                        }
                    }
                }
                ParserState::Osc => {
                    if byte == BEL {
                        self.sequence.push(byte);
                        self.finish_sequence(&mut output, true);
                    } else if byte == ESC {
                        self.state = ParserState::OscEscape;
                    } else {
                        self.sequence.push(byte);
                        self.enforce_sequence_cap(&mut output);
                    }
                }
                ParserState::OscEscape => {
                    if byte == b'\\' {
                        self.sequence.push(ESC);
                        self.sequence.push(byte);
                        self.finish_sequence(&mut output, false);
                    } else {
                        self.sequence.push(ESC);
                        self.sequence.push(byte);
                        self.state = ParserState::Osc;
                        self.enforce_sequence_cap(&mut output);
                    }
                }
            }
        }

        output
    }

    pub fn flush_pending(&mut self) -> Vec<u8> {
        if self.sequence.is_empty() {
            return Vec::new();
        }

        let mut pending = Vec::new();
        pending.extend_from_slice(&self.sequence);
        self.sequence.clear();
        self.state = ParserState::Ground;
        pending
    }

    fn finish_sequence(&mut self, output: &mut Vec<u8>, bell_terminated: bool) {
        let handled = self.try_handle_osc52(bell_terminated);
        if !handled {
            output.extend_from_slice(&self.sequence);
        }
        self.sequence.clear();
        self.state = ParserState::Ground;
    }

    fn try_handle_osc52(&mut self, bell_terminated: bool) -> bool {
        let terminator_len = if bell_terminated { 1 } else { 2 };
        if self.sequence.len() < 4 + terminator_len {
            return false;
        }

        let payload = &self.sequence[2..self.sequence.len() - terminator_len];
        let mut parts = payload.splitn(3, |byte| *byte == b';');

        let Some(command) = parts.next() else {
            return false;
        };
        if command != b"52" {
            return false;
        }

        let Some(target) = parts.next() else {
            return false;
        };
        let Some(encoded) = parts.next() else {
            return false;
        };

        if !target.is_empty() && !target.contains(&b'c') {
            return false;
        }

        let compact_encoded = Self::strip_ascii_whitespace(encoded);

        match BASE64.decode(compact_encoded) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => {
                    if let Err(error) = self.clipboard.set_text(&text) {
                        debug!(error = %error, "OSC 52 clipboard update failed");
                    }
                }
                Err(error) => {
                    debug!(error = %error, "OSC 52 payload was not valid UTF-8");
                }
            },
            Err(error) => {
                debug!(error = %error, "OSC 52 payload was not valid base64");
            }
        }

        true
    }

    fn strip_ascii_whitespace(bytes: &[u8]) -> Vec<u8> {
        bytes
            .iter()
            .copied()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect()
    }

    fn enforce_sequence_cap(&mut self, output: &mut Vec<u8>) {
        if self.sequence.len() <= MAX_OSC_SEQUENCE_BYTES {
            return;
        }

        debug!(
            limit = MAX_OSC_SEQUENCE_BYTES,
            actual = self.sequence.len(),
            "Dropping OSC parsing state after sequence exceeded cap"
        );
        output.extend_from_slice(&self.sequence);
        self.sequence.clear();
        self.state = ParserState::Ground;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct TestClipboard {
        values: Vec<String>,
    }

    impl ClipboardSink for TestClipboard {
        fn set_text(&mut self, text: &str) -> Result<(), String> {
            self.values.push(text.to_string());
            Ok(())
        }
    }

    #[test]
    fn process_passes_through_plain_text() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let output = processor.process(b"plain output");

        assert_eq!(output, b"plain output");
        assert!(processor.clipboard.values.is_empty());
    }

    #[test]
    fn process_strips_bell_terminated_osc52_sequences() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let output = processor.process(b"before\x1b]52;c;SGVsbG8gd29ybGQ=\x07after");

        assert_eq!(output, b"beforeafter");
        assert_eq!(processor.clipboard.values, vec!["Hello world"]);
    }

    #[test]
    fn process_handles_split_osc52_sequences_across_chunks() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let first = processor.process(b"before\x1b]52;c;U3BsaXQg");
        let second = processor.process(b"cGF5bG9hZA==\x1b\\after");

        assert_eq!(first, b"before");
        assert_eq!(second, b"after");
        assert_eq!(processor.clipboard.values, vec!["Split payload"]);
    }

    #[test]
    fn process_preserves_other_osc_sequences() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let output = processor.process(b"\x1b]0;window title\x07");

        assert_eq!(output, b"\x1b]0;window title\x07");
        assert!(processor.clipboard.values.is_empty());
    }

    #[test]
    fn process_swallows_invalid_osc52_payloads() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let output = processor.process(b"start\x1b]52;c;not-base64\x07end");

        assert_eq!(output, b"startend");
        assert!(processor.clipboard.values.is_empty());
    }

    #[test]
    fn process_decodes_wrapped_base64_payloads() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let output = processor.process(b"start\x1b]52;c;SGVsbG8g\nd29ybGQ=\x07end");

        assert_eq!(output, b"startend");
        assert_eq!(processor.clipboard.values, vec!["Hello world"]);
    }

    #[test]
    fn flush_pending_returns_partial_sequence_bytes() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let output = processor.process(b"abc\x1b]");
        let pending = processor.flush_pending();

        assert_eq!(output, b"abc");
        assert_eq!(pending, b"\x1b]");
    }

    #[test]
    fn process_caps_unterminated_osc_sequence_growth() {
        let mut processor = Osc52Processor::new(TestClipboard::default());
        let oversized = vec![b'a'; MAX_OSC_SEQUENCE_BYTES + 2];
        let mut input = vec![ESC, b']', b'5', b'2', b';', b'c', b';'];
        input.extend_from_slice(&oversized);
        let output = processor.process(&input);
        let pending = processor.flush_pending();

        assert_eq!(output, input);
        assert!(pending.is_empty());
        assert!(processor.clipboard.values.is_empty());
    }
}
