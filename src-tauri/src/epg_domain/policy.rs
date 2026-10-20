//! Time correction: how a source's raw times become UTC instants.
//!
//! Applied once while a feed is parsed, so stored programmes are final UTC and
//! no read has to do arithmetic. Changing a source's policy re-parses its
//! cached feed instead of shifting stored rows.

use super::time::{RawOffset, RawTime};
use crate::error::AppError;
use chrono::{DateTime, MappedLocalTime, NaiveDateTime, Offset, TimeZone};
use serde::{Deserialize, Serialize};

/// Which zone the wall-clock part of a feed's times is read in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Interpret {
    /// Trust the offset the feed wrote; no offset means UTC, as the DTD says.
    AsWritten,
    /// Read the wall clock as this computer's local time and ignore the
    /// stated offset, for feeds that label local times with a wrong zone.
    LocalZone,
}

impl Interpret {
    /// The value stored in `epg_source.time_interpret`.
    pub fn as_str(self) -> &'static str {
        match self {
            Interpret::AsWritten => "as_written",
            Interpret::LocalZone => "local_zone",
        }
    }

    /// Read a stored value; `None` for one this version does not know.
    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "as_written" => Some(Interpret::AsWritten),
            "local_zone" => Some(Interpret::LocalZone),
            _ => None,
        }
    }
}

/// Steps the shift moves in, in minutes.
pub const SHIFT_STEP_MINUTES: i32 = 30;
/// Smallest allowed shift: twelve hours back.
pub const MIN_SHIFT_MINUTES: i32 = -12 * 60;
/// Largest allowed shift: fourteen hours ahead, the widest zone offset in use.
pub const MAX_SHIFT_MINUTES: i32 = 14 * 60;

/// A source's time correction: how to read its times, then how far to move them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimePolicy {
    pub interpret: Interpret,
    pub shift_minutes: i32,
}

impl Default for TimePolicy {
    fn default() -> Self {
        TimePolicy {
            interpret: Interpret::AsWritten,
            shift_minutes: 0,
        }
    }
}

/// A resolved time and whether its wall clock fell in a gap of the local zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resolved {
    /// Unix seconds, UTC.
    pub at: i64,
    /// The wall clock does not exist in the local zone (spring forward) and
    /// was mapped to the transition instant. Only `LocalZone` sets this.
    pub in_gap: bool,
}

impl TimePolicy {
    /// Reject a shift outside -12 h..=+14 h or off the 30-minute grid.
    pub fn validate(&self) -> Result<(), AppError> {
        if !(MIN_SHIFT_MINUTES..=MAX_SHIFT_MINUTES).contains(&self.shift_minutes) {
            return Err(AppError::InvalidInput(format!(
                "Time shift must be between {} and {} minutes",
                MIN_SHIFT_MINUTES, MAX_SHIFT_MINUTES
            )));
        }
        if self.shift_minutes % SHIFT_STEP_MINUTES != 0 {
            return Err(AppError::InvalidInput(format!(
                "Time shift must be a multiple of {} minutes",
                SHIFT_STEP_MINUTES
            )));
        }
        Ok(())
    }

    /// The UTC instant, in Unix seconds, a raw time stands for under this policy.
    ///
    /// `local` is the zone `LocalZone` reads in: production passes
    /// `&chrono::Local`, tests a fixed or hand-written zone.
    pub fn resolve<Tz: TimeZone>(&self, raw: &RawTime, local: &Tz) -> i64 {
        self.resolve_detailed(raw, local).at
    }

    /// `resolve`, plus whether the wall clock fell in a gap of the local zone.
    ///
    /// `AsWritten`: an explicit offset is subtracted; a missing or unknown one
    /// means UTC. `LocalZone`: the wall clock is mapped in `local` and the
    /// stated offset is ignored, except in a fold (the repeated hour when
    /// clocks go back), where an offset equal to one of the two candidates
    /// picks that occurrence; otherwise the earlier one. A wall clock inside
    /// a gap maps to the transition instant, so the sequence stays in order
    /// and the programmes there collapse and are dropped by `normalise`.
    /// The shift is added last.
    pub fn resolve_detailed<Tz: TimeZone>(&self, raw: &RawTime, local: &Tz) -> Resolved {
        let (at, in_gap) = match self.interpret {
            Interpret::AsWritten => {
                let wall = raw.wall.and_utc().timestamp();
                match raw.offset {
                    RawOffset::Explicit(minutes) => (wall - i64::from(minutes) * 60, false),
                    RawOffset::Missing | RawOffset::Unknown => (wall, false),
                }
            }
            Interpret::LocalZone => map_local(&raw.wall, raw.offset, local),
        };
        Resolved {
            at: at + i64::from(self.shift_minutes) * 60,
            in_gap,
        }
    }
}

fn map_local<Tz: TimeZone>(wall: &NaiveDateTime, stated: RawOffset, local: &Tz) -> (i64, bool) {
    match local.from_local_datetime(wall) {
        MappedLocalTime::Single(at) => (at.timestamp(), false),
        MappedLocalTime::Ambiguous(earliest, latest) => {
            let latest_offset = latest.offset().fix().local_minus_utc();
            match stated {
                RawOffset::Explicit(minutes) if minutes * 60 == latest_offset => {
                    (latest.timestamp(), false)
                }
                _ => (earliest.timestamp(), false),
            }
        }
        MappedLocalTime::None => (gap_transition(wall, local), true),
    }
}

/// Offset of `local` at Unix second `at`, in seconds east of UTC.
fn offset_at<Tz: TimeZone>(local: &Tz, at: i64) -> Option<i64> {
    let utc = DateTime::from_timestamp(at, 0)?.naive_utc();
    Some(i64::from(
        local.offset_from_utc_datetime(&utc).fix().local_minus_utc(),
    ))
}

/// The instant the gap containing `wall` ends, found by bisection.
///
/// The offset grows from `before` to `after` at the transition `T`, and
/// `wall` lies in `[T + before, T + after)`, so `T` is the first instant whose
/// local reading passes `wall`, and it lies in `[wall - after, wall - before]`.
/// A zone that does not have that shape around `wall` gets `wall - before`.
fn gap_transition<Tz: TimeZone>(wall: &NaiveDateTime, local: &Tz) -> i64 {
    const DAY: i64 = 24 * 3600;
    let w = wall.and_utc().timestamp();
    let local_reading = |at: i64| offset_at(local, at).map(|offset| at + offset);
    let (Some(before), Some(after)) = (offset_at(local, w - DAY), offset_at(local, w + DAY)) else {
        return w;
    };
    if after <= before {
        return w - before;
    }
    let (mut lo, mut hi) = (w - after, w - before);
    match (local_reading(lo), local_reading(hi)) {
        (Some(lo_reading), _) if lo_reading > w => return lo,
        (Some(_), Some(hi_reading)) if hi_reading > w => {}
        _ => return w - before,
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        match local_reading(mid) {
            Some(reading) if reading > w => hi = mid,
            Some(_) => lo = mid,
            None => return w - before,
        }
    }
    hi
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg_domain::normalize::{normalise, DropReason, Slot, Verdict};
    use crate::epg_domain::time::parse_raw_time;
    use chrono::{FixedOffset, NaiveDate, Utc};

    /// Central European time with its 2026 transitions at fixed instants:
    /// CET (+1) until 2026-03-29 01:00Z, CEST (+2) until 2026-10-25 01:00Z,
    /// CET after. Independent of the machine's zone.
    #[derive(Clone, Copy, Debug)]
    struct TestZone;

    const SPRING: i64 = 1_774_746_000; // 2026-03-29T01:00:00Z
    const FALL: i64 = 1_792_890_000; // 2026-10-25T01:00:00Z

    impl TestZone {
        fn offset_secs(at: i64) -> i32 {
            if (SPRING..FALL).contains(&at) {
                7200
            } else {
                3600
            }
        }
    }

    fn fixed(secs: i32) -> FixedOffset {
        FixedOffset::east_opt(secs).unwrap()
    }

    impl TimeZone for TestZone {
        type Offset = FixedOffset;

        fn from_offset(_: &FixedOffset) -> Self {
            TestZone
        }

        fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(0, 0, 0).unwrap())
        }

        fn offset_from_local_datetime(
            &self,
            local: &NaiveDateTime,
        ) -> MappedLocalTime<FixedOffset> {
            let wall = local.and_utc().timestamp();
            // Larger offset first: it gives the earlier instant.
            let found: Vec<i32> = [7200, 3600]
                .into_iter()
                .filter(|offset| Self::offset_secs(wall - i64::from(*offset)) == *offset)
                .collect();
            match found.as_slice() {
                [] => MappedLocalTime::None,
                [one] => MappedLocalTime::Single(fixed(*one)),
                [earliest, latest] => MappedLocalTime::Ambiguous(fixed(*earliest), fixed(*latest)),
                _ => unreachable!(),
            }
        }

        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(0, 0, 0).unwrap())
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            fixed(Self::offset_secs(utc.and_utc().timestamp()))
        }
    }

    fn raw(value: &str) -> RawTime {
        parse_raw_time(value).unwrap()
    }

    fn rfc(at: i64) -> String {
        DateTime::from_timestamp(at, 0).unwrap().to_rfc3339()
    }

    fn as_written(shift_minutes: i32) -> TimePolicy {
        TimePolicy {
            interpret: Interpret::AsWritten,
            shift_minutes,
        }
    }

    fn local_zone(shift_minutes: i32) -> TimePolicy {
        TimePolicy {
            interpret: Interpret::LocalZone,
            shift_minutes,
        }
    }

    /// The old parser's conversion, now `AsWritten` with no shift.
    fn utc(value: &str) -> Option<String> {
        parse_raw_time(value)
            .ok()
            .map(|r| rfc(TimePolicy::default().resolve(&r, &Utc)))
    }

    #[test]
    fn the_offset_is_read_with_or_without_a_space_before_it() {
        let expected = Some("2026-10-20T12:00:00+00:00".to_string());
        assert_eq!(utc("20261020140000 +0200"), expected);
        assert_eq!(utc("20261020140000+0200"), expected);
        assert_eq!(utc("20261020140000  +0200"), expected);
        assert_eq!(utc("20261020140000 +02:00"), expected);
        assert_eq!(utc("20261020100000 -0200"), expected);
        assert_eq!(utc("20261020140000 +0200 CEST"), expected);
    }

    #[test]
    fn a_time_without_an_offset_is_utc() {
        assert_eq!(
            utc("20261020140000"),
            Some("2026-10-20T14:00:00+00:00".to_string())
        );
    }

    #[test]
    fn an_unreadable_offset_falls_back_to_utc() {
        assert_eq!(
            utc("20261020140000 CEST"),
            Some("2026-10-20T14:00:00+00:00".to_string())
        );
    }

    #[test]
    fn a_malformed_time_is_rejected_without_panicking() {
        assert_eq!(utc("202ö61020140000 +0200"), None);
        assert_eq!(utc("20261320140000 +0200"), None);
        // The old parser required 14 digits; the DTD allows an initial
        // substring, so ten digits are now 14:00 on the day.
        assert_eq!(
            utc("2026102014"),
            Some("2026-10-20T14:00:00+00:00".to_string())
        );
    }

    #[test]
    fn as_written_subtracts_an_explicit_offset() {
        let at = as_written(0).resolve(&raw("20261020140000 +0200"), &TestZone);
        assert_eq!(rfc(at), "2026-10-20T12:00:00+00:00");
    }

    #[test]
    fn as_written_reads_missing_and_unknown_zones_as_utc() {
        for value in ["20261020140000", "20261020140000 CEST"] {
            let at = as_written(0).resolve(&raw(value), &TestZone);
            assert_eq!(rfc(at), "2026-10-20T14:00:00+00:00", "{value}");
        }
    }

    #[test]
    fn local_zone_ignores_an_explicit_offset() {
        // CEST is +2 on 20 October: the +0000 label is ignored.
        let at = local_zone(0).resolve(&raw("20261020140000 +0000"), &TestZone);
        assert_eq!(rfc(at), "2026-10-20T12:00:00+00:00");
        let at = local_zone(0).resolve(&raw("20261020140000"), &TestZone);
        assert_eq!(rfc(at), "2026-10-20T12:00:00+00:00");
        // Winter: +1.
        let at = local_zone(0).resolve(&raw("20261210140000 +0500"), &TestZone);
        assert_eq!(rfc(at), "2026-12-10T13:00:00+00:00");
    }

    #[test]
    fn the_shift_is_added_after_interpretation() {
        let at = as_written(-120).resolve(&raw("20261020200000 +0000"), &TestZone);
        assert_eq!(rfc(at), "2026-10-20T18:00:00+00:00");
        let at = local_zone(90).resolve(&raw("20261020140000 +0000"), &TestZone);
        assert_eq!(rfc(at), "2026-10-20T13:30:00+00:00");
    }

    #[test]
    fn local_zone_with_the_machines_offset_type_works() {
        // A FixedOffset zone stands in for chrono::Local without depending on it.
        let at = local_zone(0).resolve(&raw("20261020140000"), &fixed(-5 * 3600));
        assert_eq!(rfc(at), "2026-10-20T19:00:00+00:00");
    }

    #[test]
    fn a_matching_explicit_offset_picks_the_hour_in_a_fold() {
        // 02:30 happens twice on 25 October: at +0200 and then at +0100.
        let first = local_zone(0).resolve(&raw("20261025023000 +0200"), &TestZone);
        let second = local_zone(0).resolve(&raw("20261025023000 +0100"), &TestZone);
        assert_eq!(rfc(first), "2026-10-25T00:30:00+00:00");
        assert_eq!(rfc(second), "2026-10-25T01:30:00+00:00");
        // No or a non-matching offset: the earlier occurrence.
        let none = local_zone(0).resolve(&raw("20261025023000"), &TestZone);
        let other = local_zone(0).resolve(&raw("20261025023000 +0000"), &TestZone);
        assert_eq!(none, first);
        assert_eq!(other, first);
    }

    #[test]
    fn a_wall_clock_in_a_gap_maps_to_the_transition() {
        for value in ["20260329020000", "20260329023000", "20260329025959"] {
            let resolved = local_zone(0).resolve_detailed(&raw(value), &TestZone);
            assert_eq!(resolved.at, SPRING, "{value}");
            assert!(resolved.in_gap, "{value}");
        }
        let after = local_zone(0).resolve_detailed(&raw("20260329030000"), &TestZone);
        assert_eq!(after.at, SPRING);
        assert!(!after.in_gap);
        let as_written = as_written(0).resolve_detailed(&raw("20260329023000"), &TestZone);
        assert!(!as_written.in_gap);
    }

    /// Resolve six programmes given as (start, stop) wall times, one channel,
    /// and normalise them; returns kept starts and the verdicts by input order.
    fn sequence(times: &[(&str, &str); 6]) -> (Vec<i64>, Vec<Verdict>, u32) {
        let policy = local_zone(0);
        let mut slots: Vec<Slot> = times
            .iter()
            .enumerate()
            .map(|(seq, (start, stop))| {
                let start = policy.resolve_detailed(&raw(start), &TestZone);
                let stop = policy.resolve(&raw(stop), &TestZone);
                Slot::new(seq as u32, 0, start.at, Some(stop), None).with_start_in_gap(start.in_gap)
            })
            .collect();
        let (verdicts, _, report) = normalise(&mut slots, 0);
        let mut by_seq = vec![Verdict::Keep; 6];
        let mut kept = Vec::new();
        for (slot, verdict) in slots.iter().zip(&verdicts) {
            by_seq[slot.seq as usize] = *verdict;
            if !matches!(verdict, Verdict::Drop(_)) {
                kept.push(slot.start);
            }
        }
        (kept, by_seq, report.gap_collapsed)
    }

    fn strictly_increasing(starts: &[i64]) -> bool {
        starts.windows(2).all(|w| w[0] < w[1])
    }

    #[test]
    fn a_sequence_across_spring_forward_stays_in_order() {
        let (kept, verdicts, gap_collapsed) = sequence(&[
            ("20260329010000", "20260329013000"),
            ("20260329013000", "20260329020000"),
            ("20260329020000", "20260329023000"),
            ("20260329023000", "20260329030000"),
            ("20260329030000", "20260329033000"),
            ("20260329033000", "20260329040000"),
        ]);
        assert!(strictly_increasing(&kept), "{kept:?}");
        assert_eq!(kept.len(), 4);
        assert_eq!(verdicts[2], Verdict::Drop(DropReason::GapCollapsed));
        assert_eq!(verdicts[3], Verdict::Drop(DropReason::GapCollapsed));
        assert_eq!(gap_collapsed, 2);
        // 03:00 CEST is kept at the transition instant.
        assert_eq!(kept[2], SPRING);
    }

    #[test]
    fn a_sequence_across_fall_back_with_offsets_keeps_both_hours() {
        let (kept, verdicts, gap_collapsed) = sequence(&[
            ("20261025013000 +0200", "20261025020000 +0200"),
            ("20261025020000 +0200", "20261025023000 +0200"),
            ("20261025023000 +0200", "20261025020000 +0100"),
            ("20261025020000 +0100", "20261025023000 +0100"),
            ("20261025023000 +0100", "20261025030000 +0100"),
            ("20261025030000 +0100", "20261025033000 +0100"),
        ]);
        assert!(strictly_increasing(&kept), "{kept:?}");
        assert_eq!(kept.len(), 6);
        assert!(verdicts.iter().all(|v| *v == Verdict::Keep));
        assert_eq!(gap_collapsed, 0);
        assert_eq!(rfc(kept[3]), "2026-10-25T01:00:00+00:00");
    }

    #[test]
    fn a_sequence_across_fall_back_without_offsets_stays_in_order() {
        let (kept, verdicts, gap_collapsed) = sequence(&[
            ("20261025013000", "20261025020000"),
            ("20261025020000", "20261025023000"),
            ("20261025023000", "20261025020000"),
            ("20261025020000", "20261025023000"),
            ("20261025023000", "20261025030000"),
            ("20261025030000", "20261025033000"),
        ]);
        assert!(strictly_increasing(&kept), "{kept:?}");
        // Both repeated hours read as the first occurrence: one copy of each
        // start survives, the zero-or-negative span is dropped.
        assert_eq!(kept.len(), 4);
        assert_eq!(verdicts[2], Verdict::Drop(DropReason::InvalidSpan));
        assert_eq!(verdicts[3], Verdict::Drop(DropReason::DuplicateStart));
        assert_eq!(gap_collapsed, 0);
    }

    #[test]
    fn policies_within_range_on_the_grid_are_valid() {
        for shift in [MIN_SHIFT_MINUTES, -30, 0, 30, 120, MAX_SHIFT_MINUTES] {
            assert!(as_written(shift).validate().is_ok(), "{shift}");
        }
    }

    #[test]
    fn policies_off_the_grid_or_out_of_range_are_rejected() {
        for shift in [MIN_SHIFT_MINUTES - 30, MAX_SHIFT_MINUTES + 30, 15, -45] {
            assert!(
                matches!(as_written(shift).validate(), Err(AppError::InvalidInput(_))),
                "{shift}"
            );
        }
    }

    #[test]
    fn the_default_policy_trusts_the_feed() {
        assert_eq!(TimePolicy::default(), as_written(0));
    }

    #[test]
    fn interpret_serialises_as_the_strings_the_frontend_lists() {
        assert_eq!(
            serde_json::to_string(&Interpret::AsWritten).unwrap(),
            "\"as_written\""
        );
        assert_eq!(
            serde_json::to_string(&Interpret::LocalZone).unwrap(),
            "\"local_zone\""
        );
        assert_eq!(
            serde_json::to_string(&local_zone(-120)).unwrap(),
            r#"{"interpret":"local_zone","shift_minutes":-120}"#
        );
    }

    #[test]
    fn interpret_round_trips_through_the_database_value() {
        for interpret in [Interpret::AsWritten, Interpret::LocalZone] {
            assert_eq!(Interpret::from_db(interpret.as_str()), Some(interpret));
        }
        assert_eq!(Interpret::from_db("zone"), None);
    }
}
