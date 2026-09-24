import { memo } from 'react';
import {
  CalendarRange,
  Clapperboard,
  Film,
  Settings as SettingsIcon,
  Star,
  Tv,
  type LucideIcon,
} from 'lucide-react';
import type { Section } from '../stores/player-store';
import logoImage from '../assets/logo/logo-256.webp';

interface RailProps {
  section: Section;
  onSection: (s: Section) => void;
  view: 'browse' | 'settings';
  onSettings: () => void;
  profileInitial: string;
  onProfile: () => void;
  /** Lets MainScreen return focus to the avatar when the menu it opened closes. */
  profileButtonRef?: React.Ref<globalThis.HTMLButtonElement>;
}

const SECTIONS: Array<{ value: Section; label: string; Icon: LucideIcon }> = [
  { value: 'live', label: 'Live TV', Icon: Tv },
  { value: 'vod', label: 'Movies', Icon: Film },
  { value: 'series', label: 'Series', Icon: Clapperboard },
  { value: 'favorites', label: 'Favorites', Icon: Star },
  { value: 'guide', label: 'TV Guide', Icon: CalendarRange },
];

interface RailButtonProps {
  label: string;
  Icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}

function RailButton({ label, Icon, active, onClick }: RailButtonProps) {
  // The wrapper spans the rail's full width so the active bar sits on the
  // rail's left edge, not the button's.
  return (
    <div className="relative flex w-full justify-center">
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-y-2.5 left-0 w-[3px] rounded-r bg-accent"
        />
      )}
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        aria-current={active ? 'page' : undefined}
        className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          active ? 'bg-text/5 text-accent-text' : 'text-text-faint hover:text-text'
        }`}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The left icon rail: the five sections, Settings and the profile avatar.
 * Sections are plain buttons with `aria-current="page"` on the active one;
 * number keys are deliberately not bound (kept free for a later TV mode).
 */
export const Rail = memo(function Rail({
  section,
  onSection,
  view,
  onSettings,
  profileInitial,
  onProfile,
  profileButtonRef,
}: RailProps) {
  return (
    <nav
      aria-label="Sections"
      className="flex h-full w-[72px] shrink-0 flex-col items-center gap-2 border-r border-border bg-surface py-4"
    >
      <img
        src={logoImage}
        alt="Better IPTV"
        width={36}
        height={36}
        className="mb-4 h-9 w-9 rounded-[10px]"
      />
      {SECTIONS.map(({ value, label, Icon }) => (
        <RailButton
          key={value}
          label={label}
          Icon={Icon}
          active={view === 'browse' && section === value}
          onClick={() => onSection(value)}
        />
      ))}
      <div className="flex-1" />
      <RailButton
        label="Settings"
        Icon={SettingsIcon}
        active={view === 'settings'}
        onClick={onSettings}
      />
      <button
        type="button"
        ref={profileButtonRef}
        onClick={onProfile}
        aria-label="Switch profile"
        title="Switch profile"
        className="mt-2 flex h-9 w-9 items-center justify-center rounded-full border border-border-strong bg-surface-2 text-sm font-semibold text-text transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {profileInitial}
      </button>
    </nav>
  );
});

export default Rail;
