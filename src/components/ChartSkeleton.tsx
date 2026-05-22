// Chart loading placeholder, shown while a chart island fetches its series
// (/chart-data.json). A dense, sparkline-style accent waveform that flows
// leftward in a seamless loop and fades out at the left/right edges. Two
// identical tiles (x 0..100 and 100..200) translated by one tile, so the
// wrap-around is invisible. Styling, the flow keyframe, and the edge-fade mask
// live in global.css; stilled under prefers-reduced-motion.
//
// The points are precomputed/hardcoded (not generated at render) so the
// server and client markup are byte-identical — no hydration mismatch.

const POINTS =
  '0,4 1.56,33 3.13,6 4.69,22 6.25,16 7.81,19 9.38,24 10.94,9 12.5,15 14.06,21 15.63,35 17.19,30 18.75,10 20.31,36 21.88,30 23.44,18 25,34 26.56,18 28.13,25 29.69,14 31.25,28 32.81,22 34.38,25 35.94,17 37.5,8 39.06,15 40.63,20 42.19,4 43.75,9 45.31,17 46.88,36 48.44,27 50,13 51.56,17 53.13,10 54.69,22 56.25,35 57.81,33 59.38,19 60.94,29 62.5,23 64.06,34 65.63,18 67.19,11 68.75,26 70.31,29 71.88,13 73.44,20 75,9 76.56,8 78.13,14 79.69,8 81.25,30 82.81,22 84.38,17 85.94,32 87.5,19 89.06,11 90.63,14 92.19,10 93.75,9 95.31,7 96.88,30 98.44,5 100,4 100,4 101.56,33 103.13,6 104.69,22 106.25,16 107.81,19 109.38,24 110.94,9 112.5,15 114.06,21 115.63,35 117.19,30 118.75,10 120.31,36 121.88,30 123.44,18 125,34 126.56,18 128.13,25 129.69,14 131.25,28 132.81,22 134.38,25 135.94,17 137.5,8 139.06,15 140.63,20 142.19,4 143.75,9 145.31,17 146.88,36 148.44,27 150,13 151.56,17 153.13,10 154.69,22 156.25,35 157.81,33 159.38,19 160.94,29 162.5,23 164.06,34 165.63,18 167.19,11 168.75,26 170.31,29 171.88,13 173.44,20 175,9 176.56,8 178.13,14 179.69,8 181.25,30 182.81,22 184.38,17 185.94,32 187.5,19 189.06,11 190.63,14 192.19,10 193.75,9 195.31,7 196.88,30 198.44,5 200,4';

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
