import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Toast } from '../../components/Toast';
import { usePlayerStore } from '../../stores/player-store';

describe('Toast', () => {
  beforeEach(() => usePlayerStore.setState({ toast: null }));

  it('renders nothing without a toast', () => {
    const { container } = render(<Toast />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces the message politely and can be dismissed', () => {
    usePlayerStore.getState().showToast("Couldn't play SVT1.");
    render(<Toast />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent("Couldn't play SVT1.");
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(usePlayerStore.getState().toast).toBeNull();
  });

  it('dismisses itself after six seconds', () => {
    vi.useFakeTimers();
    try {
      usePlayerStore.getState().showToast('Temporary');
      render(<Toast />);
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(usePlayerStore.getState().toast).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
