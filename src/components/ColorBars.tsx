export const BARS = ['#B9B9B9', '#B9B900', '#00B9B9', '#00B900', '#B900B9', '#B90000', '#0000B9'];

/**
 * The seven bars as one hard-stop gradient. A grid can hold dozens of
 * placeholders (most live channels have no logo), and one element each
 * instead of eight keeps style and layout work down while scrolling.
 */
export const BARS_GRADIENT = `linear-gradient(to right, ${BARS.map((color, i) => {
  const from = ((i * 100) / BARS.length).toFixed(4);
  const to = (((i + 1) * 100) / BARS.length).toFixed(4);
  return `${color} ${from}% ${to}%`;
}).join(', ')})`;

/** Test-card placeholder for a channel or episode without artwork. */
export function ColorBars({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`absolute inset-0 flex items-center justify-center ${className}`}
    >
      <div
        data-bars
        className="absolute inset-0 opacity-[.35]"
        style={{ backgroundImage: BARS_GRADIENT }}
      />
      <span className="relative font-display text-4xl font-bold text-[#F2F2F0] [text-shadow:0_2px_12px_rgba(0,0,0,.6)]">
        {label.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}
