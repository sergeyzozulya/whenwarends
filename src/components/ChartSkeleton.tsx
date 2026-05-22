// Chart loading placeholder, shown while a chart island fetches its series
// (/chart-data.json). A sparkline-style accent line — matching the site's mini
// charts — flows leftward in a seamless loop (two identical tiles translated by
// one tile). Styling + keyframe live in global.css; stilled under
// prefers-reduced-motion.

// One tile of an irregular, sparkline-like wave over x 0..100. The first and
// last y match (28) so tiles join smoothly when repeated and flowed.
const TILE: [number, number][] = [
  [0, 28],
  [12, 20],
  [25, 31],
  [38, 12],
  [50, 22],
  [62, 8],
  [75, 27],
  [88, 16],
  [100, 28],
];

// Two tiles across x 0..200; translating the SVG by -50% advances exactly one
// tile, so the wrap-around is invisible.
const POINTS = [
  ...TILE,
  ...TILE.map(([x, y]) => [x + 100, y] as [number, number]),
]
  .map(([x, y]) => `${x},${y}`)
  .join(' ');

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
      className={`flex w-full items-center justify-center ${className}`}
    >
      <div className="chart-skeleton-line-wrap">
        <svg
          className="chart-skeleton-line"
          viewBox="0 0 200 40"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline points={POINTS} />
        </svg>
      </div>
    </div>
  );
}
