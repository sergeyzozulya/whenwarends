// Placeholder: lib/db.ts — D1 query helpers
// Implemented in Phase 1

export async function getLatestSnapshot(env: any, metric: string, source: string) {
  const result = await env.DB.prepare(
    'SELECT * FROM snapshots WHERE metric = ? AND source = ? ORDER BY ts DESC LIMIT 1'
  )
    .bind(metric, source)
    .first();
  return result;
}
