import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { usePlayerStore } from '../../stores/player-store';
import { playChannel, stopPlayback } from '../../lib/tauri';
import type { Channel } from '../../types';

vi.mock('../../lib/tauri', () => ({
  stopPlayback: vi.fn(async () => {}),
  playChannel: vi.fn(async () => {}),
}));

const channel = { id: 1, name: 'SVT1', content_type: 'live' } as Channel;

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

  it('no shortcut acts while an aria-modal dialog is open', async () => {
    const onToggleGuide = vi.fn();
    const onEscapeView = vi.fn(() => true);
    const onSearchUnavailable = vi.fn();
    const search = document.createElement('input');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(search, dialog);
    renderHook(() =>
      useKeyboardShortcuts(
        { current: search },
        { onToggleGuide, onEscapeView, onSearchUnavailable }
      )
    );

    press('g');
    press('G', document.body, { shiftKey: true });
    press('Escape');
    const space = press(' ', dialog);
    const slash = press('/', dialog);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onToggleGuide).not.toHaveBeenCalled();
    expect(onEscapeView).not.toHaveBeenCalled();
    expect(onSearchUnavailable).not.toHaveBeenCalled();
    expect(stopPlayback).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(search).not.toHaveFocus();
    // The keys are the dialog's: nothing here swallowed them.
    expect(space.defaultPrevented).toBe(false);
    expect(slash.defaultPrevented).toBe(false);
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
    expect(usePlayerStore.getState().currentChannel).toBeNull();
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

  it('Space stops playback when the focus is on nothing that uses the key', async () => {
    setup();
    const event = press(' ');
    // Keeps the page from scrolling.
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(stopPlayback).toHaveBeenCalledTimes(1));
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().currentChannel).toBeNull();
  });

  it('Space starts nothing: it only stops what is playing', async () => {
    usePlayerStore.setState({ isPlaying: false, currentChannel: channel });
    setup();
    const event = press(' ');
    expect(event.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(playChannel).not.toHaveBeenCalled();
    expect(stopPlayback).not.toHaveBeenCalled();
  });

  it('Space on a button, link or tab is left to that control', async () => {
    setup();
    document.body.innerHTML = `
      <button type="button" id="play"><span id="icon"></span></button>
      <a href="#x" id="link">link</a>
      <div role="tab" tabindex="0" id="tab">tab</div>`;

    for (const id of ['play', 'icon', 'link', 'tab']) {
      const event = press(' ', document.getElementById(id)!);
      // Not prevented: the browser goes on to press the control.
      expect(event.defaultPrevented, id).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopPlayback).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it('Space on a focused container that is not a control still toggles playback', async () => {
    setup();
    document.body.innerHTML = '<div role="grid" tabindex="0" id="grid"></div>';
    press(' ', document.getElementById('grid')!);
    await waitFor(() => expect(stopPlayback).toHaveBeenCalledTimes(1));
  });

  it('calls onSearchUnavailable for "/" when there is no search box', () => {
    const onSearchUnavailable = vi.fn();
    const ref = { current: null };
    renderHook(() => useKeyboardShortcuts(ref, { onSearchUnavailable }));
    press('/');
    expect(onSearchUnavailable).toHaveBeenCalledTimes(1);
  });
});
