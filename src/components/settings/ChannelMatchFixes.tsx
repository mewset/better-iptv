import { useMemo, useState } from 'react';
import { Wrench } from 'lucide-react';
import { setChannelEpgMatch, type ManualMatch } from '../../lib/epgIpc';
import { manualTarget, matchLookup } from '../../lib/epgMatchView';
import { errorText } from '../../lib/epgSourceView';
import { useMatchDetails } from '../../hooks/useMatchDetails';
import { useParentalHiding } from '../../hooks/useParentalHiding';
import { usePlayerStore } from '../../stores/player-store';
import { logger } from '../../lib/logger';
import GuideChannelPicker from './GuideChannelPicker';

interface ChannelMatchFixesProps {
  /** The active profile's playlist; nothing is shown without one. */
  playlistId: number | undefined;
  /** The profile has a guide to match against (`EpgStatus.matches` is not null). */
  hasGuide: boolean;
}

/**
 * Under the "Channel matching" line: the button that opens the picker, and
 * the channels matched by hand, each with a Clear that gives it back to the
 * automatic matching.
 */
export default function ChannelMatchFixes({ playlistId, hasGuide }: ChannelMatchFixesProps) {
  const { details, reload } = useMatchDetails(playlistId);
  const lookup = useMemo(() => (details ? matchLookup(details) : null), [details]);
  const manual = useVisibleManualMatches(details?.manual);
  const [picking, setPicking] = useState(false);

  if (playlistId === undefined) return null;
  return (
    <div className="mt-3 space-y-4">
      <button
        type="button"
        onClick={() => setPicking(true)}
        disabled={!hasGuide}
        className="flex items-center gap-2 rounded-lg bg-surface-2 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
        Fix a channel…
      </button>
      {manual.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-text-muted">Set by hand</h4>
          <ul aria-label="Channels set by hand" className="space-y-2">
            {manual.map((match) => (
              <ManualRow key={match.channel_id} match={match} onCleared={reload} />
            ))}
          </ul>
        </div>
      )}
      <GuideChannelPicker
        isOpen={picking}
        onClose={() => setPicking(false)}
        lookup={lookup}
        onChanged={reload}
      />
    </div>
  );
}

/**
 * The matches set by hand, without the channels parental controls hide from
 * the channel list. A match carries no group, so it is taken from the live
 * channel it names.
 */
function useVisibleManualMatches(manual: ManualMatch[] | undefined): ManualMatch[] {
  const liveChannels = usePlayerStore((s) => s.liveChannels);
  const hidden = useParentalHiding();
  return useMemo(() => {
    if (!manual) return [];
    if (!hidden) return manual;
    const groups = new Map(liveChannels.map((c) => [c.id, c.group_name]));
    return manual.filter(
      (m) =>
        !hidden({ id: m.channel_id, name: m.channel_name, group_name: groups.get(m.channel_id) })
    );
  }, [manual, hidden, liveChannels]);
}

function ManualRow({ match, onCleared }: { match: ManualMatch; onCleared: () => void }) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = async () => {
    setClearing(true);
    setError(null);
    try {
      await setChannelEpgMatch(match.channel_id, null);
      onCleared();
    } catch (err) {
      logger.warn('Failed to clear a manual guide match:', err);
      setError(`Could not clear it: ${errorText(err)}`);
      setClearing(false);
    }
  };

  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-sm text-text">
          {match.channel_name}
          <span className="text-text-muted"> → </span>
          <span className={match.has_programmes ? 'text-text' : 'text-text-muted'}>
            {manualTarget(match)}
          </span>
        </p>
        <button
          type="button"
          onClick={clear}
          disabled={clearing}
          aria-label={`Clear the match of ${match.channel_name}`}
          className="shrink-0 rounded px-2 py-1 text-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
