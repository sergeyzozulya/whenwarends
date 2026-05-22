// Faint chart-shaped loading placeholder, shown while a chart island fetches
// its series (/chart-data.json). A rising CDF-like line gently pulses over a
// hairline baseline — on-brand: muted line + accent stroke, no fill, no spinner.
// The pulse animation lives in global.css (.chart-skeleton-line) and is stilled
// under prefers-reduced-motion.

interface ChartSkeletonProps {
  /** Accessible label for the busy region (localized "Loading…"). */
  label?: string;
  /** Height/utility classes so the box matches the real chart's footprint. */
  className?: string;
}

export default function ChartSkeleton({
  label,
  className = '',
}: ChartSkeletonProps) {
  return (
    <div
      role="img"
      aria-label={label}
      aria-busy="true"
      className={`w-full ${className}`}
    >
      <svg
        viewBox="0 0 320 180"
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        <line
          x1="6"
          y1="172"
          x2="314"
          y2="172"
          stroke="var(--color-line)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          className="chart-skeleton-line"
          points="6,158 68,150 130,122 192,84 254,52 314,40"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
