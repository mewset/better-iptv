//! Per-channel clean-up of a parsed feed, before anything is stored.
//!
//! The parse sink keeps one `Slot` per programme; `normalise` decides for each
//! one whether it is stored as is, stored with a corrected stop, or dropped,
//! and computes each channel's bounds so the store needs no `GROUP BY`.

use super::report::NormaliseReport;

/// `Slot::stop` of a programme the feed gave no stop.
pub const NO_STOP: i64 = i64::MIN;
/// `Slot::clump` of a programme without `clumpidx`.
pub const NO_CLUMP: u16 = u16::MAX;
/// Programmes that ended this long before `now` are not stored.
pub const ENDED_GRACE_SECS: i64 = 24 * 3600;

const FLAG_START_IN_GAP: u16 = 1;

/// One programme as `normalise` sees it: 32 bytes, so a 430k-programme feed
/// costs about 14 MB here. Sentinels instead of `Option` keep it that size.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot {
    /// Position in the feed; identifies the staged row.
    pub seq: u32,
    /// The channel, as an index the sink assigns per distinct key.
    pub key: u32,
    /// Unix seconds, UTC, after the time policy.
    pub start: i64,
    /// Unix seconds, UTC, or `NO_STOP`.
    pub stop: i64,
    /// Position within a `clumpidx` group, or `NO_CLUMP`.
    pub clump: u16,
    flags: u16,
    _pad: [u16; 2],
}

const _: () = assert!(std::mem::size_of::<Slot>() == 32);

impl Slot {
    pub fn new(seq: u32, key: u32, start: i64, stop: Option<i64>, clump: Option<u16>) -> Self {
        Slot {
            seq,
            key,
            start,
            stop: stop.unwrap_or(NO_STOP),
            clump: clump.unwrap_or(NO_CLUMP),
            flags: 0,
            _pad: [0; 2],
        }
    }

    /// Mark that the start's wall clock fell in a gap of the local zone
    /// (`policy::Resolved::in_gap`).
    pub fn with_start_in_gap(mut self, in_gap: bool) -> Self {
        if in_gap {
            self.flags |= FLAG_START_IN_GAP;
        } else {
            self.flags &= !FLAG_START_IN_GAP;
        }
        self
    }

    pub fn start_in_gap(&self) -> bool {
        self.flags & FLAG_START_IN_GAP != 0
    }
}

/// Why a programme is not stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropReason {
    /// Another programme on the channel starts at the same instant.
    DuplicateStart,
    /// No stop, and no later programme on the channel to take one from.
    NoStop,
    /// Stop at or before start.
    InvalidSpan,
    /// Ended more than `ENDED_GRACE_SECS` before `now`.
    Ended,
    /// Started in a gap of the local zone and collapsed onto the transition.
    GapCollapsed,
}

/// What happens to one programme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Keep,
    /// Store with this stop instead of the feed's.
    KeepWithStop(i64),
    Drop(DropReason),
}

/// The stored extent of one channel after normalisation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyBounds {
    pub key: u32,
    pub first_start: i64,
    pub last_stop: i64,
    pub count: u32,
}

/// Decide what to store for every programme of a feed.
///
/// `slots` is sorted by channel and start (gap-collapsed starts after others,
/// then clump position, then feed order), and `verdicts[i]` belongs to
/// `slots[i]` after the call; kept slots carry their final stop. Per channel,
/// in order:
/// 1. a missing stop becomes the next later start on the channel (the
///    `tv_sort` rule); the last one without a stop is dropped;
/// 2. a stop at or before the start is dropped;
/// 3. of programmes sharing a start, the first is kept;
/// 4. a programme overlapped by the next one that runs past it is cut at the
///    next one's start; one wholly inside another is kept and counted;
/// 5. programmes that ended `ENDED_GRACE_SECS` before `now` are dropped.
///
/// A programme dropped in step 2 or 3 whose start fell in a gap counts as
/// `GapCollapsed`. Channels with no kept programme get no `KeyBounds`.
pub fn normalise(slots: &mut [Slot], now: i64) -> (Vec<Verdict>, Vec<KeyBounds>, NormaliseReport) {
    slots.sort_unstable_by_key(|s| (s.key, s.start, s.start_in_gap(), s.clump, s.seq));
    let mut verdicts = vec![Verdict::Keep; slots.len()];
    let mut bounds = Vec::new();
    let mut report = NormaliseReport::default();
    let cutoff = now.saturating_sub(ENDED_GRACE_SECS);

    let mut lo = 0;
    while lo < slots.len() {
        let key = slots[lo].key;
        let hi = lo + slots[lo..].iter().take_while(|s| s.key == key).count();
        let channel = &mut slots[lo..hi];
        let channel_verdicts = &mut verdicts[lo..hi];
        normalise_channel(channel, channel_verdicts, cutoff, &mut report);
        if let Some(b) = finish_channel(key, channel, channel_verdicts, &mut report) {
            bounds.push(b);
        }
        lo = hi;
    }

    (verdicts, bounds, report)
}

/// Stop a slot is stored with under its current verdict; `None` if dropped.
fn stop_of(slot: &Slot, verdict: Verdict) -> Option<i64> {
    match verdict {
        Verdict::Keep => Some(slot.stop),
        Verdict::KeepWithStop(stop) => Some(stop),
        Verdict::Drop(_) => None,
    }
}

fn drop_slot(slot: &Slot, verdict: &mut Verdict, reason: DropReason, report: &mut NormaliseReport) {
    let reason = match reason {
        DropReason::DuplicateStart | DropReason::InvalidSpan if slot.start_in_gap() => {
            DropReason::GapCollapsed
        }
        other => other,
    };
    match reason {
        DropReason::DuplicateStart => report.duplicate_starts_dropped += 1,
        DropReason::NoStop => report.last_without_stop_dropped += 1,
        DropReason::InvalidSpan => report.invalid_span_dropped += 1,
        DropReason::Ended => report.ended_before_cutoff_dropped += 1,
        DropReason::GapCollapsed => report.gap_collapsed += 1,
    }
    *verdict = Verdict::Drop(reason);
}

fn normalise_channel(
    slots: &[Slot],
    verdicts: &mut [Verdict],
    cutoff: i64,
    report: &mut NormaliseReport,
) {
    let n = slots.len();

    // 1. Missing stops from the next later start, walking backwards.
    let mut next_start = None;
    for i in (0..n).rev() {
        if i + 1 < n && slots[i + 1].start > slots[i].start {
            next_start = Some(slots[i + 1].start);
        }
        if slots[i].stop == NO_STOP {
            match next_start {
                Some(stop) => verdicts[i] = Verdict::KeepWithStop(stop),
                None => drop_slot(&slots[i], &mut verdicts[i], DropReason::NoStop, report),
            }
        }
    }

    // 2 and 3. Empty spans, then duplicate starts among what is left.
    let mut last_start = None;
    for i in 0..n {
        let Some(stop) = stop_of(&slots[i], verdicts[i]) else {
            continue;
        };
        if stop <= slots[i].start {
            drop_slot(&slots[i], &mut verdicts[i], DropReason::InvalidSpan, report);
        } else if last_start == Some(slots[i].start) {
            drop_slot(
                &slots[i],
                &mut verdicts[i],
                DropReason::DuplicateStart,
                report,
            );
        } else {
            last_start = Some(slots[i].start);
        }
    }

    // 4. Overlaps against the programme currently on air.
    let mut on_air: Option<usize> = None;
    for i in 0..n {
        let Some(stop) = stop_of(&slots[i], verdicts[i]) else {
            continue;
        };
        let Some(current) = on_air else {
            on_air = Some(i);
            continue;
        };
        let current_stop = stop_of(&slots[current], verdicts[current]).unwrap_or(NO_STOP);
        if slots[i].start >= current_stop {
            on_air = Some(i);
        } else if stop <= current_stop {
            report.nested_kept += 1;
        } else {
            verdicts[current] = Verdict::KeepWithStop(slots[i].start);
            report.consecutive_overlaps_trimmed += 1;
            on_air = Some(i);
        }
    }

    // 5. Ended long ago.
    for i in 0..n {
        if stop_of(&slots[i], verdicts[i]).is_some_and(|stop| stop <= cutoff) {
            drop_slot(&slots[i], &mut verdicts[i], DropReason::Ended, report);
        }
    }
}

/// Write final stops into kept slots, count inferred stops, and compute the
/// channel's bounds.
fn finish_channel(
    key: u32,
    slots: &mut [Slot],
    verdicts: &[Verdict],
    report: &mut NormaliseReport,
) -> Option<KeyBounds> {
    let mut bounds: Option<KeyBounds> = None;
    for (slot, verdict) in slots.iter_mut().zip(verdicts) {
        let Some(stop) = stop_of(slot, *verdict) else {
            continue;
        };
        if slot.stop == NO_STOP {
            report.stops_inferred += 1;
        }
        slot.stop = stop;
        let b = bounds.get_or_insert(KeyBounds {
            key,
            first_start: slot.start,
            last_stop: stop,
            count: 0,
        });
        b.last_stop = b.last_stop.max(stop);
        b.count += 1;
    }
    bounds
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const H: i64 = 3600;

    fn slot(seq: u32, key: u32, start: i64, stop: Option<i64>) -> Slot {
        Slot::new(seq, key, NOW + start, stop.map(|s| NOW + s), None)
    }

    /// Run `normalise` and return (seq, verdict) pairs in feed order.
    fn run(slots: &mut [Slot]) -> (Vec<(u32, Verdict)>, Vec<KeyBounds>, NormaliseReport) {
        let (verdicts, bounds, report) = normalise(slots, NOW);
        let mut by_seq: Vec<(u32, Verdict)> = slots.iter().map(|s| s.seq).zip(verdicts).collect();
        by_seq.sort_by_key(|(seq, _)| *seq);
        (by_seq, bounds, report)
    }

    fn verdicts_of(pairs: &[(u32, Verdict)]) -> Vec<Verdict> {
        pairs.iter().map(|(_, v)| *v).collect()
    }

    #[test]
    fn a_slot_is_32_bytes() {
        assert_eq!(std::mem::size_of::<Slot>(), 32);
    }

    #[test]
    fn sentinels_stand_for_missing_values() {
        let s = Slot::new(1, 2, 3, None, None);
        assert_eq!(s.stop, NO_STOP);
        assert_eq!(s.clump, NO_CLUMP);
        assert!(!s.start_in_gap());
        assert!(s.with_start_in_gap(true).start_in_gap());
        assert!(!s
            .with_start_in_gap(true)
            .with_start_in_gap(false)
            .start_in_gap());
    }

    #[test]
    fn a_clean_channel_is_kept_as_is() {
        let mut slots = [slot(0, 0, 0, Some(H)), slot(1, 0, H, Some(2 * H))];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(verdicts_of(&verdicts), [Verdict::Keep, Verdict::Keep]);
        assert_eq!(report, NormaliseReport::default());
    }

    #[test]
    fn a_duplicate_start_keeps_the_first_in_feed_order() {
        let mut slots = [
            slot(0, 0, 0, Some(H)),
            slot(1, 0, 0, Some(2 * H)),
            slot(2, 0, H, Some(2 * H)),
        ];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [
                Verdict::Keep,
                Verdict::Drop(DropReason::DuplicateStart),
                Verdict::Keep
            ]
        );
        assert_eq!(report.duplicate_starts_dropped, 1);
    }

    #[test]
    fn clumpidx_orders_programmes_sharing_a_start() {
        // Feed order 1/2 before 0/2: the clump's first part is kept.
        let mut slots = [
            Slot::new(0, 0, NOW, Some(NOW + H), Some(1)),
            Slot::new(1, 0, NOW, Some(NOW + H), Some(0)),
        ];
        let (verdicts, _, _) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [Verdict::Drop(DropReason::DuplicateStart), Verdict::Keep]
        );
    }

    #[test]
    fn a_missing_stop_is_the_next_start_on_the_same_channel() {
        // Channels interleaved in the feed, as real feeds sometimes are.
        let mut slots = [
            slot(0, 0, 0, None),
            slot(1, 1, 0, None),
            slot(2, 1, H / 2, Some(H)),
            slot(3, 0, 2 * H, Some(3 * H)),
        ];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [
                Verdict::KeepWithStop(NOW + 2 * H),
                Verdict::KeepWithStop(NOW + H / 2),
                Verdict::Keep,
                Verdict::Keep
            ]
        );
        assert_eq!(report.stops_inferred, 2);
    }

    #[test]
    fn a_missing_stop_skips_a_duplicate_of_its_own_start() {
        let mut slots = [
            slot(0, 0, 0, None),
            slot(1, 0, 0, Some(H)),
            slot(2, 0, 3 * H, Some(4 * H)),
        ];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(verdicts[0].1, Verdict::KeepWithStop(NOW + 3 * H));
        assert_eq!(verdicts[1].1, Verdict::Drop(DropReason::DuplicateStart));
        assert_eq!(report.stops_inferred, 1);
    }

    #[test]
    fn the_last_programme_without_a_stop_is_dropped() {
        let mut slots = [slot(0, 0, 0, Some(H)), slot(1, 0, H, None)];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(verdicts[1].1, Verdict::Drop(DropReason::NoStop));
        assert_eq!(report.last_without_stop_dropped, 1);
    }

    #[test]
    fn a_consecutive_overlap_is_cut_at_the_next_start() {
        let mut slots = [slot(0, 0, 0, Some(2 * H)), slot(1, 0, H, Some(3 * H))];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [Verdict::KeepWithStop(NOW + H), Verdict::Keep]
        );
        assert_eq!(report.consecutive_overlaps_trimmed, 1);
        assert_eq!(slots[0].stop, NOW + H);
    }

    #[test]
    fn a_nested_programme_is_kept_and_counted() {
        // A film with a news break inside it, then the next programme.
        let mut slots = [
            slot(0, 0, 0, Some(3 * H)),
            slot(1, 0, H, Some(H + H / 6)),
            slot(2, 0, 3 * H, Some(4 * H)),
        ];
        let (verdicts, bounds, report) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [Verdict::Keep, Verdict::Keep, Verdict::Keep]
        );
        assert_eq!(report.nested_kept, 1);
        assert_eq!(report.consecutive_overlaps_trimmed, 0);
        assert_eq!(bounds[0].count, 3);
    }

    #[test]
    fn a_programme_overlapping_past_a_nested_one_cuts_the_outer_one() {
        let mut slots = [
            slot(0, 0, 0, Some(3 * H)),
            slot(1, 0, H, Some(H + H / 6)),
            slot(2, 0, 2 * H, Some(4 * H)),
        ];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [
                Verdict::KeepWithStop(NOW + 2 * H),
                Verdict::Keep,
                Verdict::Keep
            ]
        );
        assert_eq!(report.nested_kept, 1);
        assert_eq!(report.consecutive_overlaps_trimmed, 1);
    }

    #[test]
    fn a_stop_at_or_before_the_start_is_dropped() {
        let mut slots = [
            slot(0, 0, 0, Some(0)),
            slot(1, 0, H, Some(H / 2)),
            slot(2, 0, 2 * H, Some(3 * H)),
        ];
        let (verdicts, _, report) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [
                Verdict::Drop(DropReason::InvalidSpan),
                Verdict::Drop(DropReason::InvalidSpan),
                Verdict::Keep
            ]
        );
        assert_eq!(report.invalid_span_dropped, 2);
    }

    #[test]
    fn a_valid_programme_survives_an_invalid_one_at_the_same_start() {
        let mut slots = [slot(0, 0, 0, Some(0)), slot(1, 0, 0, Some(H))];
        let (verdicts, _, _) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [Verdict::Drop(DropReason::InvalidSpan), Verdict::Keep]
        );
    }

    #[test]
    fn programmes_ended_before_the_cutoff_are_dropped() {
        let mut slots = [
            slot(0, 0, -26 * H, Some(-25 * H)),
            slot(1, 0, -25 * H, Some(-24 * H)),
            slot(2, 0, -24 * H, Some(-23 * H)),
            slot(3, 0, 0, Some(H)),
        ];
        let (verdicts, bounds, report) = run(&mut slots);
        assert_eq!(
            verdicts_of(&verdicts),
            [
                Verdict::Drop(DropReason::Ended),
                Verdict::Drop(DropReason::Ended),
                Verdict::Keep,
                Verdict::Keep
            ]
        );
        assert_eq!(report.ended_before_cutoff_dropped, 2);
        assert_eq!(bounds[0].first_start, NOW - 24 * H);
    }

    #[test]
    fn the_cutoff_follows_the_injected_now() {
        let mut slots = [slot(0, 0, 0, Some(H))];
        let (verdicts, _, _) = normalise(&mut slots, NOW + 25 * H);
        assert_eq!(verdicts, [Verdict::Drop(DropReason::Ended)]);
        let (verdicts, _, _) = normalise(&mut slots, NOW + 24 * H);
        assert_eq!(verdicts, [Verdict::Keep]);
    }

    #[test]
    fn duplicates_and_empty_spans_of_gap_starts_count_as_collapsed() {
        let mut slots = [
            slot(0, 0, 0, Some(0)).with_start_in_gap(true),
            slot(1, 0, 0, Some(H)).with_start_in_gap(true),
            slot(2, 0, 0, Some(H / 2)),
        ];
        let (verdicts, _, report) = run(&mut slots);
        // The programme that really starts at the transition is kept.
        assert_eq!(
            verdicts_of(&verdicts),
            [
                Verdict::Drop(DropReason::GapCollapsed),
                Verdict::Drop(DropReason::GapCollapsed),
                Verdict::Keep
            ]
        );
        assert_eq!(report.gap_collapsed, 2);
        assert_eq!(report.duplicate_starts_dropped, 0);
        assert_eq!(report.invalid_span_dropped, 0);
    }

    #[test]
    fn bounds_and_counts_are_per_channel() {
        let mut slots = [
            slot(0, 7, H, Some(2 * H)),
            slot(1, 3, 0, Some(H)),
            slot(2, 7, 0, None),
            slot(3, 3, H, Some(5 * H)),
            slot(4, 3, 2 * H, Some(3 * H)),
            slot(5, 9, 0, None),
        ];
        let (_, bounds, _) = run(&mut slots);
        assert_eq!(
            bounds,
            [
                KeyBounds {
                    key: 3,
                    first_start: NOW,
                    last_stop: NOW + 5 * H,
                    count: 3
                },
                KeyBounds {
                    key: 7,
                    first_start: NOW,
                    last_stop: NOW + 2 * H,
                    count: 2
                },
            ]
        );
    }

    #[test]
    fn slots_come_back_sorted_with_final_stops() {
        let mut slots = [
            slot(0, 1, H, Some(2 * H)),
            slot(1, 0, 0, None),
            slot(2, 0, H, Some(2 * H)),
        ];
        let (verdicts, _, _) = normalise(&mut slots, NOW);
        let order: Vec<u32> = slots.iter().map(|s| s.seq).collect();
        assert_eq!(order, [1, 2, 0]);
        assert_eq!(slots[0].stop, NOW + H);
        assert_eq!(verdicts[0], Verdict::KeepWithStop(NOW + H));
    }

    #[test]
    fn an_empty_feed_normalises_to_nothing() {
        let (verdicts, bounds, report) = normalise(&mut [], NOW);
        assert!(verdicts.is_empty());
        assert!(bounds.is_empty());
        assert_eq!(report, NormaliseReport::default());
    }
}
