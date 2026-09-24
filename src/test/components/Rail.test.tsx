import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Rail } from '../../components/Rail';

const base = {
  section: 'live' as const,
  onSection: vi.fn(),
  view: 'browse' as const,
  onSettings: vi.fn(),
  profileInitial: 'H',
  onProfile: vi.fn(),
};

describe('Rail', () => {
  it('marks the active section for assistive technology', () => {
    render(<Rail {...base} />);
    expect(screen.getByRole('button', { name: 'Live TV' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Movies' })).not.toHaveAttribute('aria-current');
  });

  it('switches section', () => {
    const onSection = vi.fn();
    render(<Rail {...base} onSection={onSection} />);
    fireEvent.click(screen.getByRole('button', { name: 'TV Guide' }));
    expect(onSection).toHaveBeenCalledWith('guide');
  });

  it('opens settings', () => {
    const onSettings = vi.fn();
    render(<Rail {...base} onSettings={onSettings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onSettings).toHaveBeenCalled();
  });

  it('marks Settings, not the section, as current while the settings view is open', () => {
    render(<Rail {...base} view="settings" />);
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('button', { name: 'Live TV' })).not.toHaveAttribute('aria-current');
  });

  it('shows the profile initial on the profile button and opens the switcher', () => {
    const onProfile = vi.fn();
    render(<Rail {...base} profileInitial="C" onProfile={onProfile} />);
    const button = screen.getByRole('button', { name: 'Switch profile' });
    expect(button).toHaveTextContent('C');
    fireEvent.click(button);
    expect(onProfile).toHaveBeenCalled();
  });

  it('lists the five sections in rail order inside a Sections landmark', () => {
    render(<Rail {...base} />);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const names = Array.from(nav.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label')
    );
    expect(names).toEqual([
      'Live TV',
      'Movies',
      'Series',
      'Favorites',
      'TV Guide',
      'Settings',
      'Switch profile',
    ]);
  });
});
