import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ColorBars } from '../../components/ColorBars';

describe('ColorBars', () => {
  it('shows the upper-cased initial over seven bars', () => {
    const { container } = render(<ColorBars label="viaplay" />);
    expect(container.textContent).toBe('V');
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(7);
  });
  it('is hidden from assistive technology', () => {
    const { container } = render(<ColorBars label="x" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
  it('shows nothing for an empty label rather than crashing', () => {
    const { container } = render(<ColorBars label="" />);
    expect(container.textContent).toBe('');
  });
});
