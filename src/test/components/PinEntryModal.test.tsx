import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PinEntryModal from '../../components/modals/PinEntryModal';
import { setParentalPin, verifyParentalPin } from '../../lib/tauri';

vi.mock('../../lib/tauri', () => ({
  setParentalPin: vi.fn(async () => {}),
  verifyParentalPin: vi.fn(async () => true),
}));

function renderModal(mode: 'set' | 'change' | 'verify') {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  render(<PinEntryModal isOpen onClose={onClose} onSuccess={onSuccess} mode={mode} />);
  return { onSuccess, onClose };
}

/** What Enter in a field does: submit the form the field belongs to. */
function pressEnterIn(field: globalThis.HTMLElement) {
  const form = field.closest('form');
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
}

describe('PinEntryModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyParentalPin).mockImplementation(async () => true);
  });

  it('Enter in the PIN field unlocks', async () => {
    const { onSuccess, onClose } = renderModal('verify');
    const pin = screen.getByPlaceholderText('Enter PIN');
    fireEvent.change(pin, { target: { value: '1234' } });

    pressEnterIn(pin);

    await waitFor(() => expect(verifyParentalPin).toHaveBeenCalledWith('1234'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter in the last field sets the PIN', async () => {
    const { onSuccess } = renderModal('set');
    fireEvent.change(screen.getByPlaceholderText('Enter new PIN'), { target: { value: '4321' } });
    const confirm = screen.getByPlaceholderText('Confirm PIN');
    fireEvent.change(confirm, { target: { value: '4321' } });

    pressEnterIn(confirm);

    await waitFor(() => expect(setParentalPin).toHaveBeenCalledWith('4321'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('Enter does nothing while the button is disabled', async () => {
    renderModal('verify');
    const pin = screen.getByPlaceholderText('Enter PIN');
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();

    pressEnterIn(pin);

    await new Promise((r) => setTimeout(r, 20));
    expect(verifyParentalPin).not.toHaveBeenCalled();
  });

  it('only the confirming button submits', () => {
    renderModal('verify');
    expect(screen.getByRole('button', { name: 'Unlock' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('type', 'button');
  });

  it("shows the backend's sentence when the PIN could not be checked", async () => {
    vi.mocked(verifyParentalPin).mockRejectedValueOnce({
      code: 'Database',
      details: 'database is locked',
    });
    const { onSuccess } = renderModal('verify');
    const pin = screen.getByPlaceholderText('Enter PIN');
    fireEvent.change(pin, { target: { value: '1234' } });

    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
