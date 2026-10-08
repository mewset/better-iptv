import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BARS, BARS_GRADIENT, ColorBars } from '../../components/ColorBars';

describe('ColorBars', () => {
  it('shows the upper-cased initial over the bars', () => {
    const { container } = render(<ColorBars label="viaplay" />);
    expect(container.textContent).toBe('V');
    expect(container.querySelectorAll('[data-bars]')).toHaveLength(1);
  });
  it('paints the seven bars as equal hard-stop bands, in order', () => {
    const stops = [...BARS_GRADIENT.matchAll(/(#[0-9A-F]{6}) ([\d.]+)% ([\d.]+)%/g)];
    expect(stops.map((m) => m[1])).toEqual(BARS);
    stops.forEach((m, i) => {
      expect(Number(m[2])).toBeCloseTo((i * 100) / 7, 3);
      expect(Number(m[3])).toBeCloseTo(((i + 1) * 100) / 7, 3);
    });
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
