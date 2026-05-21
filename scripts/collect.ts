// Weekly data collection. Runs every collector (failure-isolated), appends
// new immutable snapshots and upserts current market state into the repo
// data/ files. Run locally with `npm run collect`; runs in CI weekly via
// .github/workflows/collect.yml, which commits the changed data files.
//
// Live APIs are hit here (Node, not Workers). One failing source degrades one
// widget, not the run — the process still exits 0 on partial success so the
// good data is committed; it exits 1 only if every source failed.

import './loadEnv'; // must be first: populates process.env from .dev.vars
import type { Env } from '../src/lib/types';
import { runCollectors } from '../src/lib/sources/contract';
import { allCollectors } from '../src/workers/collectors';
import {
  appendSnapshots,
  upsertMarkets,
  readMarkets,
} from '../src/lib/filestore';
import { allDerivedSnapshots } from '../src/lib/cards';
import { runCollectNews } from './collect-news';
import { runDraftBrief } from './draft-brief';

// Node shim for the Worker Env. Collectors only read string secrets (e.g.
// FIRMS_MAP_KEY); DB/KV/ASSETS are never touched in collection, so they are
// throwing stubs. Cast is justified: collectors are typed against Env but use
// only the env fields below.
const env = {
  FIRMS_MAP_KEY: process.env.FIRMS_MAP_KEY ?? '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  // Operator config some collectors read off `env` (not the typed contract):
  KIEL_DATASET_URL: process.env.KIEL_DATASET_URL ?? '',
  KALSHI_SERIES_TICKER: process.env.KALSHI_SERIES_TICKER ?? '',
  CONTACT_TO_EMAIL: '',
  CONTACT_FROM_EMAIL: '',
  CONTACT_FROM_NAME: '',
  get DB(): never {
    throw new Error('DB is not available in the collect script');
  },
  get KV_CACHE(): never {
    throw new Error('KV is not available in the collect script');
  },
  get ASSETS(): never {
    throw new Error('ASSETS is not available in the collect script');
  },
} as unknown as Env;

async function main(): Promise<void> {
  const results = await runCollectors(allCollectors, env);

  let snapshotsAdded = 0;
  let marketsTouched = 0;
  for (const r of results) {
    if (!r.ok || !r.result) {
      console.error(`✗ ${r.source}: ${r.error ?? 'unknown error'}`);
      continue;
    }
    const added = appendSnapshots(r.result.snapshots);
    snapshotsAdded += added;
    if (r.result.markets?.length) {
      upsertMarkets(r.result.markets);
      marketsTouched += r.result.markets.length;
    }
    console.log(
      `✓ ${r.source}: +${added} snapshots, ${r.result.markets?.length ?? 0} markets`
    );
  }

  // Derive the hero consensus + two stat cards from the merged current market
  // state and append one snapshot each. markets.json is overwritten every run,
  // so these derived snapshots are the only stored history the trends grow from.
  const derivedAdded = appendSnapshots(
    allDerivedSnapshots(readMarkets(), new Date().toISOString())
  );
  if (derivedAdded > 0) {
    snapshotsAdded += derivedAdded;
    console.log(`✓ derived metrics: +${derivedAdded} snapshots`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\ncollect done — ${snapshotsAdded} new snapshots, ${marketsTouched} markets, ` +
      `${failed.length}/${results.length} sources failed`
  );

  // One command updates everything: data -> related news -> editorial brief.
  // Both downstream steps are failure-isolated (they keep prior files on
  // error) and never throw out here, but guard anyway so one can't abort the
  // other or mask the collector exit code. News runs first — the brief reads
  // news.json. Skipped when SKIP_DOWNSTREAM is set (e.g. a data-only refresh).
  if (!process.env.SKIP_DOWNSTREAM) {
    console.log('\n--- related news ---');
    try {
      await runCollectNews();
    } catch (err) {
      console.error(`news step failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log('\n--- editorial brief ---');
    try {
      await runDraftBrief();
    } catch (err) {
      console.error(`brief step failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed.length === results.length) {
    console.error('every data source failed — exiting non-zero');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
