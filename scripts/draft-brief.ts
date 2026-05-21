// Editorial brief generation (Phase 3). Reads the current data files, asks
// Claude to draft one brief per language, and AUTO-PUBLISHES each directly to
// data/briefs.json (status `published`).
//
// Editorial policy (owner decision, 2026-05-18; see data/changelog.json and
// CLAUDE.md): there is NO human review gate. The integrity safeguards in
// llm.ts remain load-bearing and are what makes this safe enough to ship
// unattended — enforced citation allow-list, refusal + truncation guards, and
// per-language isolation: a language whose generation throws is simply not
// (re)published, so a prior good brief for that language stays live rather
// than being overwritten with garbage. The git commit is the audit trail.
//
// Node-only. Run locally with `npm run draft-brief` (needs ANTHROPIC_API_KEY);
// runs in CI right after data collection. Per-language failure is isolated:
// one language failing does not block the others; exits 1 only if every
// language failed.

import './loadEnv'; // must be first: populates process.env from .dev.vars
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LANGS,
  type Lang,
  type Citation,
  type BriefRow,
  type SnapshotRow,
  type NewsItem,
} from '../src/lib/types';
import {
  readBriefs,
  writeBriefs,
  readSnapshots,
  readNews,
} from '../src/lib/filestore';
import { loadHomePayload } from '../src/lib/homepage';
import { generateBrief } from '../src/lib/llm';
import { DATA_SOURCES } from '../src/lib/briefContext';
import { isEntrypoint } from './isEntrypoint';

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

// --- Snapshot-derived movement ---------------------------------------------
// The brief must describe what the data DID this week, not just recite current
// levels (a flat "list of numbers" reads as content-free). We pull the real
// time series from snapshots.ndjson and compute current vs ~1 week and ~1 month
// earlier, so the model has movement and direction to write about. Missing or
// stale series are stated plainly — never invented.

interface Pt {
  ts: string;
  v: number;
}

const DAY_MS = 86_400_000;

function seriesOf(rows: SnapshotRow[], metric: string, source: string): Pt[] {
  return rows
    .filter((r) => r.metric === metric && r.source === source && r.value !== null)
    .map((r) => ({ ts: r.ts, v: r.value as number }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Latest point at or before (latest ts − daysBack); null if none old enough. */
function asOfDaysBack(pts: Pt[], daysBack: number): Pt | null {
  if (pts.length === 0) return null;
  const cutoffMs = Date.parse(pts[pts.length - 1].ts) - daysBack * DAY_MS;
  let best: Pt | null = null;
  for (const p of pts) if (Date.parse(p.ts) <= cutoffMs) best = p;
  return best;
}

/** Sum of values in the window (latest − fromDays, latest − toDays]. */
function sumWindow(pts: Pt[], fromDays: number, toDays: number): number {
  if (pts.length === 0) return 0;
  const latestMs = Date.parse(pts[pts.length - 1].ts);
  const lo = latestMs - fromDays * DAY_MS;
  const hi = latestMs - toDays * DAY_MS;
  let s = 0;
  for (const p of pts) {
    const t = Date.parse(p.ts);
    if (t > lo && t <= hi) s += p.v;
  }
  return s;
}

/** Distinct-day count of points in the window (latest − fromDays, latest − toDays]. */
function daysCovered(pts: Pt[], fromDays: number, toDays: number): number {
  if (pts.length === 0) return 0;
  const latestMs = Date.parse(pts[pts.length - 1].ts);
  const lo = latestMs - fromDays * DAY_MS;
  const hi = latestMs - toDays * DAY_MS;
  const days = new Set<string>();
  for (const p of pts) {
    const t = Date.parse(p.ts);
    if (t > lo && t <= hi) days.add(p.ts.slice(0, 10));
  }
  return days.size;
}

// Comparisons are labelled with each point's ACTUAL date, not an assumed
// interval: series have different cadences (daily FX/intensity, monthly aid/CPI,
// quarterly GDP) and can have collection gaps, so "one week earlier" would lie
// for a monthly series or a gappy one. We pick the nearest earlier reading at
// ~1 week and ~1 month back and let the date speak for the actual span.
function trendLine(
  label: string,
  pts: Pt[],
  fmt: (n: number) => string,
  note = ''
): string | null {
  if (pts.length === 0) return null;
  const now = pts[pts.length - 1];
  const wk = asOfDaysBack(pts, 7);
  const mo = asOfDaysBack(pts, 30);
  const cmp: string[] = [];
  if (wk && wk.ts !== now.ts) cmp.push(`${fmt(wk.v)} on ${wk.ts.slice(0, 10)}`);
  if (mo && mo.ts !== now.ts && (!wk || mo.ts !== wk.ts))
    cmp.push(`${fmt(mo.v)} on ${mo.ts.slice(0, 10)}`);
  let line = `${label}: ${fmt(now.v)} (latest, ${now.ts.slice(0, 10)})`;
  if (cmp.length) line += `; earlier ${cmp.join(', ')}`;
  line += note ? `. ${note}` : '.';
  return line;
}

function buildDataContext(): string {
  const rows = readSnapshots();
  // Current market state + consensus come pre-derived from the payload.
  const p = loadHomePayload('en');
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const eur0 = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });

  const lines: string[] = [
    'Convention: FX is quoted as local currency per USD, so a higher number means a weaker local currency. Each line gives the latest archived value with its date; "earlier" figures are the nearest archived readings roughly one week and one month before, each labelled with its actual date — series have different update cadences (daily, monthly, quarterly), so trust the dates, not the rough interval.',
    '',
    'Forecast markets (war-end probability):',
  ];

  for (const source of ['polymarket', 'manifold'] as const) {
    const s = seriesOf(rows, 'war_end_probability', source);
    if (s.length === 0) {
      lines.push(`  - ${source}: no probability tracked.`);
      continue;
    }
    const now = s[s.length - 1];
    const first = s[0];
    const span = Math.round((Date.parse(now.ts) - Date.parse(first.ts)) / DAY_MS);
    const movement =
      s.length > 1 && first.ts !== now.ts
        ? ` (first tracked ${first.ts.slice(0, 10)} at ${pct(first.v)}; ${span} days of history)`
        : ' (single observation, no history yet)';
    lines.push(`  - ${source}: ${pct(now.v)}${movement}.`);
  }

  if (p.consensus) {
    lines.push(
      `Cross-source consensus: probability ${pct(p.consensus.probability)}, centroid war-end date ${p.consensus.dateMs ? new Date(p.consensus.dateMs).toISOString().slice(0, 10) : 'n/a'}. The two venues are tracked over only a few days, so day-to-day market moves are not yet meaningful.`
    );
  }
  lines.push(
    p.hero.median
      ? `Median market-implied war-end date: ${p.hero.median.slice(0, 10)}.`
      : 'No market crosses 50% probability, so a median war-end date is not computable.'
  );

  lines.push('', 'On the ground and macro (with movement):');
  const macro: (string | null)[] = [
    trendLine(
      'Conflict intensity (GDELT news-volume index)',
      seriesOf(rows, 'conflict_intensity', 'gdelt'),
      (v) => v.toFixed(2)
    ),
    (() => {
      const fire = seriesOf(rows, 'fire_anomalies', 'firms');
      if (fire.length === 0) return null;
      const latest = fire[fire.length - 1];
      const latestDate = latest.ts.slice(0, 10);
      // A week-over-week sum is only honest if both windows are actually
      // covered. FIRMS has had multi-month collection gaps, so a "surge" can be
      // a gap artifact, not real activity. Require ≥4 covered days in each week.
      const covLast = daysCovered(fire, 7, 0);
      const covPrev = daysCovered(fire, 14, 7);
      if (covLast >= 4 && covPrev >= 4) {
        return `Fire/heat anomalies along the front (NASA FIRMS, daily detections): ${Math.round(sumWindow(fire, 7, 0))} over the last 7 days, vs ${Math.round(sumWindow(fire, 14, 7))} the prior 7 days (latest ${latestDate}).`;
      }
      return `Fire/heat anomalies along the front (NASA FIRMS): ${Math.round(latest.v)} detections on ${latestDate}. The daily series is sparse around now (only ${covLast + covPrev} of the last 14 days reported, after earlier collection gaps), so a week-over-week comparison is NOT reliable — do not describe a surge or decline.`;
    })(),
    trendLine(
      'RUB per USD (Central Bank of Russia)',
      seriesOf(rows, 'rub_usd_rate', 'cbr'),
      (v) => v.toFixed(2)
    ),
    trendLine(
      'UAH per USD (National Bank of Ukraine)',
      seriesOf(rows, 'uah_usd_rate', 'nbu'),
      (v) => v.toFixed(2)
    ),
    trendLine(
      'Cumulative aid allocated to Ukraine (Kiel Institute)',
      seriesOf(rows, 'aid_allocated_cumulative_eur', 'kiel'),
      (v) => eur0.format(v)
    ),
    trendLine(
      'Russia CPI, year-on-year (World Bank)',
      seriesOf(rows, 'ru_cpi_yoy', 'worldbank'),
      (v) => `${v.toFixed(1)}%`
    ),
    trendLine(
      'Ukraine CPI, year-on-year (National Bank of Ukraine)',
      seriesOf(rows, 'ua_cpi_yoy', 'nbu'),
      (v) => `${v.toFixed(1)}%`
    ),
    trendLine(
      'Russia real GDP, year-on-year (World Bank)',
      seriesOf(rows, 'ru_gdp_yoy', 'worldbank'),
      (v) => `${v.toFixed(1)}%`
    ),
    trendLine(
      'Ukraine real GDP, year-on-year (World Bank)',
      seriesOf(rows, 'ua_gdp_yoy', 'worldbank'),
      (v) => `${v.toFixed(1)}%`
    ),
  ];
  // Oryx equipment losses are deliberately excluded: the series is months
  // stale (not "this week") and Oryx is not in the citation allow-list, so a
  // losses claim could not be sourced. Add it to DATA_SOURCES first if needed.
  for (const line of macro) if (line) lines.push(line);

  if (p.events.length) {
    lines.push('', 'Recent dated events:');
    for (const e of p.events) {
      const shift =
        e.shift_months == null || e.shift_months === 0
          ? 'no measurable shift'
          : `${e.shift_months > 0 ? 'pushed later' : 'pulled earlier'} ~${Math.abs(e.shift_months)} months`;
      lines.push(`  - ${e.date}: ${e.description_en} (${shift}).`);
    }
  } else {
    lines.push('', 'No editorial events recorded this period.');
  }
  return lines.join('\n');
}

function eventSources(): Citation[] {
  const p = loadHomePayload('en');
  return p.events
    .filter((e) => e.source_url)
    .map((e) => ({
      source: 'Editorial event',
      url: e.source_url as string,
      title: e.description_en,
    }));
}

// The selected related-news headlines, in the brief's language, offered to the
// model as optional context. Headlines are NOT facts: the model may reference
// one to name a driver and cite its URL, but must not assert anything beyond
// the headline, and the numbers stay the backbone (guardrail spelled out here
// and in the editorial constitution).
function headlinesContext(items: NewsItem[], lang: Lang): string {
  if (items.length === 0) return '';
  const lines = items.map(
    (it) => `  - "${it.title[lang]}" — ${it.domain || 'news'} :: ${it.url}`
  );
  return [
    '',
    'Recent related news headlines (selected, machine-translated). You MAY reference one or two of these to name a plausible driver behind a move and cite that article URL, but do NOT assert any fact beyond what the headline plainly states, and keep every number grounded in the data above:',
    ...lines,
  ].join('\n');
}

// Each selected article becomes an allowed citation (its title in the brief's
// language). llm.ts enforces the allow-list, so the brief can cite a headline
// only by its verbatim URL.
function articleCitations(items: NewsItem[], lang: Lang): Citation[] {
  return items.map((it) => ({
    source: it.domain || 'News',
    url: it.url,
    title: it.title[lang],
  }));
}

/**
 * Draft + auto-publish the weekly brief for every language. Never calls
 * process.exit, so it can be awaited from the collect orchestrator. Returns the
 * number of languages published, or -1 for a BRIEF_CONTEXT_ONLY dry run.
 */
export async function runDraftBrief(): Promise<number> {
  const weekOf = new Date().toISOString().slice(0, 10);
  const dataContext = buildDataContext();
  const news = readNews()?.articles ?? [];

  // Dry run: inspect the factual context the model will receive, no API call.
  if (process.env.BRIEF_CONTEXT_ONLY) {
    console.log(dataContext + headlinesContext(news, 'en'));
    return -1;
  }
  const baseSources = [...DATA_SOURCES, ...eventSources()];

  const existing = readBriefs();
  const byKey = new Map(existing.map((b) => [`${b.lang}|${b.date}`, b]));
  let nextId = existing.reduce((m, b) => Math.max(m, b.id), 0) + 1;

  let ok = 0;
  for (const lang of LANGS) {
    try {
      const prev = existing
        .filter((b) => b.lang === lang && b.status === 'published' && b.published)
        .sort((a, b) => b.date.localeCompare(a.date))[0];

      const { draft, citations } = await generateBrief({
        lang,
        weekOf,
        dataContext: dataContext + headlinesContext(news, lang),
        sources: [...baseSources, ...articleCitations(news, lang)],
        glossary: glossaryFor(lang),
        previousBrief: prev?.published ?? undefined,
      });

      const key = `${lang}|${weekOf}`;
      const priorId = byKey.get(key)?.id;
      // Owner policy: auto-publish. The draft is published verbatim; there is
      // no pending_review hop. `published` carries the live text, `status` is
      // published, and reviewed_at is stamped now to mean "auto-approved at
      // generation time". A throw above means this language is skipped
      // entirely, so its previous published row survives untouched.
      const now = new Date().toISOString();
      const row: BriefRow = {
        id: priorId ?? nextId++,
        lang,
        date: weekOf,
        draft,
        published: draft,
        status: 'published',
        created_at: now,
        reviewed_at: now,
        citations: JSON.stringify(citations),
      };
      byKey.set(key, row);
      ok++;
      console.log(`✓ ${lang}: drafted & published (${citations.length} citations)`);
    } catch (err) {
      console.error(`✗ ${lang}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeBriefs([...byKey.values()]);
  console.log(`\ndraft-brief done — ${ok}/${LANGS.length} languages published for ${weekOf}`);
  return ok;
}

// Standalone CLI: `npm run draft-brief`. Fail only if every language failed.
if (isEntrypoint(import.meta.url)) {
  runDraftBrief()
    .then((ok) => {
      if (ok === 0) {
        console.error('every language failed — exiting non-zero');
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
