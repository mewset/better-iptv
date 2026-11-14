import { StrictMode, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfirmationModal from '../../components/modals/ConfirmationModal';
import ErrorModal from '../../components/modals/ErrorModal';
import PinEntryModal from '../../components/modals/PinEntryModal';
import RefreshModal from '../../components/modals/RefreshModal';
import ChannelBlockingModal from '../../components/modals/ChannelBlockingModal';
import { refreshPlaylist } from '../../lib/tauri';
import type { MergeResult } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../../lib/tauri', () => ({
  refreshPlaylist: vi.fn(),
  setParentalPin: vi.fn(async () => {}),
  verifyParentalPin: vi.fn(async () => true),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}));

/** A page with one button that opens the dialog under test, as its hosts do. */
function Host({ children }: { children: (isOpen: boolean, close: () => void) => React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button onClick={() => setIsOpen(true)}>Open</button>
      {children(isOpen, () => setIsOpen(false))}
    </>
  );
}

function openDialog() {
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const pressTab = (shiftKey = false) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey });

describe('useModalDialog, through the dialogs that use it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moves the focus into the dialog, names it by its title and hands the focus back', () => {
    const onConfirm = vi.fn();
    render(
      <Host>
        {(isOpen, close) => (
          <ConfirmationModal
            isOpen={isOpen}
            onClose={close}
            onConfirm={onConfirm}
            title="Delete Profile?"
            message="This cannot be undone."
            confirmText="Delete"
          />
        )}
      </Host>
    );
    const opener = openDialog();

    const dialog = screen.getByRole('dialog', { name: 'Delete Profile?' });
    // On the dialog, not on a button: Enter must not confirm by accident.
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog, in both directions', () => {
    render(
      <Host>
        {(isOpen, close) => (
          <ConfirmationModal
            isOpen={isOpen}
            onClose={close}
            onConfirm={vi.fn()}
            title="Discard changes?"
            message="You have unsaved settings."
            confirmText="Discard"
            cancelText="Keep editing"
          />
        )}
      </Host>
    );
    openDialog();
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Discard' });

    // From the dialog itself, Shift+Tab goes to the last control, not out.
    pressTab(true);
    expect(document.activeElement).toBe(last);
    pressTab();
    expect(document.activeElement).toBe(first);
    pressTab(true);
    expect(document.activeElement).toBe(last);

    // In the middle the browser moves the focus; the dialog leaves the key alone.
    const middle = screen.getByRole('button', { name: 'Keep editing' });
    middle.focus();
    expect(fireEvent.keyDown(middle, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(middle);
  });

  it('marks its Escape as taken, so nothing behind the dialog acts on it', () => {
    render(
      <Host>
        {(isOpen, close) => (
          <ErrorModal isOpen={isOpen} onClose={close} title="Failed to Save" message="Busy." />
        )}
      </Host>
    );
    openDialog();
    const dialog = screen.getByRole('dialog', { name: 'Failed to Save' });

    // fireEvent returns false when the event was preventDefault-ed.
    expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('only the topmost of two dialogs answers Escape', () => {
    const closeUnder = vi.fn();
    const closeTop = vi.fn();
    render(
      <>
        <ConfirmationModal
          isOpen
          onClose={closeUnder}
          onConfirm={vi.fn()}
          title="Under"
          message="First."
        />
        <ErrorModal isOpen onClose={closeTop} title="On top" message="Second." />
      </>
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(closeTop).toHaveBeenCalledTimes(1);
    expect(closeUnder).not.toHaveBeenCalled();
  });

  it('Escape waits while the refresh is running, and closes once it is done', async () => {
    let finish: (r: MergeResult) => void = () => {};
    vi.mocked(refreshPlaylist).mockImplementation(
      () => new Promise<MergeResult>((resolve) => (finish = resolve))
    );
    const onClose = vi.fn();
    render(<RefreshModal isOpen onClose={onClose} playlistId={1} playlistName="Home" />);
    const dialog = screen.getByRole('dialog', { name: 'Refreshing Playlist' });

    expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    finish({ added: 1, updated: 0, removed: 0 } as MergeResult);
    await screen.findByText('Refresh complete');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves the focus with the PIN field that asked for it, under StrictMode too', async () => {
    render(
      <StrictMode>
        <Host>
          {(isOpen, close) => (
            <PinEntryModal isOpen={isOpen} onClose={close} onSuccess={vi.fn()} mode="verify" />
          )}
        </Host>
      </StrictMode>
    );
    const opener = openDialog();

    const pin = screen.getByLabelText('PIN');
    await waitFor(() => expect(document.activeElement).toBe(pin));
    expect(screen.getByRole('dialog', { name: 'Enter PIN' })).toBeInTheDocument();

    fireEvent.keyDown(pin, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape cancels the block list without handing anything to its host', () => {
    const onUpdate = vi.fn();
    render(
      <Host>
        {(isOpen, close) => (
          <ChannelBlockingModal
            isOpen={isOpen}
            onClose={close}
            channels={[]}
            initialBlockedIds={new Set()}
            onUpdate={onUpdate}
          />
        )}
      </Host>
    );
    const opener = openDialog();
    const dialog = screen.getByRole('dialog', { name: 'Block Channels' });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(screen.getByPlaceholderText('Search channels...'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });
});
