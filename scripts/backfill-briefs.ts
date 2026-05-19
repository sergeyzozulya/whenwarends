// Historical brief backfill (Phase 3). Reconstructs one editorial brief per
// month from the war start (2022-02) through the current month, per
// language, from the archived snapshot data only — never markets.json
// (current-only), never invented numbers. Narrow the range with
// BACKFILL_SINCE=YYYY-MM.
//
// Each row is marked `reconstructed: true`; the UI labels these "reconstructed
// from archived data" so they are never presented as written at the time.
// Status is `published` (owner policy: no human review gate — see
// data/changelog.json and CLAUDE.md). Integrity safeguards from llm.ts apply
// (citation allow-list, refusal/truncation guards).
//
// IDEMPOTENT: a `lang|date` already in data/briefs.json is skipped, so a run
// is resumable and never double-spends the API. Run manually with
// `npm run backfill-briefs` (needs ANTHROPIC_API_KEY). NOT wired into CI.
//
// Node-only. Per-language failure is isolated; exits 1 only if every
// generation attempted failed.

import './loadEnv'; // must be first: populates process.env from .dev.vars
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LANGS, type Lang, type BriefRow } from '../src/lib/types';
import { readBriefs, writeBriefs, readSnapshots } from '../src/lib/filestore';
import { generateBrief } from '../src/lib/llm';
import {
  DATA_SOURCES,
  asOfMetrics,
  formatHistoricalContext,
} from '../src/lib/briefContext';

// Full-scale invasion month — the war start this dashboard tracks. Backfill
// runs from here through the current month. Override with BACKFILL_SINCE
// (YYYY-MM) for a narrower range; the run is idempotent either way, so
// already-generated months are skipped on re-run.
const WAR_START = '2022-02';

function backfillSince(): { y: number; m: number } {
  const raw = process.env.BACKFILL_SINCE?.trim();
  const s = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : WAR_START;
  const [y, m] = s.split('-').map(Number);
  return { y, m: m - 1 }; // m: 0-based month index
}

function glossaryFor(lang: Lang): string {
  try {
    return readFileSync(
      resolve(process.cwd(), 'src/i18n/glossary', `${lang}.yaml`),
      'utf8'
    );
  } catch {
    return '';
  }
}

/**
 * One marker per month from the backfill start (war start by default)
 * through the month containing `now`, oldest-first. `date` is the first of
 * the month (the editorial date stored on the row); `asOf` is the last
 * instant of that month (inclusive upper bound for snapshot reconstruction),
 * clamped so it is never in the future.
 */
function monthlyMarkers(now: Date): { date: string; asOf: string }[] {
  const out: { date: string; asOf: string }[] = [];
  const { y: sy, m: sm } = backfillSince();
  const startIdx = sy * 12 + sm;
  const endIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const y = Math.floor(idx / 12);
    const m = idx % 12;
    const start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0) - 1);
    const asOf = monthEnd < now ? monthEnd : now;
    out.push({
      date: start.toISOString().slice(0, 10),
      asOf: asOf.toISOString(),
    });
  }
  return out;
}

async function main(): Promise<void> {
  const now = new Date();
  const snapshots = readSnapshots();
  const markers = monthlyMarkers(now);

  const existing = readBriefs();
  const byKey = new Map(existing.map((b) => [`${b.lang}|${b.date}`, b]));
  let nextId = existing.reduce((mx, b) => Math.max(mx, b.id), 0) + 1;

  let attempted = 0;
  let ok = 0;
  let skipped = 0;

  for (const { date, asOf } of markers) {
    const context = formatHistoricalContext(asOfMetrics(snapshots, asOf));
    for (const lang of LANGS) {
      const key = `${lang}|${date}`;
      if (byKey.has(key)) {
        skipped++;
        continue;
      }
      attempted++;
      try {
        // Prior month's reconstructed brief (same lang) for tone continuity.
        const prev = [...byKey.values()]
          .filter(
            (b) => b.lang === lang && b.published && b.date < date
          )
          .sort((a, b) => b.date.localeCompare(a.date))[0];

        const { draft, citations } = await generateBrief({
          lang,
          weekOf: date,
          dataContext: context,
          sources: DATA_SOURCES,
          glossary: glossaryFor(lang),
          previousBrief: prev?.published ?? undefined,
        });

        const ts = new Date().toISOString();
        const row: BriefRow = {
          id: nextId++,
          lang,
          date,
          draft,
          published: draft,
          status: 'published',
          created_at: ts,
          reviewed_at: ts,
          citations: JSON.stringify(citations),
          reconstructed: true,
        };
        byKey.set(key, row);
        // Persist after every success: this is paid work — a crash on a
        // later call must not discard earlier briefs, and an interrupted run
        // must be resumable (idempotency keys off what's already on disk).
        writeBriefs([...byKey.values()]);
        ok++;
        console.log(
          `✓ ${date} ${lang}: reconstructed (${citations.length} citations)`
        );
      } catch (err) {
        console.error(
          `✗ ${date} ${lang}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  writeBriefs([...byKey.values()]);
  console.log(
    `\nbackfill-briefs done — ${ok} reconstructed, ${skipped} already present, ` +
      `${attempted - ok} failed`
  );
  if (attempted > 0 && ok === 0) {
    console.error('every attempted reconstruction failed — exiting non-zero');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
