//! Channel matching: which guide channel a playlist channel shows.
//!
//! A live channel is matched by its id first: `channel_key(epg_id)` against
//! the keys of the guide channels that have programmes. A channel with an id
//! the guide does not know stays unmatched; names are never tried for it,
//! because a name that also exists in another country's guide brought that
//! country's schedule. Only a channel without any id is matched by name: its
//! `tvg_name`, then its display name, through `name_key`.
//!
//! The guide is the sources that apply to the playlist, in precedence order.
//! A display name that one source gives to two different channels says
//! nothing about either: it is dropped and counted, never resolved by
//! picking the first. Between sources, the higher-precedence source's name
//! wins.
//!
//! A match set by hand (`manual`) is never changed here, even when its key
//! has left the guide. VOD and series rows never get a match; one they hold
//! from before (a channel the provider turned into VOD) is cleared.

use super::key::{channel_key, name_key};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

/// How a channel got its guide key; stored in `channels.epg_match_source`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchSource {
    /// `channel_key(epg_id)` is a guide key.
    Id,
    /// The channel has no id; its `tvg_name` is a guide channel's name.
    TvgName,
    /// The channel has no id; its display name is a guide channel's name.
    Name,
    /// Set by hand; the matcher leaves it alone.
    Manual,
}

impl MatchSource {
    /// The value stored in `channels.epg_match_source`.
    pub fn as_db(self) -> &'static str {
        match self {
            MatchSource::Id => "id",
            MatchSource::TvgName => "tvg_name",
            MatchSource::Name => "name",
            MatchSource::Manual => "manual",
        }
    }

    /// Read a stored value; `None` for NULL and for a value this version
    /// does not know.
    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "id" => Some(MatchSource::Id),
            "tvg_name" => Some(MatchSource::TvgName),
            "name" => Some(MatchSource::Name),
            "manual" => Some(MatchSource::Manual),
            _ => None,
        }
    }
}

/// What one guide source offers the matcher.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceGuide {
    /// The `channel_key`s of its channels that have programmes.
    pub keys: Vec<String>,
    /// `(name_key, key)` for every display name of those channels.
    pub names: Vec<(String, String)>,
}

/// The guide of one playlist, ready to match against.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GuideIndex {
    keys: HashSet<String>,
    /// name_key → key, ambiguous names removed.
    names: HashMap<String, String>,
    ambiguous_names: u32,
}

impl GuideIndex {
    /// Combine the sources that apply to a playlist, highest precedence
    /// first. Within a source, a name given to more than one key is
    /// dropped and counted in `ambiguous_names`; across sources, the first
    /// source that names a key keeps the name.
    pub fn build(sources: impl IntoIterator<Item = SourceGuide>) -> Self {
        let mut index = GuideIndex::default();
        for source in sources {
            index.keys.extend(source.keys);
            // `None` marks a name this source gives to two keys.
            let mut own: HashMap<String, Option<String>> = HashMap::new();
            for (name, key) in source.names {
                match own.entry(name) {
                    Entry::Vacant(slot) => {
                        slot.insert(Some(key));
                    }
                    Entry::Occupied(mut slot) => {
                        if slot.get().as_ref().is_some_and(|known| *known != key) {
                            slot.insert(None);
                        }
                    }
                }
            }
            for (name, key) in own {
                match key {
                    Some(key) => {
                        index.names.entry(name).or_insert(key);
                    }
                    None => index.ambiguous_names += 1,
                }
            }
        }
        index
    }

    /// Display names dropped because one source gave them to two channels,
    /// counted once per source.
    pub fn ambiguous_names(&self) -> u32 {
        self.ambiguous_names
    }

    /// The match a live channel gets, before any `manual` is considered.
    fn automatic(&self, channel: &ChannelRow<'_>) -> Option<(String, MatchSource)> {
        if let Some(key) = channel.epg_id.and_then(channel_key) {
            return self.keys.contains(&key).then_some((key, MatchSource::Id));
        }
        let by_name = |raw: Option<&str>, source: MatchSource| {
            raw.and_then(name_key)
                .and_then(|name| self.names.get(&name))
                .map(|key| (key.clone(), source))
        };
        by_name(channel.tvg_name, MatchSource::TvgName)
            .or_else(|| by_name(Some(channel.name), MatchSource::Name))
    }
}

/// One `channels` row as the matcher reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelRow<'a> {
    pub id: i64,
    /// `content_type = 'live'`.
    pub live: bool,
    /// Raw, as the provider sent it.
    pub epg_id: Option<&'a str>,
    pub tvg_name: Option<&'a str>,
    pub name: &'a str,
    /// The stored match.
    pub match_key: Option<&'a str>,
    pub match_source: Option<&'a str>,
}

/// A row whose stored match changes; `None`/`None` clears it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchUpdate {
    pub channel_id: i64,
    pub key: Option<String>,
    pub source: Option<MatchSource>,
}

/// What one recompute found, for the log line and the event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MatchReport {
    /// Live rows looked at.
    pub considered: u32,
    pub by_id: u32,
    pub by_tvg_name: u32,
    pub by_name: u32,
    /// Live rows whose match was set by hand and left alone.
    pub manual_kept: u32,
    /// Live rows with an id the guide does not know.
    pub unmatched_with_id: u32,
    /// See `GuideIndex::ambiguous_names`.
    pub ambiguous_names: u32,
    /// Rows whose stored match changed, live or not.
    pub changed: u32,
}

impl MatchReport {
    /// Add another playlist's report to this one.
    pub fn add(&mut self, other: &MatchReport) {
        self.considered += other.considered;
        self.by_id += other.by_id;
        self.by_tvg_name += other.by_tvg_name;
        self.by_name += other.by_name;
        self.manual_kept += other.manual_kept;
        self.unmatched_with_id += other.unmatched_with_id;
        self.ambiguous_names += other.ambiguous_names;
        self.changed += other.changed;
    }
}

/// Decides the match of one row after another and counts what it decided.
pub struct Matcher<'g> {
    index: &'g GuideIndex,
    report: MatchReport,
}

impl<'g> Matcher<'g> {
    pub fn new(index: &'g GuideIndex) -> Self {
        Matcher {
            index,
            report: MatchReport {
                ambiguous_names: index.ambiguous_names,
                ..MatchReport::default()
            },
        }
    }

    /// The update `channel` needs, `None` when its stored match stands.
    pub fn visit(&mut self, channel: &ChannelRow<'_>) -> Option<MatchUpdate> {
        let stored = channel.match_source.and_then(MatchSource::from_db);
        if stored == Some(MatchSource::Manual) {
            if channel.live {
                self.report.considered += 1;
                self.report.manual_kept += 1;
            }
            return None;
        }
        let wanted = if channel.live {
            self.report.considered += 1;
            let wanted = self.index.automatic(channel);
            match wanted.as_ref().map(|(_, source)| *source) {
                Some(MatchSource::Id) => self.report.by_id += 1,
                Some(MatchSource::TvgName) => self.report.by_tvg_name += 1,
                Some(MatchSource::Name) => self.report.by_name += 1,
                Some(MatchSource::Manual) => {}
                None if channel.epg_id.and_then(channel_key).is_some() => {
                    self.report.unmatched_with_id += 1
                }
                None => {}
            }
            wanted
        } else {
            None
        };
        let (key, source) = match wanted {
            Some((key, source)) => (Some(key), Some(source)),
            None => (None, None),
        };
        if channel.match_key == key.as_deref()
            && channel.match_source == source.map(MatchSource::as_db)
        {
            return None;
        }
        self.report.changed += 1;
        Some(MatchUpdate {
            channel_id: channel.id,
            key,
            source,
        })
    }

    pub fn finish(self) -> MatchReport {
        self.report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(keys: &[&str], names: &[(&str, &str)]) -> SourceGuide {
        SourceGuide {
            keys: keys.iter().map(|k| k.to_string()).collect(),
            names: names
                .iter()
                .map(|(n, k)| (n.to_string(), k.to_string()))
                .collect(),
        }
    }

    fn live<'a>(id: i64, epg_id: Option<&'a str>, name: &'a str) -> ChannelRow<'a> {
        ChannelRow {
            id,
            live: true,
            epg_id,
            tvg_name: None,
            name,
            match_key: None,
            match_source: None,
        }
    }

    fn run(index: &GuideIndex, rows: &[ChannelRow<'_>]) -> (Vec<MatchUpdate>, MatchReport) {
        let mut matcher = Matcher::new(index);
        let updates = rows.iter().filter_map(|r| matcher.visit(r)).collect();
        (updates, matcher.finish())
    }

    fn set(id: i64, key: &str, source: MatchSource) -> MatchUpdate {
        MatchUpdate {
            channel_id: id,
            key: Some(key.to_string()),
            source: Some(source),
        }
    }

    fn cleared(id: i64) -> MatchUpdate {
        MatchUpdate {
            channel_id: id,
            key: None,
            source: None,
        }
    }

    #[test]
    fn match_sources_round_trip_through_the_stored_strings() {
        for source in [
            MatchSource::Id,
            MatchSource::TvgName,
            MatchSource::Name,
            MatchSource::Manual,
        ] {
            assert_eq!(MatchSource::from_db(source.as_db()), Some(source));
        }
        assert_eq!(MatchSource::from_db("fuzzy"), None);
    }

    #[test]
    fn an_id_matches_its_guide_key_in_any_case() {
        let index = GuideIndex::build([source(&["svt1.se", "ämne.se"], &[])]);
        let rows = [
            live(1, Some("SVT1.se"), "SVT1"),
            live(2, Some(" svt1.SE "), "SVT1 HD"),
            live(3, Some("Ämne.se"), "Ämne"),
        ];

        let (updates, report) = run(&index, &rows);

        assert_eq!(
            updates,
            [
                set(1, "svt1.se", MatchSource::Id),
                set(2, "svt1.se", MatchSource::Id),
                set(3, "ämne.se", MatchSource::Id),
            ]
        );
        assert_eq!((report.by_id, report.changed, report.considered), (3, 3, 3));
    }

    #[test]
    fn a_stored_match_that_stands_is_not_written_again() {
        let index = GuideIndex::build([source(&["svt1.se"], &[])]);
        let row = ChannelRow {
            match_key: Some("svt1.se"),
            match_source: Some("id"),
            ..live(1, Some("SVT1.se"), "SVT1")
        };

        let (updates, report) = run(&index, &[row]);

        assert!(updates.is_empty());
        assert_eq!((report.by_id, report.changed), (1, 0));
    }

    #[test]
    fn a_manual_match_is_untouched_even_when_its_key_left_the_guide() {
        let index = GuideIndex::build([source(&["tv4.se"], &[("svt1", "tv4.se")])]);
        let row = ChannelRow {
            match_key: Some("gone.se"),
            match_source: Some("manual"),
            ..live(1, Some("tv4.se"), "SVT1")
        };

        let (updates, report) = run(&index, &[row]);

        assert!(updates.is_empty());
        assert_eq!(
            (report.manual_kept, report.by_id, report.changed),
            (1, 0, 0)
        );
    }

    #[test]
    fn vod_and_series_are_never_matched_and_lose_a_stale_match() {
        let index = GuideIndex::build([source(&["film.se"], &[("film", "film.se")])]);
        let vod = ChannelRow {
            live: false,
            ..live(1, Some("film.se"), "Film")
        };
        let series = ChannelRow {
            live: false,
            ..live(2, None, "Film")
        };
        let turned_vod = ChannelRow {
            live: false,
            match_key: Some("film.se"),
            match_source: Some("id"),
            ..live(3, Some("film.se"), "Film")
        };

        let (updates, report) = run(&index, &[vod, series, turned_vod]);

        assert_eq!(updates, [cleared(3)]);
        assert_eq!((report.considered, report.by_id, report.by_name), (0, 0, 0));
        assert_eq!(report.changed, 1);
    }

    #[test]
    fn a_channel_whose_key_left_the_guide_is_cleared() {
        let index = GuideIndex::build([source(&["tv4.se"], &[])]);
        let row = ChannelRow {
            match_key: Some("svt1.se"),
            match_source: Some("id"),
            ..live(1, Some("svt1.se"), "SVT1")
        };

        let (updates, report) = run(&index, &[row]);

        assert_eq!(updates, [cleared(1)]);
        assert_eq!((report.unmatched_with_id, report.changed), (1, 1));
    }

    #[test]
    fn a_channel_with_an_unknown_id_is_not_matched_by_its_name() {
        let index =
            GuideIndex::build([source(&["discovery.no"], &[("discovery", "discovery.no")])]);
        let row = ChannelRow {
            tvg_name: Some("Discovery"),
            ..live(1, Some("Discovery.nl"), "Discovery")
        };

        let (updates, report) = run(&index, &[row]);

        assert!(updates.is_empty());
        assert_eq!((report.unmatched_with_id, report.by_name), (1, 0));
    }

    #[test]
    fn a_blank_id_counts_as_no_id() {
        let index = GuideIndex::build([source(&["svt1.se"], &[("svt1", "svt1.se")])]);
        let (updates, report) = run(&index, &[live(1, Some("  "), "SVT1")]);
        assert_eq!(updates, [set(1, "svt1.se", MatchSource::Name)]);
        assert_eq!(report.unmatched_with_id, 0);
    }

    #[test]
    fn a_channel_without_an_id_is_matched_by_tvg_name_before_its_name() {
        let index = GuideIndex::build([source(
            &["svt1.se", "svt2.se"],
            &[("svt1", "svt1.se"), ("svt2", "svt2.se")],
        )]);
        let both = ChannelRow {
            tvg_name: Some("SVT1"),
            ..live(1, None, "SVT2")
        };
        let name_only = ChannelRow {
            tvg_name: Some("Unknown"),
            ..live(2, None, "SVT2")
        };
        let neither = live(3, None, "Kanal 9");

        let (updates, report) = run(&index, &[both, name_only, neither]);

        assert_eq!(
            updates,
            [
                set(1, "svt1.se", MatchSource::TvgName),
                set(2, "svt2.se", MatchSource::Name),
            ]
        );
        assert_eq!((report.by_tvg_name, report.by_name), (1, 1));
        assert_eq!(report.considered, 3);
    }

    #[test]
    fn names_match_with_underscores_spaces_and_case_alike() {
        let index = GuideIndex::build([source(&["svt1hd.se"], &[("svt1 hd", "svt1hd.se")])]);
        let rows = [
            live(1, None, "SVT1_HD"),
            live(2, None, "  svt1   HD "),
            ChannelRow {
                tvg_name: Some("Svt1_Hd"),
                ..live(3, None, "x")
            },
        ];

        let (updates, _) = run(&index, &rows);

        assert_eq!(
            updates,
            [
                set(1, "svt1hd.se", MatchSource::Name),
                set(2, "svt1hd.se", MatchSource::Name),
                set(3, "svt1hd.se", MatchSource::TvgName),
            ]
        );
    }

    #[test]
    fn a_name_one_source_gives_to_two_channels_matches_nothing_and_is_counted() {
        let index = GuideIndex::build([source(
            &["tv4.se", "tv4hd.se", "svt1.se"],
            &[
                ("tv4", "tv4.se"),
                ("tv4", "tv4hd.se"),
                // The same name twice for one channel is not ambiguous.
                ("svt1", "svt1.se"),
                ("svt1", "svt1.se"),
            ],
        )]);

        let (updates, report) = run(&index, &[live(1, None, "TV4"), live(2, None, "SVT1")]);

        assert_eq!(updates, [set(2, "svt1.se", MatchSource::Name)]);
        assert_eq!(index.ambiguous_names(), 1);
        assert_eq!(report.ambiguous_names, 1);
    }

    #[test]
    fn a_name_in_two_sources_takes_the_key_of_the_higher_priority_one() {
        let index = GuideIndex::build([
            source(&["tv4.se"], &[("tv4", "tv4.se")]),
            source(&["tv4.no"], &[("tv4", "tv4.no")]),
        ]);

        let (updates, report) = run(&index, &[live(1, None, "TV4")]);

        assert_eq!(updates, [set(1, "tv4.se", MatchSource::Name)]);
        assert_eq!(report.ambiguous_names, 0);
    }

    #[test]
    fn keys_of_every_source_count_for_an_id() {
        let index = GuideIndex::build([source(&["svt1.se"], &[]), source(&["tv4.no"], &[])]);
        let (updates, _) = run(&index, &[live(1, Some("TV4.no"), "TV4")]);
        assert_eq!(updates, [set(1, "tv4.no", MatchSource::Id)]);
    }

    #[test]
    fn a_match_by_another_way_is_rewritten_with_its_source() {
        // The provider added an id: the name match becomes an id match.
        let index = GuideIndex::build([source(&["svt1.se"], &[("svt1", "svt1.se")])]);
        let row = ChannelRow {
            match_key: Some("svt1.se"),
            match_source: Some("name"),
            ..live(1, Some("svt1.se"), "SVT1")
        };
        let (updates, _) = run(&index, &[row]);
        assert_eq!(updates, [set(1, "svt1.se", MatchSource::Id)]);
    }

    #[test]
    fn reports_add_up() {
        let mut total = MatchReport {
            by_id: 1,
            changed: 2,
            ..MatchReport::default()
        };
        total.add(&MatchReport {
            by_id: 3,
            by_name: 1,
            changed: 1,
            ambiguous_names: 2,
            ..MatchReport::default()
        });
        assert_eq!(
            (
                total.by_id,
                total.by_name,
                total.changed,
                total.ambiguous_names
            ),
            (4, 1, 3, 2)
        );
    }
}
