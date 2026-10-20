//! From the bytes of a downloaded or cached feed to UTF-8 text.
//!
//! Two layers, both streaming: `Decompress` undoes gzip when the bytes start
//! with its magic number, and `Utf8Reader` transcodes whatever encoding the
//! document uses to UTF-8, replacing malformed bytes with U+FFFD. quick-xml
//! only ever sees valid UTF-8, so one stray byte costs one character instead
//! of the rest of the guide.

use anyhow::Context;
use encoding_rs::{DecoderResult, Encoding, UTF_8};
use flate2::bufread::GzDecoder;
use std::io::{self, BufRead, BufReader, Read};

/// How much of the start of a document is searched for a byte order mark or
/// an XML declaration naming the encoding.
const SNIFF_LEN: usize = 1024;

/// Buffer sizes of the transcoder and of the reader handed to quick-xml.
const BUF_LEN: usize = 64 * 1024;

/// Longest declared encoding label kept for the report, in characters.
const MAX_LABEL_CHARS: usize = 40;

const PLAIN_READ_FAILURE: &str = "Failed to read EPG";

/// The UTF-8 bytes of U+FFFD.
const REPLACEMENT: &[u8] = "\u{fffd}".as_bytes();

/// Check if bytes are gzipped (magic bytes: 1f 8b)
pub fn is_gzipped(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// A feed's bytes with gzip undone, if they were gzipped.
pub enum Decompress<R: BufRead> {
    Gzip(GzDecoder<R>),
    Plain(R),
}

impl<R: BufRead> Decompress<R> {
    /// Look at the first bytes of `input` without consuming them and pick
    /// gzip or plain. The magic number has to be in the first buffer `input`
    /// fills, which holds for files and byte slices.
    pub fn new(mut input: R) -> io::Result<Self> {
        if is_gzipped(input.fill_buf()?) {
            Ok(Self::Gzip(GzDecoder::new(input)))
        } else {
            Ok(Self::Plain(input))
        }
    }

    pub fn is_gzip(&self) -> bool {
        matches!(self, Self::Gzip(_))
    }

    /// The context for a read error of this stream.
    pub fn read_failure(&self) -> &'static str {
        if self.is_gzip() {
            "Failed to decompress gzipped EPG"
        } else {
            PLAIN_READ_FAILURE
        }
    }
}

impl<R: BufRead> Read for Decompress<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Gzip(gz) => gz.read(buf),
            Self::Plain(plain) => plain.read(buf),
        }
    }
}

/// Read the rest of a source to its end, discarding it.
///
/// Used after the XML breaks off: gzip checks length and CRC only at the end
/// of the stream, so draining is what makes a damaged download fail as a
/// whole, while malformed XML in an intact file keeps the programmes read
/// before the fault.
pub fn drain<R: Read>(mut rest: R) -> io::Result<u64> {
    io::copy(&mut rest, &mut io::sink())
}

/// The encoding named by a document's XML declaration, as written.
fn declared_label(head: &str) -> Option<&str> {
    let decl = head.strip_prefix("<?xml")?;
    let decl = &decl[..decl.find("?>")?];
    let mut rest = decl;
    loop {
        let at = rest.find("encoding")?;
        let before = rest[..at].chars().next_back();
        rest = &rest[at + "encoding".len()..];
        // `encoding` must be a whole attribute name, not part of another.
        if before.is_some_and(|c| !c.is_ascii_whitespace()) {
            continue;
        }
        let Some(value) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        let quote = value.chars().next().filter(|q| matches!(q, '"' | '\''))?;
        let value = &value[1..];
        return Some(&value[..value.find(quote)?]);
    }
}

/// Transcodes a document to UTF-8 while it is read.
///
/// The encoding comes from a byte order mark (UTF-8, UTF-16 LE or BE), else
/// from the `encoding` of the XML declaration, else it is UTF-8. A declared
/// encoding `encoding_rs` does not know is read as UTF-8; a declared UTF-16
/// without a byte order mark is too, since the declaration could only be
/// read because the bytes are ASCII-compatible. Malformed input becomes
/// U+FFFD and is counted.
pub struct Utf8Reader<R: Read> {
    inner: R,
    decoder: encoding_rs::Decoder,
    encoding: &'static Encoding,
    declared: Option<String>,
    input: Box<[u8]>,
    in_start: usize,
    in_end: usize,
    input_done: bool,
    output: Box<[u8]>,
    out_start: usize,
    out_end: usize,
    finished: bool,
    replacements: u64,
}

impl<R: Read> Utf8Reader<R> {
    /// Read up to `SNIFF_LEN` bytes from `inner` to choose the encoding.
    pub fn new(mut inner: R) -> io::Result<Self> {
        let mut input = vec![0u8; BUF_LEN].into_boxed_slice();
        let mut filled = 0;
        let mut input_done = false;
        while filled < SNIFF_LEN {
            match inner.read(&mut input[filled..SNIFF_LEN]) {
                Ok(0) => {
                    input_done = true;
                    break;
                }
                Ok(n) => filled += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        let head = &input[..filled];

        let (encoding, bom_len) = match Encoding::for_bom(head) {
            Some((encoding, bom_len)) => (encoding, bom_len),
            None => (UTF_8, 0),
        };
        // Read the declaration in the encoding found so far; the head may
        // end inside a character, which only affects text after it.
        let (head_text, _) = encoding.decode_without_bom_handling(&head[bom_len..]);
        let declared = declared_label(&head_text).map(|label| {
            label
                .trim()
                .chars()
                .take(MAX_LABEL_CHARS)
                .collect::<String>()
        });
        let encoding = if bom_len > 0 {
            encoding
        } else {
            declared
                .as_deref()
                .and_then(|label| Encoding::for_label(label.as_bytes()))
                .map_or(UTF_8, Encoding::output_encoding)
        };

        Ok(Self {
            inner,
            decoder: encoding.new_decoder_without_bom_handling(),
            encoding,
            declared,
            input,
            in_start: bom_len,
            in_end: filled,
            input_done,
            output: vec![0u8; BUF_LEN].into_boxed_slice(),
            out_start: 0,
            out_end: 0,
            finished: false,
            replacements: 0,
        })
    }

    /// The encoding the document is read in.
    pub fn encoding(&self) -> &'static Encoding {
        self.encoding
    }

    /// The encoding label of the XML declaration, as written.
    pub fn declared_encoding(&self) -> Option<&str> {
        self.declared.as_deref()
    }

    /// Malformed sequences replaced with U+FFFD so far.
    pub fn replacements(&self) -> u64 {
        self.replacements
    }

    pub fn get_ref(&self) -> &R {
        &self.inner
    }

    /// The source, positioned wherever transcoding stopped.
    pub fn into_inner(self) -> R {
        self.inner
    }

    /// Decode the next piece of input into `output`. Leaves room for one
    /// U+FFFD after what the decoder wrote.
    fn decode_more(&mut self) -> io::Result<()> {
        if self.in_start == self.in_end && !self.input_done {
            self.in_start = 0;
            self.in_end = loop {
                match self.inner.read(&mut self.input) {
                    Ok(n) => break n,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(e),
                }
            };
            self.input_done = self.in_end == 0;
        }

        let room = self.output.len() - REPLACEMENT.len();
        let (result, read, written) = self.decoder.decode_to_utf8_without_replacement(
            &self.input[self.in_start..self.in_end],
            &mut self.output[..room],
            self.input_done,
        );
        self.in_start += read;
        self.out_start = 0;
        self.out_end = written;
        match result {
            DecoderResult::InputEmpty => self.finished = self.input_done,
            DecoderResult::OutputFull => {}
            DecoderResult::Malformed(_, _) => {
                self.output[written..written + REPLACEMENT.len()].copy_from_slice(REPLACEMENT);
                self.out_end += REPLACEMENT.len();
                self.replacements += 1;
            }
        }
        Ok(())
    }
}

impl<R: Read> Read for Utf8Reader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.out_start == self.out_end {
            if self.finished || buf.is_empty() {
                return Ok(0);
            }
            self.decode_more()?;
        }
        let n = buf.len().min(self.out_end - self.out_start);
        buf[..n].copy_from_slice(&self.output[self.out_start..self.out_start + n]);
        self.out_start += n;
        Ok(n)
    }
}

/// A feed opened for parsing: gzip undone, transcoded to UTF-8, buffered.
pub type FeedReader<R> = BufReader<Utf8Reader<Decompress<R>>>;

/// Open a feed, gzipped or plain, in any encoding, as buffered UTF-8.
pub fn open_feed<R: BufRead>(input: R) -> anyhow::Result<FeedReader<R>> {
    let decompress = Decompress::new(input).context(PLAIN_READ_FAILURE)?;
    let read_failure = decompress.read_failure();
    let utf8 = Utf8Reader::new(decompress).context(read_failure)?;
    Ok(BufReader::with_capacity(BUF_LEN, utf8))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(bytes: &[u8]) -> (String, Utf8Reader<Decompress<&[u8]>>) {
        let mut reader = Utf8Reader::new(Decompress::new(bytes).unwrap()).unwrap();
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        (text, reader)
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn gzip_is_recognised_by_its_magic_number() {
        assert!(is_gzipped(&[0x1f, 0x8b, 0x08]));
        assert!(!is_gzipped(b"<?xml"));
        assert!(!is_gzipped(&[0x1f]));
        assert!(Decompress::new(&gzip(b"x")[..]).unwrap().is_gzip());
        assert!(!Decompress::new(&b"<tv/>"[..]).unwrap().is_gzip());
        assert!(!Decompress::new(&b""[..]).unwrap().is_gzip());
    }

    #[test]
    fn utf8_passes_through_unchanged() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><tv>Måndag</tv>";
        let (text, reader) = read_all(xml.as_bytes());
        assert_eq!(text, xml);
        assert_eq!(reader.replacements(), 0);
        assert_eq!(reader.declared_encoding(), Some("UTF-8"));
        assert_eq!(reader.encoding(), UTF_8);
    }

    #[test]
    fn a_declared_latin1_document_is_transcoded() {
        let mut xml = b"<?xml version='1.0' encoding='ISO-8859-1'?><tv>M".to_vec();
        xml.push(0xE5); // å in Latin-1
        xml.extend_from_slice(b"ndag</tv>");
        let (text, reader) = read_all(&xml);
        assert!(text.ends_with("<tv>Måndag</tv>"), "{text}");
        assert_eq!(reader.declared_encoding(), Some("ISO-8859-1"));
        assert_eq!(reader.replacements(), 0);
    }

    #[test]
    fn utf16_is_read_from_its_byte_order_mark_and_the_mark_is_dropped() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><tv>Måndag</tv>";
        for (bom, encode) in [
            ([0xFF, 0xFE], u16::to_le_bytes as fn(u16) -> [u8; 2]),
            ([0xFE, 0xFF], u16::to_be_bytes as fn(u16) -> [u8; 2]),
        ] {
            let mut bytes = bom.to_vec();
            bytes.extend(xml.encode_utf16().flat_map(encode));
            let (text, reader) = read_all(&bytes);
            assert_eq!(text, xml);
            assert_eq!(reader.declared_encoding(), Some("UTF-16"));
        }
    }

    #[test]
    fn a_utf8_byte_order_mark_is_dropped() {
        let (text, _) = read_all(b"\xEF\xBB\xBF<tv/>");
        assert_eq!(text, "<tv/>");
    }

    #[test]
    fn a_declared_utf16_without_a_byte_order_mark_is_read_as_utf8() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><tv>Måndag</tv>";
        let (text, reader) = read_all(xml.as_bytes());
        assert_eq!(text, xml);
        assert_eq!(reader.encoding(), UTF_8);
    }

    #[test]
    fn an_unknown_declared_encoding_is_read_as_utf8() {
        let xml = "<?xml version=\"1.0\" encoding=\"klingon\"?><tv>Å</tv>";
        let (text, reader) = read_all(xml.as_bytes());
        assert_eq!(text, xml);
        assert_eq!(reader.declared_encoding(), Some("klingon"));
    }

    #[test]
    fn malformed_bytes_become_replacement_characters_and_are_counted() {
        let (text, reader) = read_all(b"<tv>P\xE5ogram \xFF\xFE5</tv>");
        assert_eq!(text, "<tv>P\u{fffd}ogram \u{fffd}\u{fffd}5</tv>");
        assert_eq!(reader.replacements(), 3);
    }

    #[test]
    fn a_character_split_across_reads_is_kept_whole() {
        // 'å' straddles the 1 KB sniff and the next 64 KB read.
        let mut xml = vec![b'a'; SNIFF_LEN - 1];
        xml.extend_from_slice("å".as_bytes());
        xml.extend(std::iter::repeat_n(b'b', 3 * BUF_LEN));
        let (text, reader) = read_all(&xml);
        assert_eq!(text.as_bytes(), &xml[..]);
        assert_eq!(reader.replacements(), 0);
    }

    #[test]
    fn a_truncated_character_at_the_end_is_one_replacement() {
        let (text, reader) = read_all(b"<tv>\xC3");
        assert_eq!(text, "<tv>\u{fffd}");
        assert_eq!(reader.replacements(), 1);
    }

    #[test]
    fn gzip_and_transcoding_stack() {
        let mut xml = b"<?xml version=\"1.0\" encoding=\"windows-1252\"?><tv>".to_vec();
        xml.extend(std::iter::repeat_n(0xE5, 200_000));
        xml.extend_from_slice(b"</tv>");
        let mut text = String::new();
        open_feed(&gzip(&xml)[..])
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text.matches('å').count(), 200_000);
    }

    #[test]
    fn a_damaged_gzip_stream_fails_to_drain() {
        let gz = gzip(&vec![b'x'; 100_000]);
        let truncated = &gz[..gz.len() - 4];
        assert!(drain(Decompress::new(truncated).unwrap()).is_err());
        assert_eq!(drain(Decompress::new(&gz[..]).unwrap()).unwrap(), 100_000);
    }

    #[test]
    fn the_declaration_is_found_only_as_a_whole_attribute() {
        assert_eq!(
            declared_label("<?xml version=\"1.0\" encoding = 'latin1' ?>"),
            Some("latin1")
        );
        assert_eq!(declared_label("<?xml version=\"1.0\"?>"), None);
        assert_eq!(declared_label("<?xml xencoding=\"x\"?>"), None);
        assert_eq!(declared_label("<tv encoding=\"x\">"), None);
        assert_eq!(declared_label("<?xml encoding=\"x\""), None);
    }
}
