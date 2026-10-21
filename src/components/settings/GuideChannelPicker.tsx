import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import {
  GUIDE_SEARCH_MIN_CHARS,
  searchEpgChannels,
  setChannelEpgMatch,
  type EpgChannelHit,
} from '../../lib/epgIpc';
import {
  channelIndex,
  findChannels,
  guideSearchable,
  hitDetails,
  hitTitle,
  matchState,
  visibleGuideHits,
  type MatchLookup,
} from '../../lib/epgMatchView';
import { errorText } from '../../lib/epgSourceView';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useParentalHiding, useParentalLocked } from '../../hooks/useParentalHiding';
import { usePlayerStore } from '../../stores/player-store';
import { isAppError } from '../../types/errors';
import { logger } from '../../lib/logger';
import type { Channel } from '../../types';

/** Typing pauses this long before your channels are searched. */
export const CHANNEL_FILTER_DEBOUNCE_MS = 150;
/** Typing pauses this long before the guide is asked. */
export const GUIDE_SEARCH_DEBOUNCE_MS = 300;

interface GuideChannelPickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** How the channels are matched now; null until known. */
  lookup: MatchLookup | null;
  /** A match was set or cleared here. */
  onChanged: () => void;
}

const inputClass =
  'w-full rounded-lg border border-border-strong bg-surface py-2 pl-10 pr-4 text-text focus:border-transparent focus:ring-2 focus:ring-accent';
const rowButton =
  'flex w-full flex-col items-start rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * "Fix a channel": pick one of your live channels, then the guide channel
 * it should show. Choosing sets the match by hand; "Use automatic match"
 * gives a channel set by hand back to the automatic matching. After either,
 * the picker returns to your channels with the search kept, so several
 * channels can be fixed in a row.
 */
export default function GuideChannelPicker(props: GuideChannelPickerProps) {
  if (!props.isOpen) return null;
  return <Picker {...props} />;
}

function Picker({ onClose, lookup, onChanged }: GuideChannelPickerProps) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [channelQuery, setChannelQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const done = (message: string) => {
    setChannel(null);
    setNotice(message);
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Fix a channel's guide"
        className="flex h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-surface p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="truncate text-xl font-bold text-text">
            {channel ? `Guide channel for ${channel.name}` : 'Fix a channel'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1 hover:bg-surface-hover"
          >
            <X className="h-5 w-5 text-text-muted" aria-hidden="true" />
          </button>
        </div>
        {channel ? (
          <GuideStep
            channel={channel}
            lookup={lookup}
            onBack={() => setChannel(null)}
            onDone={done}
          />
        ) : (
          <ChannelStep
            query={channelQuery}
            onQuery={(q) => {
              setChannelQuery(q);
              setNotice(null);
            }}
            lookup={lookup}
            notice={notice}
            onPick={setChannel}
          />
        )}
      </div>
    </div>
  );
}

/** The live channels the picker may list: those the channel list would show. */
function useSearchableChannels(): Channel[] {
  const liveChannels = usePlayerStore((s) => s.liveChannels);
  const hidden = useParentalHiding();
  // Hidden channels stay hidden here too.
  return useMemo(
    () => (hidden ? liveChannels.filter((c) => !hidden(c)) : liveChannels),
    [liveChannels, hidden]
  );
}

interface ChannelStepProps {
  query: string;
  onQuery: (query: string) => void;
  lookup: MatchLookup | null;
  notice: string | null;
  onPick: (channel: Channel) => void;
}

/** Step 1: your live channels, searched in the app, at most 50 listed. */
function ChannelStep({ query, onQuery, lookup, notice, onPick }: ChannelStepProps) {
  const id = useId();
  const inputRef = useRef<globalThis.HTMLInputElement>(null);
  const channels = useSearchableChannels();
  const index = useMemo(() => channelIndex(channels), [channels]);
  const debounced = useDebouncedValue(query, CHANNEL_FILTER_DEBOUNCE_MS);
  const { hits, total } = useMemo(() => findChannels(index, debounced), [index, debounced]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const inputId = `${id}-query`;
  const countId = `${id}-count`;
  return (
    <>
      <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-text-muted">
        Search your channels
      </label>
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Channel name"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={countId}
          className={inputClass}
        />
      </div>
      <p role="status" className="mt-2 min-h-5 text-xs text-text-muted">
        {notice}
      </p>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        <ul aria-label="Your channels" className="flex flex-col gap-2">
          {hits.map((channel) => {
            const state = matchState(channel, lookup);
            return (
              <li key={channel.id}>
                <button type="button" onClick={() => onPick(channel)} className={rowButton}>
                  <span className="w-full truncate font-medium text-text">{channel.name}</span>
                  <span className="w-full truncate text-xs text-text-muted">
                    {channel.group_name ? `${channel.group_name} · ${state.text}` : state.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p id={countId} className="mt-3 text-xs text-text-faint">
        {channelCount(debounced, hits.length, total)}
      </p>
    </>
  );
}

function channelCount(query: string, shown: number, total: number): string {
  if (!query.trim()) return "Type part of a channel's name.";
  if (total === 0) return 'No channel has that in its name.';
  if (shown < total) {
    return `Showing ${shown} of ${total.toLocaleString('en-US')} channels; type more to narrow the list.`;
  }
  return total === 1 ? '1 channel' : `${total.toLocaleString('en-US')} channels`;
}

interface GuideStepProps {
  channel: Channel;
  lookup: MatchLookup | null;
  onBack: () => void;
  onDone: (message: string) => void;
}

/**
 * Step 2: the guide channels of this profile's sources, searched by the
 * backend after a pause in typing. Starts with the channel's own name.
 */
function GuideStep({ channel, lookup, onBack, onDone }: GuideStepProps) {
  const id = useId();
  const inputRef = useRef<globalThis.HTMLInputElement>(null);
  const [query, setQuery] = useState(channel.name);
  const debounced = useDebouncedValue(query, GUIDE_SEARCH_DEBOUNCE_MS);
  const [hits, setHits] = useState<EpgChannelHit[]>([]);
  // The first search starts right after the first render; saying so from
  // the start keeps "No guide channel…" from showing for a frame.
  const [searching, setSearching] = useState(() => guideSearchable(channel.name));
  const [searchError, setSearchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const request = useRef(0);
  const locked = useParentalLocked();
  const shown = useMemo(() => visibleGuideHits(hits, locked), [hits, locked]);
  const searchable = guideSearchable(debounced);
  const state = matchState(channel, lookup);
  const byHand = state.kind === 'manual' || state.kind === 'manual_empty';

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const current = ++request.current;
    const q = debounced.trim();
    if (!guideSearchable(q)) {
      setHits([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    searchEpgChannels(q)
      .then((answer) => {
        if (current !== request.current) return;
        setHits(answer);
        setSearchError(null);
      })
      .catch((err) => {
        if (current !== request.current) return;
        logger.warn('Failed to search the guide channels:', err);
        setHits([]);
        setSearchError(`Could not search the guide: ${errorText(err)}`);
      })
      .finally(() => {
        if (current === request.current) setSearching(false);
      });
  }, [debounced]);

  const save = async (key: string | null, message: string) => {
    setSaving(true);
    setError(null);
    try {
      await setChannelEpgMatch(channel.id, key);
      onDone(message);
    } catch (err) {
      logger.warn('Failed to set the guide channel:', err);
      setError(
        isAppError(err) && err.code === 'InvalidInput'
          ? err.details
          : `Could not change the guide channel: ${errorText(err)}`
      );
      setSaving(false);
    }
  };

  const inputId = `${id}-query`;
  const errorId = `${id}-error`;
  return (
    <>
      <p className="mb-4 text-sm text-text-muted">Now: {state.text}</p>
      <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-text-muted">
        Search guide channels
      </label>
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Guide channel name or id"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={inputClass}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {searchError && <p className="mb-3 text-sm text-danger">{searchError}</p>}
        {!searchable && (
          <p className="text-sm text-text-muted">
            Type at least {GUIDE_SEARCH_MIN_CHARS} characters of a guide channel's name or id.
          </p>
        )}
        {searching && shown.length === 0 && <p className="text-sm text-text-muted">Searching…</p>}
        {!searching && !searchError && searchable && shown.length === 0 && (
          <p className="text-sm text-text-muted">
            No guide channel with programmes has that in its name or id.
          </p>
        )}
        <ul aria-label="Guide channels" className="flex flex-col gap-2">
          {shown.map((hit) => (
            <li
              key={hit.key}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-text">{hitTitle(hit)}</p>
                <p className="truncate text-xs text-text-muted">{hitDetails(hit)}</p>
              </div>
              <button
                type="button"
                disabled={saving}
                aria-label={`Use ${hitTitle(hit)} (${hit.key})`}
                onClick={() => save(hit.key, `${channel.name} now shows ${hitTitle(hit)}.`)}
                className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Use this
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4 flex justify-between gap-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-text-muted hover:bg-surface-hover"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Your channels
        </button>
        {byHand && (
          <button
            type="button"
            disabled={saving}
            onClick={() => save(null, `${channel.name} is matched automatically again.`)}
            className="rounded-lg bg-surface-2 px-4 py-2 text-text hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Use automatic match
          </button>
        )}
      </div>
    </>
  );
}
