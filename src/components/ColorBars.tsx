const BARS = ['#B9B9B9', '#B9B900', '#00B9B9', '#00B900', '#B900B9', '#B90000', '#0000B9'];

/** Test-card placeholder for a channel or episode without artwork. */
export function ColorBars({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`absolute inset-0 flex items-center justify-center ${className}`}
    >
      <div className="absolute inset-0 flex opacity-[.35]">
        {BARS.map((c) => (
          <div key={c} data-bar className="flex-1" style={{ backgroundColor: c }} />
        ))}
      </div>
      <span className="relative font-display text-4xl font-bold text-[#F2F2F0] [text-shadow:0_2px_12px_rgba(0,0,0,.6)]">
        {label.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}
