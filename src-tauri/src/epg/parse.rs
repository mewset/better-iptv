//! XMLTV pull parser that streams programmes and channels to a sink.
//!
//! Nothing is held for the whole feed: each `<programme>` goes to the sink as
//! soon as its end tag is read, with its times as written (`RawTime`). The
//! sink's owner applies the source's time policy, stages and normalises.
//!
//! Text is read leniently, because feeds come from many generators: CDATA,
//! comments inside a title, HTML entities and bare ampersands all keep the
//! programme. When the XML breaks off, what was read before the fault is kept
//! and `ParseReport::complete` is false.

use super::decode::{drain, open_feed};
use crate::epg_domain::key::channel_key;
use crate::epg_domain::report::ParseReport;
use crate::epg_domain::text::{collapse_whitespace, push_reference, unescape_lenient};
use crate::epg_domain::time::{offset_token, parse_raw_time, RawOffset, RawTime};
use anyhow::{Context, Result};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::io::BufRead;
use std::path::PathBuf;

/// `ParseReport::error` for a document that ends inside an open element.
const TRUNCATED_MESSAGE: &str = "The EPG ends before all its elements are closed";

/// One `<programme>` as the feed wrote it.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedProgramme {
    /// Position among the programmes handed to the sink, from 0.
    pub seq: u32,
    /// The `channel` attribute, entities resolved, not yet a key.
    pub channel: String,
    pub start: RawTime,
    /// `None` when the feed left it out or wrote something unreadable;
    /// normalisation infers it from the next programme.
    pub stop: Option<RawTime>,
    /// `(index, count)` from `clumpidx="0/2"`.
    pub clumpidx: Option<(u16, u16)>,
    pub title: String,
    pub description: Option<String>,
    pub category: Option<String>,
}

/// One `<channel>`: its id as written and its display names.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedChannel {
    pub id: String,
    pub display_names: Vec<String>,
}

/// Receives what the parser reads, in document order.
pub trait ParseSink {
    /// An error ends the parse and is returned from `parse_feed`.
    fn programme(&mut self, programme: ParsedProgramme) -> Result<()>;
    fn channel(&mut self, channel: ParsedChannel);
}

/// The child elements whose text is collected.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Title,
    Desc,
    Category,
    DisplayName,
}

impl Field {
    fn of(name: &str) -> Option<Self> {
        match name {
            "title" => Some(Self::Title),
            "desc" => Some(Self::Desc),
            "category" => Some(Self::Category),
            "display-name" => Some(Self::DisplayName),
            _ => None,
        }
    }
}

struct OpenProgramme {
    channel: String,
    start: RawTime,
    stop: Option<RawTime>,
    clumpidx: Option<(u16, u16)>,
    title: Option<String>,
    description: Option<String>,
    category: Option<String>,
}

impl OpenProgramme {
    /// The slot a field fills, or `None` when the field does not belong to
    /// a programme.
    fn slot(&mut self, field: Field) -> Option<&mut Option<String>> {
        match field {
            Field::Title => Some(&mut self.title),
            Field::Desc => Some(&mut self.description),
            Field::Category => Some(&mut self.category),
            Field::DisplayName => None,
        }
    }
}

/// The top-level element being read.
enum Element {
    Outside,
    Programme(OpenProgramme),
    /// A programme without a channel or a readable start: counted when its
    /// start tag was read, its children are ignored.
    SkippedProgramme,
    Channel(ParsedChannel),
}

struct Parser<'s, S: ParseSink> {
    sink: &'s mut S,
    report: ParseReport,
    element: Element,
    /// The field whose text is being collected, and the text so far.
    open: Option<Field>,
    text: String,
    next_seq: u32,
}

/// `clumpidx="index/count"`, with `index < count`.
fn parse_clumpidx(value: &str) -> Option<(u16, u16)> {
    let (index, count) = value.trim().split_once('/')?;
    let index: u16 = index.trim().parse().ok()?;
    let count: u16 = count.trim().parse().ok()?;
    (index < count).then_some((index, count))
}

impl<S: ParseSink> Parser<'_, S> {
    /// Read a time attribute, counting an unreadable zone.
    fn time(&mut self, value: &str) -> Option<RawTime> {
        let time = parse_raw_time(value).ok()?;
        if time.offset == RawOffset::Unknown {
            if let Some(token) = offset_token(value) {
                self.report.count_unknown_zone(token);
            }
        }
        Some(time)
    }

    fn start_programme(&mut self, e: &BytesStart) {
        self.report.programmes_seen = self.report.programmes_seen.saturating_add(1);
        let (mut channel, mut start, mut stop, mut clumpidx) = (None, None, None, None);
        for attr in e.attributes().flatten() {
            let value = unescape_lenient(&attr.value).into_owned();
            match attr.key.as_ref() {
                "channel" => channel = Some(value),
                "start" => start = Some(value),
                "stop" => stop = Some(value),
                "clumpidx" => clumpidx = Some(value),
                _ => {}
            }
        }

        let Some(channel) = channel.filter(|c| channel_key(c).is_some()) else {
            self.report.skipped_no_channel = self.report.skipped_no_channel.saturating_add(1);
            self.element = Element::SkippedProgramme;
            return;
        };
        let Some(start) = start.and_then(|s| self.time(&s)) else {
            self.report.skipped_bad_start = self.report.skipped_bad_start.saturating_add(1);
            self.element = Element::SkippedProgramme;
            return;
        };
        let stop = stop.and_then(|s| self.time(&s));
        self.element = Element::Programme(OpenProgramme {
            channel,
            start,
            stop,
            clumpidx: clumpidx.as_deref().and_then(parse_clumpidx),
            title: None,
            description: None,
            category: None,
        });
    }

    fn start_channel(&mut self, e: &BytesStart) {
        let id = e
            .attributes()
            .flatten()
            .find(|attr| attr.key.as_ref() == "id")
            .map(|attr| unescape_lenient(&attr.value).into_owned());
        if let Some(id) = id.filter(|id| channel_key(id).is_some()) {
            self.element = Element::Channel(ParsedChannel {
                id,
                display_names: Vec::new(),
            });
        }
    }

    /// Start collecting a field's text, unless it is not wanted here or an
    /// earlier field of the same kind already gave a value (the DTD calls
    /// the earlier one more canonical).
    fn open_field(&mut self, field: Field) {
        if self.open.is_some() {
            return;
        }
        let wanted = match &mut self.element {
            Element::Programme(p) => p.slot(field).is_some_and(|slot| slot.is_none()),
            Element::Channel(_) => field == Field::DisplayName,
            Element::Outside | Element::SkippedProgramme => false,
        };
        if wanted {
            self.open = Some(field);
            self.text.clear();
        }
    }

    fn close_field(&mut self) {
        let Some(field) = self.open.take() else {
            return;
        };
        let value = collapse_whitespace(&self.text);
        if value.is_empty() {
            return;
        }
        match &mut self.element {
            Element::Programme(p) => {
                if let Some(slot) = p.slot(field) {
                    slot.get_or_insert_with(|| value.into_owned());
                }
            }
            Element::Channel(c) => {
                if !c.display_names.iter().any(|n| *n == value) {
                    c.display_names.push(value.into_owned());
                }
            }
            Element::Outside | Element::SkippedProgramme => {}
        }
    }

    fn end_programme(&mut self) -> Result<()> {
        self.open = None;
        let Element::Programme(p) = std::mem::replace(&mut self.element, Element::Outside) else {
            return Ok(());
        };
        let Some(title) = p.title else {
            self.report.skipped_no_title = self.report.skipped_no_title.saturating_add(1);
            return Ok(());
        };
        let seq = self.next_seq;
        self.next_seq = seq
            .checked_add(1)
            .context("The EPG has more programmes than can be counted")?;
        self.sink.programme(ParsedProgramme {
            seq,
            channel: p.channel,
            start: p.start,
            stop: p.stop,
            clumpidx: p.clumpidx,
            title,
            description: p.description,
            category: p.category,
        })
    }

    fn end_channel(&mut self) {
        self.open = None;
        if let Element::Channel(c) = std::mem::replace(&mut self.element, Element::Outside) {
            self.sink.channel(c);
        }
    }

    fn start(&mut self, e: &BytesStart) {
        match e.name().as_ref() {
            "programme" if matches!(self.element, Element::Outside) => self.start_programme(e),
            "channel" if matches!(self.element, Element::Outside) => self.start_channel(e),
            name => {
                if let Some(field) = Field::of(name) {
                    self.open_field(field);
                }
            }
        }
    }

    fn end(&mut self, name: &str) -> Result<()> {
        match name {
            "programme"
                if matches!(
                    self.element,
                    Element::Programme(_) | Element::SkippedProgramme
                ) =>
            {
                self.end_programme()
            }
            "channel" if matches!(self.element, Element::Channel(_)) => {
                self.end_channel();
                Ok(())
            }
            name => {
                if self.open.is_some() && self.open == Field::of(name) {
                    self.close_field();
                }
                Ok(())
            }
        }
    }
}

/// Parse a feed, gzipped or plain, in any declared encoding, handing every
/// programme and channel to `sink`.
///
/// Returns an error only when the feed cannot be read at all (a damaged
/// gzip stream fails as a whole, even when the XML breaks off first) or when
/// the sink fails. Malformed XML ends the parse with `complete == false` and
/// keeps everything before the fault.
pub fn parse_feed<R: BufRead>(input: R, sink: &mut impl ParseSink) -> Result<ParseReport> {
    let feed = open_feed(input)?;
    let utf8 = feed.get_ref();
    let read_failure = utf8.get_ref().read_failure();
    let report = ParseReport {
        declared_encoding: utf8.declared_encoding().map(str::to_owned),
        ..ParseReport::default()
    };

    let mut reader = Reader::from_reader(feed);
    let config = reader.config_mut();
    config.trim_text(false);
    config.allow_dangling_amp = true;

    let mut parser = Parser {
        sink,
        report,
        element: Element::Outside,
        open: None,
        text: String::new(),
        next_seq: 0,
    };
    let mut buf = Vec::with_capacity(1024);
    // quick-xml reports the end of input inside an open element as a plain
    // `Eof`, so a feed cut off between tags is caught by counting.
    let mut depth: u32 = 0;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                depth = depth.saturating_add(1);
                parser.start(&e);
            }
            Ok(Event::Empty(e)) => {
                parser.start(&e);
                parser.end(e.name().as_ref())?;
            }
            Ok(Event::End(e)) => {
                depth = depth.saturating_sub(1);
                parser.end(e.name().as_ref())?;
            }
            Ok(Event::Text(e)) if parser.open.is_some() => {
                parser.text.push_str(&e.xml10_content());
            }
            Ok(Event::CData(e)) if parser.open.is_some() => {
                parser.text.push_str(&e.xml10_content());
            }
            Ok(Event::GeneralRef(e)) if parser.open.is_some() => {
                push_reference(&mut parser.text, &e);
            }
            Ok(Event::Eof) => {
                parser.report.complete = depth == 0;
                if depth > 0 {
                    parser.report.error = Some(TRUNCATED_MESSAGE.to_string());
                }
                parser.report.decode_replacements = reader.get_ref().get_ref().replacements();
                break;
            }
            // Comments and processing instructions leave an open field open.
            Ok(_) => {}
            Err(quick_xml::Error::Io(e)) => anyhow::bail!("{read_failure}: {e}"),
            Err(e) => {
                parser.report.error = Some(e.to_string());
                let utf8 = reader.into_inner().into_inner();
                parser.report.decode_replacements = utf8.replacements();
                drain(utf8.into_inner()).context(read_failure)?;
                break;
            }
        }
        buf.clear();
    }
    Ok(parser.report)
}

/// Parse a feed file on the blocking pool: a large feed takes over a second
/// of CPU, which would otherwise stall a tokio worker and every task queued
/// on it. Returns the sink with the report.
pub async fn parse_file_off_runtime<S>(path: PathBuf, mut sink: S) -> Result<(S, ParseReport)>
where
    S: ParseSink + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&path).context("Failed to open the downloaded EPG")?;
        let report = parse_feed(std::io::BufReader::new(file), &mut sink)?;
        Ok((sink, report))
    })
    .await
    .context("EPG parse task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[derive(Default)]
    struct Collect {
        programmes: Vec<ParsedProgramme>,
        channels: Vec<ParsedChannel>,
    }

    impl ParseSink for Collect {
        fn programme(&mut self, programme: ParsedProgramme) -> Result<()> {
            self.programmes.push(programme);
            Ok(())
        }
        fn channel(&mut self, channel: ParsedChannel) {
            self.channels.push(channel);
        }
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// Parse `bytes` plain and gzipped, check both agree, return one.
    fn parse(bytes: &[u8]) -> (Collect, ParseReport) {
        let mut plain = Collect::default();
        let plain_report = parse_feed(bytes, &mut plain).unwrap();
        let mut gzipped = Collect::default();
        let gzipped_report = parse_feed(&gzip(bytes)[..], &mut gzipped).unwrap();
        assert_eq!(plain.programmes, gzipped.programmes);
        assert_eq!(plain.channels, gzipped.channels);
        assert_eq!(plain_report, gzipped_report);
        (plain, plain_report)
    }

    /// A feed with one programme whose children are `inner`.
    fn one(inner: &str) -> ParsedProgramme {
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\
             <programme start=\"20261021200000 +0200\" stop=\"20261021210000 +0200\" channel=\"svt1.se\">\
             {inner}</programme></tv>"
        );
        let (collected, report) = parse(xml.as_bytes());
        assert!(report.complete);
        assert_eq!(collected.programmes.len(), 1, "{xml}");
        collected.programmes.into_iter().next().unwrap()
    }

    fn title(inner: &str) -> String {
        one(inner).title
    }

    fn feed(programmes: usize) -> Vec<u8> {
        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n");
        for i in 0..programmes {
            xml += &format!(
                "<programme start=\"20261010{h:02}0000 +0200\" stop=\"20261010{h:02}5900 +0200\" channel=\"kanal{c}.se\">\
                 <title>Program {i}</title><desc>Avsnitt {i} med å, ä och ö</desc><category>Nyheter</category></programme>\n",
                h = i % 24,
                c = i % 40
            );
        }
        xml += "</tv>\n";
        xml.into_bytes()
    }

    #[test]
    fn a_programme_reaches_the_sink_with_its_times_as_written() {
        let p = one("<title>Rapport</title><desc>Nyheter</desc><category>News</category>");
        let wall = NaiveDate::from_ymd_opt(2026, 10, 21)
            .unwrap()
            .and_hms_opt(20, 0, 0)
            .unwrap();
        assert_eq!(p.seq, 0);
        assert_eq!(p.channel, "svt1.se");
        assert_eq!(
            p.start,
            RawTime {
                wall,
                offset: RawOffset::Explicit(120)
            }
        );
        assert_eq!(
            p.stop.map(|t| t.wall),
            Some(wall + chrono::Duration::hours(1))
        );
        assert_eq!(p.title, "Rapport");
        assert_eq!(p.description.as_deref(), Some("Nyheter"));
        assert_eq!(p.category.as_deref(), Some("News"));
        assert_eq!(p.clumpidx, None);
    }

    #[test]
    fn a_cdata_title_is_read() {
        assert_eq!(
            title("<title><![CDATA[Tom & Jerry]]></title>"),
            "Tom & Jerry"
        );
    }

    #[test]
    fn cdata_and_text_are_joined() {
        assert_eq!(
            title("<title>Tom <![CDATA[& <Jerry>]]> show</title>"),
            "Tom & <Jerry> show"
        );
    }

    #[test]
    fn cdata_content_is_not_unescaped() {
        assert_eq!(title("<title><![CDATA[A &amp; B]]></title>"), "A &amp; B");
    }

    #[test]
    fn a_comment_inside_a_title_does_not_end_it() {
        assert_eq!(title("<title>Tom<!-- x --> Jerry</title>"), "Tom Jerry");
        assert_eq!(title("<title>Tom <?pi x?>Jerry</title>"), "Tom Jerry");
    }

    #[test]
    fn the_first_title_desc_and_category_win() {
        let p = one(
            "<title lang=\"sv\">Första</title><title lang=\"en\">First</title><title>Third</title>\
             <desc>Ett</desc><desc>One</desc><category>Nyheter</category><category>News</category>",
        );
        assert_eq!(p.title, "Första");
        assert_eq!(p.description.as_deref(), Some("Ett"));
        assert_eq!(p.category.as_deref(), Some("Nyheter"));
    }

    #[test]
    fn an_empty_first_title_gives_way_to_the_next() {
        assert_eq!(title("<title> </title><title>Rapport</title>"), "Rapport");
    }

    #[test]
    fn whitespace_in_text_is_collapsed() {
        assert_eq!(title("<title>\n   Tom\n\t  Jerry \n</title>"), "Tom Jerry");
    }

    #[test]
    fn entities_in_the_channel_attribute_are_resolved() {
        let xml = "<tv><programme start=\"20261021200000 +0000\" channel=\"A&amp;E.us\">\
                   <title>x</title></programme></tv>";
        let (collected, _) = parse(xml.as_bytes());
        assert_eq!(collected.programmes[0].channel, "A&E.us");
    }

    #[test]
    fn bare_ampersands_parse() {
        let xml = "<tv><programme start=\"20261021200000 +0000\" channel=\"A&E.us\">\
                   <title>Tom & Jerry &amp; friends</title></programme></tv>";
        let (collected, report) = parse(xml.as_bytes());
        assert!(report.complete, "{:?}", report.error);
        assert_eq!(collected.programmes[0].channel, "A&E.us");
        assert_eq!(collected.programmes[0].title, "Tom & Jerry & friends");
    }

    #[test]
    fn html_entities_are_kept_as_their_characters() {
        assert_eq!(
            title("<title>Tom&nbsp;Jerry &eacute; &foo; &#229;</title>"),
            "Tom\u{a0}Jerry é &foo; å"
        );
    }

    #[test]
    fn a_declared_latin1_feed_is_read() {
        let mut xml = b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><tv>\
                        <programme start=\"20261021200000 +0000\" channel=\"svt1.se\"><title>M"
            .to_vec();
        xml.push(0xE5);
        xml.extend_from_slice(b"ndag</title></programme></tv>");
        let (collected, report) = parse(&xml);
        assert_eq!(collected.programmes[0].title, "Måndag");
        assert_eq!(report.declared_encoding.as_deref(), Some("ISO-8859-1"));
        assert_eq!(report.decode_replacements, 0);
    }

    #[test]
    fn a_utf16_le_feed_with_a_byte_order_mark_is_read() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><tv>\
                   <programme start=\"20261021200000 +0000\" channel=\"svt1.se\">\
                   <title>Måndag</title></programme></tv>";
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
        let (collected, report) = parse(&bytes);
        assert!(report.complete);
        assert_eq!(collected.programmes[0].title, "Måndag");
    }

    #[test]
    fn one_invalid_byte_becomes_a_replacement_and_keeps_the_programme() {
        let mut xml = feed(100);
        let at = xml.windows(9).position(|w| w == b"Program 5").unwrap();
        xml[at + 1] = 0xE5; // a Latin-1 byte inside a UTF-8 feed

        let (collected, report) = parse(&xml);
        assert!(report.complete);
        assert_eq!(collected.programmes.len(), 100);
        assert_eq!(collected.programmes[5].title, "P\u{fffd}ogram 5");
        assert_eq!(report.decode_replacements, 1);
    }

    #[test]
    fn a_missing_stop_reaches_the_sink_as_none() {
        let xml = "<tv><programme start=\"20261021200000 +0000\" channel=\"svt1.se\">\
                   <title>x</title></programme>\
                   <programme start=\"20261021210000 +0000\" stop=\"bad\" channel=\"svt1.se\">\
                   <title>y</title></programme></tv>";
        let (collected, _) = parse(xml.as_bytes());
        assert_eq!(collected.programmes.len(), 2);
        assert!(collected.programmes.iter().all(|p| p.stop.is_none()));
    }

    #[test]
    fn programmes_without_channel_start_or_title_are_counted_and_skipped() {
        let xml = "<tv>\
            <programme start=\"20261021200000 +0000\"><title>no channel</title></programme>\
            <programme start=\"20261021200000 +0000\" channel=\"  \"><title>blank</title></programme>\
            <programme channel=\"svt1.se\"><title>no start</title></programme>\
            <programme start=\"202610212\" channel=\"svt1.se\"><title>odd start</title></programme>\
            <programme start=\"20261021200000 +0000\" channel=\"svt1.se\"><title> </title></programme>\
            <programme start=\"20261021200000 +0000\" channel=\"svt1.se\"/>\
            <programme start=\"20261021200000 +0000\" channel=\"svt1.se\"><title>kept</title></programme>\
            </tv>";
        let (collected, report) = parse(xml.as_bytes());
        assert_eq!(report.programmes_seen, 7);
        assert_eq!(report.skipped_no_channel, 2);
        assert_eq!(report.skipped_bad_start, 2);
        assert_eq!(report.skipped_no_title, 2);
        let titles: Vec<_> = collected.programmes.iter().map(|p| &p.title).collect();
        assert_eq!(titles, ["kept"]);
        assert_eq!(collected.programmes[0].seq, 0, "seq counts kept programmes");
    }

    #[test]
    fn unknown_zones_are_counted_with_a_sample() {
        let xml = "<tv><programme start=\"20261021200000 CEST\" stop=\"20261021210000 CEST\" \
                   channel=\"svt1.se\"><title>x</title></programme></tv>";
        let (collected, report) = parse(xml.as_bytes());
        assert_eq!(collected.programmes[0].start.offset, RawOffset::Unknown);
        assert_eq!(report.unknown_zone_count, 2);
        assert_eq!(report.unknown_zone_sample.as_deref(), Some("CEST"));
    }

    #[test]
    fn clumpidx_is_read() {
        let xml = "<tv>\
            <programme start=\"20261021200000\" channel=\"a\" clumpidx=\"1/2\"><title>x</title></programme>\
            <programme start=\"20261021200000\" channel=\"a\" clumpidx=\"2/2\"><title>y</title></programme>\
            </tv>";
        let (collected, _) = parse(xml.as_bytes());
        assert_eq!(collected.programmes[0].clumpidx, Some((1, 2)));
        assert_eq!(collected.programmes[1].clumpidx, None);
        assert_eq!(collected.programmes[1].seq, 1);
    }

    #[test]
    fn truncated_xml_keeps_what_was_read_and_is_not_complete() {
        let xml = feed(1000);
        let between_tags = xml
            .windows(13)
            .position(|w| w == b"</programme>\n")
            .unwrap()
            + 13;
        // Inside text, inside a tag, and cleanly between two programmes.
        for cut in [xml.len() / 2, xml.len() / 3 + 7, between_tags] {
            let (collected, report) = parse(&xml[..cut]);
            assert!(!report.complete, "cut at {cut}");
            assert!(report.error.is_some());
            let n = collected.programmes.len();
            assert!(n > 0 && n < 1000, "got {n}");
        }
    }

    #[test]
    fn malformed_xml_keeps_the_programmes_before_the_fault() {
        let mut xml = feed(1000);
        let cut = xml.len() / 2;
        xml.splice(cut..cut, b"</oops>".iter().copied());
        let (collected, report) = parse(&xml);
        assert!(!report.complete);
        let n = collected.programmes.len();
        assert!(n > 0 && n < 1000, "got {n}");
    }

    #[test]
    fn a_damaged_gzip_feed_fails_as_a_whole() {
        let gz = gzip(&feed(2000));
        let truncated = &gz[..gz.len() / 2];
        let mut flipped = gz.clone();
        let middle = flipped.len() / 2;
        flipped[middle] ^= 0xff;

        assert!(parse_feed(truncated, &mut Collect::default()).is_err());
        assert!(parse_feed(&flipped[..], &mut Collect::default()).is_err());
        // Malformed XML inside a gzip that is cut short: the drain finds it.
        let mut xml = feed(2000);
        xml.splice(100..100, b"</oops>".iter().copied());
        let gz = gzip(&xml);
        assert!(parse_feed(&gz[..gz.len() - 8], &mut Collect::default()).is_err());
    }

    #[test]
    fn channels_and_display_names_reach_the_sink() {
        let xml = "<tv>\
            <channel id=\"SVT1.se\"><display-name lang=\"sv\">SVT1</display-name>\
              <display-name>SVT 1 &amp; HD</display-name><display-name>SVT1</display-name>\
              <display-name> </display-name><icon src=\"x\"/></channel>\
            <channel id=\"tv4.se\"/>\
            <channel><display-name>no id</display-name></channel>\
            <programme start=\"20261021200000\" channel=\"SVT1.se\"><title>x</title></programme>\
            </tv>";
        let (collected, _) = parse(xml.as_bytes());
        assert_eq!(
            collected.channels,
            [
                ParsedChannel {
                    id: "SVT1.se".into(),
                    display_names: vec!["SVT1".into(), "SVT 1 & HD".into()],
                },
                ParsedChannel {
                    id: "tv4.se".into(),
                    display_names: vec![],
                },
            ]
        );
        assert_eq!(collected.programmes.len(), 1);
    }

    #[test]
    fn a_failing_sink_ends_the_parse_with_its_error() {
        struct Fail;
        impl ParseSink for Fail {
            fn programme(&mut self, _: ParsedProgramme) -> Result<()> {
                anyhow::bail!("disk full")
            }
            fn channel(&mut self, _: ParsedChannel) {}
        }
        let err = parse_feed(&feed(3)[..], &mut Fail).unwrap_err();
        assert_eq!(err.to_string(), "disk full");
    }

    #[test]
    fn an_empty_feed_parses_to_nothing() {
        let (collected, report) = parse(b"");
        assert!(collected.programmes.is_empty());
        assert!(report.complete);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn parsing_leaves_the_runtime_free_for_other_tasks() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("bitv-parse-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("feed.gz");
        std::fs::write(&path, gzip(&feed(20_000))).unwrap();

        // On a current-thread runtime a sibling task only runs while the
        // parse future is pending. A parse on the runtime thread never
        // yields, so the ticker would stay at zero.
        let ticks = Arc::new(AtomicUsize::new(0));
        let counter = ticks.clone();
        let ticker = tokio::spawn(async move {
            loop {
                counter.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        });
        tokio::task::yield_now().await;
        let before = ticks.load(Ordering::Relaxed);

        let result = parse_file_off_runtime(path, Collect::default()).await;

        let during = ticks.load(Ordering::Relaxed) - before;
        ticker.abort();
        std::fs::remove_dir_all(&dir).unwrap();
        let (collected, report) = result.unwrap();
        assert!(report.complete);
        assert_eq!(collected.programmes.len(), 20_000);
        assert!(
            during > 0,
            "the runtime thread was blocked for the whole parse"
        );
    }

    /// Reads the feed captured for the rewrite (see the EPG rewrite brief):
    /// `EPG_REAL_FEED=/path/to/xmltv.xml cargo test --lib real_feed -- --ignored`.
    /// It holds provider data, so it never enters the repository and nothing
    /// from it is printed but counts.
    #[test]
    #[ignore]
    fn the_captured_real_feed_parses_completely() {
        let Some(path) = std::env::var_os("EPG_REAL_FEED") else {
            eprintln!("EPG_REAL_FEED is not set; skipped");
            return;
        };
        let file = std::fs::File::open(path).unwrap();
        let mut collected = Collect::default();
        let report = parse_feed(std::io::BufReader::new(file), &mut collected).unwrap();

        let ids: std::collections::HashSet<&str> =
            collected.channels.iter().map(|c| c.id.as_str()).collect();
        let without_stop = collected
            .programmes
            .iter()
            .filter(|p| p.stop.is_none())
            .count();
        eprintln!(
            "programmes {} (seen {}), channels {}, distinct ids {}, without stop {}, \
             replacements {}, declared {:?}, unknown zones {}",
            collected.programmes.len(),
            report.programmes_seen,
            collected.channels.len(),
            ids.len(),
            without_stop,
            report.decode_replacements,
            report.declared_encoding,
            report.unknown_zone_count,
        );
        assert!(report.complete, "{:?}", report.error);
        assert_eq!(collected.programmes.len(), 42_182);
        assert_eq!(report.programmes_seen, 42_182);
        assert_eq!(collected.channels.len(), 2_727);
        assert!(collected
            .channels
            .iter()
            .all(|c| !c.display_names.is_empty()));
        assert_eq!(ids.len(), 2_055);
        assert_eq!(without_stop, 0);
        assert_eq!(report.decode_replacements, 0);
        assert_eq!(report.unknown_zone_count, 0);
    }
}
