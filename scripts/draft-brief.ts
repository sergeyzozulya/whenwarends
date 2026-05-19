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
import { LANGS, type Lang, type Citation, type BriefRow } from '../src/lib/types';
import { readBriefs, writeBriefs } from '../src/lib/filestore';
import { loadHomePayload } from '../src/lib/homepage';
import { generateBrief } from '../src/lib/llm';
import { DATA_SOURCES } from '../src/lib/briefContext';

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
      : `${name}: ${d.value}${d.degraded ? ` (stale, last good ${d.degraded.sinceHours}h ago)` : ''}.`;
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
  if (ok === 0) {
    console.error('every language failed — exiting non-zero');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
