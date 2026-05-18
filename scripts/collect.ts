// Weekly data collection. Runs every collector (failure-isolated), appends
// new immutable snapshots and upserts current market state into the repo
// data/ files. Run locally with `npm run collect`; runs in CI weekly via
// .github/workflows/collect.yml, which commits the changed data files.
//
// Live APIs are hit here (Node, not Workers). One failing source degrades one
// widget, not the run — the process still exits 0 on partial success so the
// good data is committed; it exits 1 only if every source failed.

import type { Env } from '../src/lib/types';
import { runCollectors } from '../src/lib/sources/contract';
import { allCollectors } from '../src/workers/collectors';
import { appendSnapshots, upsertMarkets } from '../src/lib/filestore';

// Node shim for the Worker Env. Collectors only read string secrets (e.g.
// FIRMS_MAP_KEY); DB/KV/ASSETS are never touched in collection, so they are
// throwing stubs. Cast is justified: collectors are typed against Env but use
// only the env fields below.
const env = {
  FIRMS_MAP_KEY: process.env.FIRMS_MAP_KEY ?? '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
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

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\ncollect done — ${snapshotsAdded} new snapshots, ${marketsTouched} markets, ` +
      `${failed.length}/${results.length} sources failed`
  );
  if (failed.length === results.length) {
    console.error('every source failed — exiting non-zero');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
