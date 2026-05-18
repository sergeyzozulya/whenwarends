// Performance budget gate (SPEC §11): the homepage must be under 250 KB
// gzipped, excluding the lazy-loaded chart JS. Run after `npm run build`
// (wired into CI). Exits non-zero if the budget is exceeded.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 250 * 1024;
const DIST = resolve(process.cwd(), 'dist');
const HOMEPAGE = join(DIST, 'en', 'index.html'); // locale bundles are split; en is representative

// Chart JS is lazy-loaded and explicitly excluded from the budget.
const isChartAsset = (p: string) => /chart|herochart/i.test(p);

function gz(bytes: Buffer): number {
  return gzipSync(bytes).length;
}

function main(): void {
  if (!existsSync(HOMEPAGE)) {
    console.error(`check-bundle: ${HOMEPAGE} not found — run \`npm run build\` first.`);
    process.exit(1);
  }

  const html = readFileSync(HOMEPAGE);
  const htmlStr = html.toString('utf8');

  // Referenced first-party assets (/_astro/*.{js,css}).
  const refs = [...htmlStr.matchAll(/\/_astro\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map(
    (m) => m[0]
  );
  const unique = [...new Set(refs)];

  const rows: { asset: string; gzip: number; counted: boolean }[] = [];
  let total = gz(html);
  rows.push({ asset: 'en/index.html', gzip: gz(html), counted: true });

  for (const ref of unique) {
    const file = join(DIST, ref.replace(/^\//, ''));
    if (!existsSync(file)) continue;
    const size = gz(readFileSync(file));
    const counted = !isChartAsset(ref);
    if (counted) total += size;
    rows.push({ asset: ref, gzip: size, counted });
  }

  rows.sort((a, b) => b.gzip - a.gzip);
  for (const r of rows) {
    console.log(
      `${r.counted ? ' ' : '~'} ${(r.gzip / 1024).toFixed(1).padStart(7)} KB  ${r.asset}` +
        (r.counted ? '' : '  (chart — excluded)')
    );
  }
  console.log(
    `\nHomepage gzipped (excl. chart JS): ${(total / 1024).toFixed(1)} KB / ${(BUDGET_BYTES / 1024).toFixed(0)} KB budget`
  );

  if (total > BUDGET_BYTES) {
    console.error('perf budget EXCEEDED');
    process.exit(1);
  }
  console.log('perf budget OK');
}

main();
