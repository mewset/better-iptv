import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { usePlayerStore } from '../../stores/player-store';
import { stopPlayback } from '../../lib/tauri';
import type { Channel } from '../../types';

vi.mock('../../lib/tauri', () => ({
  stopPlayback: vi.fn(async () => {}),
  playChannel: vi.fn(async () => {}),
}));

const channel = { id: 1, name: 'SVT1', url: 'http://x', content_type: 'live' } as Channel;

function press(key: string, target: globalThis.EventTarget = document.body, init = {}) {
  const event = new globalThis.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function setup(onEscapeView = vi.fn(() => false)) {
  const onToggleGuide = vi.fn();
  const ref = { current: null };
  renderHook(() => useKeyboardShortcuts(ref, { onToggleGuide, onEscapeView }));
  return { onToggleGuide, onEscapeView };
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    vi.mocked(stopPlayback).mockClear();
    usePlayerStore.setState({ isPlaying: true, currentChannel: channel });
    document.body.innerHTML = '';
  });

  it('g toggles the guide', () => {
    const { onToggleGuide } = setup();
    press('g');
    expect(onToggleGuide).toHaveBeenCalledTimes(1);
  });

  it('G (shift) toggles the guide too', () => {
    const { onToggleGuide } = setup();
    press('G', document.body, { shiftKey: true });
    expect(onToggleGuide).toHaveBeenCalledTimes(1);
  });

  it('g typed inside an input does not toggle the guide', () => {
    const { onToggleGuide } = setup();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = press('g', input);
    expect(onToggleGuide).not.toHaveBeenCalled();
    // The character still reaches the field.
    expect(event.defaultPrevented).toBe(false);
  });

  it('g inside a textarea, select or contenteditable does not toggle the guide', () => {
    const { onToggleGuide } = setup();
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not implement isContentEditable.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.append(textarea, select, editable);
    press('g', textarea);
    press('g', select);
    press('g', editable);
    expect(onToggleGuide).not.toHaveBeenCalled();
  });

  it('Ctrl/Meta/Alt+g does not toggle the guide', () => {
    const { onToggleGuide } = setup();
    press('g', document.body, { ctrlKey: true });
    press('g', document.body, { metaKey: true });
    press('g', document.body, { altKey: true });
    expect(onToggleGuide).not.toHaveBeenCalled();
  });

  it('Escape that closes a view does not stop playback', async () => {
    const { onEscapeView } = setup(vi.fn(() => true));
    press('Escape');
    expect(onEscapeView).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(stopPlayback).not.toHaveBeenCalled();
  });

  it('Escape with no view to close stops playback while playing', async () => {
    const { onEscapeView } = setup(vi.fn(() => false));
    press('Escape');
    expect(onEscapeView).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stopPlayback).toHaveBeenCalledTimes(1));
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it('Escape already claimed by another owner (preventDefault) does nothing', async () => {
    const { onEscapeView } = setup(vi.fn(() => true));
    const claim = (e: globalThis.KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', claim, true);
    try {
      press('Escape');
    } finally {
      window.removeEventListener('keydown', claim, true);
    }
    expect(onEscapeView).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(stopPlayback).not.toHaveBeenCalled();
  });
});
