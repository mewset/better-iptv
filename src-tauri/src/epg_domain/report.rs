//! Counters an ingest collects, for the log line and the source's status.
//!
//! `IngestReport` itself is defined with the ingest in `epg/`, because it
//! carries the ingest scope, which belongs to the infrastructure layer. The
//! pure parts it is made of live here.

use std::time::Duration;

/// Longest unknown zone token kept as a sample, in characters.
const ZONE_SAMPLE_MAX_CHARS: usize = 32;

/// What reading one feed found, before normalisation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParseReport {
    /// The whole document was read; `false` when the XML broke off and only
    /// the programmes before the break were kept.
    pub complete: bool,
    /// Why the read stopped early, credential-free.
    pub error: Option<String>,
    pub programmes_seen: u32,
    pub skipped_no_channel: u32,
    pub skipped_no_title: u32,
    pub skipped_bad_start: u32,
    /// Times whose zone could not be read and were taken as UTC.
    pub unknown_zone_count: u32,
    /// The first such zone token, for the status tooltip and the log.
    pub unknown_zone_sample: Option<String>,
    /// Bytes the decoder replaced with U+FFFD.
    pub decode_replacements: u64,
    /// The encoding the document declared, if it declared one.
    pub declared_encoding: Option<String>,
}

impl ParseReport {
    /// Count a time whose zone token could not be read, keeping the first
    /// token seen (cut to a few characters) as a sample.
    pub fn count_unknown_zone(&mut self, token: &str) {
        self.unknown_zone_count = self.unknown_zone_count.saturating_add(1);
        if self.unknown_zone_sample.is_none() {
            self.unknown_zone_sample = Some(token.chars().take(ZONE_SAMPLE_MAX_CHARS).collect());
        }
    }
}

/// What `normalise` changed or dropped.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NormaliseReport {
    pub duplicate_starts_dropped: u32,
    pub stops_inferred: u32,
    pub last_without_stop_dropped: u32,
    pub consecutive_overlaps_trimmed: u32,
    pub nested_kept: u32,
    pub invalid_span_dropped: u32,
    pub ended_before_cutoff_dropped: u32,
    /// Programmes whose start fell in a gap of the local zone and that
    /// collapsed onto the transition instant.
    pub gap_collapsed: u32,
}

/// Wall time spent in each stage of one ingest.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StageTimes {
    /// Network body to the download file; zero for a cache re-ingest.
    pub download: Duration,
    /// Decode, parse and staging, which run as one stream.
    pub parse: Duration,
    pub normalise: Duration,
    /// Verdict marks plus the swap transaction.
    pub store: Duration,
}

impl StageTimes {
    pub fn total(&self) -> Duration {
        self.download + self.parse + self.normalise + self.store
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_zones_are_counted_and_the_first_is_sampled() {
        let mut report = ParseReport::default();
        report.count_unknown_zone("CEST");
        report.count_unknown_zone("EET");
        assert_eq!(report.unknown_zone_count, 2);
        assert_eq!(report.unknown_zone_sample.as_deref(), Some("CEST"));
    }

    #[test]
    fn an_unreadable_zone_is_unknown_and_its_token_becomes_the_sample() {
        use crate::epg_domain::time::{offset_token, parse_raw_time, RawOffset};

        let value = "20261020140000 CEST";
        let mut report = ParseReport::default();
        if parse_raw_time(value).unwrap().offset == RawOffset::Unknown {
            report.count_unknown_zone(offset_token(value).unwrap());
        }
        assert_eq!(report.unknown_zone_count, 1);
        assert_eq!(report.unknown_zone_sample.as_deref(), Some("CEST"));
    }

    #[test]
    fn a_long_zone_sample_is_cut() {
        let mut report = ParseReport::default();
        report.count_unknown_zone(&"Ä".repeat(100));
        assert_eq!(
            report.unknown_zone_sample.map(|s| s.chars().count()),
            Some(ZONE_SAMPLE_MAX_CHARS)
        );
    }

    #[test]
    fn stage_times_add_up() {
        let times = StageTimes {
            download: Duration::from_millis(5),
            parse: Duration::from_millis(7),
            normalise: Duration::from_millis(1),
            store: Duration::from_millis(3),
        };
        assert_eq!(times.total(), Duration::from_millis(16));
    }
}
