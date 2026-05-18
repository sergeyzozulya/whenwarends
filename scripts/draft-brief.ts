// Weekly editorial brief drafting (Phase 3). Reads the current data files,
// asks Claude to draft one brief per language, and writes them to
// data/briefs.json as `pending_review`. NEVER publishes — a human approves by
// reviewing/merging the PR that .github/workflows/brief.yml opens.
//
// Node-only. Run locally with `npm run draft-brief` (needs ANTHROPIC_API_KEY);
// runs weekly in CI. Per-language failure is isolated: one language failing
// does not block the others; exits 1 only if every language failed.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LANGS, type Lang, type Citation, type BriefRow } from '../src/lib/types';
import { readBriefs, writeBriefs } from '../src/lib/filestore';
import { loadHomePayload } from '../src/lib/homepage';
import { generateBrief } from '../src/lib/llm';

// Standing data provenance. The brief may cite only these URLs (plus event
// source URLs); llm.ts enforces the allow-list.
const DATA_SOURCES: Citation[] = [
  { source: 'Polymarket', url: 'https://polymarket.com', title: 'Market-implied war-end probabilities' },
  { source: 'Kalshi', url: 'https://kalshi.com', title: 'Secondary forecast market' },
  { source: 'GDELT Project', url: 'https://www.gdeltproject.org', title: 'Conflict intensity and tone' },
  { source: 'Kiel Institute Ukraine Support Tracker', url: 'https://www.ifw-kiel.de/topics/war-against-ukraine/ukraine-support-tracker/', title: 'Aid commitments' },
  { source: 'National Bank of Ukraine', url: 'https://bank.gov.ua', title: 'UAH exchange rate' },
  { source: 'Central Bank of Russia', url: 'https://www.cbr.ru', title: 'RUB exchange rate' },
  { source: 'World Bank', url: 'https://data.worldbank.org/country/russian-federation', title: 'Russian macro indicators' },
  { source: 'NASA FIRMS', url: 'https://firms.modaps.eosdis.nasa.gov', title: 'Fire/heat anomalies' },
];

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

function buildDataContext(): string {
  // Numbers are language-agnostic; use the en payload for the factual summary.
  const p = loadHomePayload('en');
  const lines: string[] = [];

  lines.push(
    p.hero.median
      ? `Median market-implied war-end date: ${p.hero.median.slice(0, 10)}.`
      : 'Median war-end date: not computable from current market data.'
  );
  for (const b of p.beliefs) {
    lines.push(`Market "${b.label}" current war-end probability: ${b.current ?? 'n/a'}.`);
  }
  const g = p.ground;
  const ind = (name: string, d: typeof g.frontline) =>
    d.value === null
      ? `${name}: data unavailable${d.degraded ? ` (last good ${d.degraded.sinceHours}h ago)` : ''}.`
      : `${name}: ${d.value}${d.estimateNote ? ' (ISW-observed estimate)' : ''}${d.degraded ? ` (stale, last good ${d.degraded.sinceHours}h ago)` : ''}.`;
  lines.push(ind('Frontline / fire anomalies', g.frontline));
  lines.push(ind('Conflict intensity', g.intensity));
  lines.push(ind('Aid commitments (EUR)', g.aid));
  lines.push(ind('Russian economy (RUB/USD)', g.economy));

  if (p.events.length) {
    lines.push('Recent dated events:');
    for (const e of p.events) {
      const shift =
        e.shift_months == null || e.shift_months === 0
          ? 'no measurable shift'
          : `${e.shift_months > 0 ? 'pushed later' : 'pulled earlier'} ~${Math.abs(e.shift_months)} months`;
      lines.push(`  - ${e.date}: ${e.description_en} (${shift}).`);
    }
  } else {
    lines.push('No editorial events recorded this period.');
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

async function main(): Promise<void> {
  const weekOf = new Date().toISOString().slice(0, 10);
  const dataContext = buildDataContext();
  const sources = [...DATA_SOURCES, ...eventSources()];

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
        dataContext,
        sources,
        glossary: glossaryFor(lang),
        previousBrief: prev?.published ?? undefined,
      });

      const key = `${lang}|${weekOf}`;
      const priorId = byKey.get(key)?.id;
      const row: BriefRow = {
        id: priorId ?? nextId++,
        lang,
        date: weekOf,
        draft,
        published: null,
        status: 'pending_review',
        created_at: new Date().toISOString(),
        reviewed_at: null,
        citations: JSON.stringify(citations),
      };
      byKey.set(key, row);
      ok++;
      console.log(`✓ ${lang}: drafted (${citations.length} citations)`);
    } catch (err) {
      console.error(`✗ ${lang}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeBriefs([...byKey.values()]);
  console.log(`\ndraft-brief done — ${ok}/${LANGS.length} languages drafted for ${weekOf}`);
  if (ok === 0) {
    console.error('every language failed — exiting non-zero');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
