/**
 * Cloudflare Worker entry point.
 * Routes /api/*, runs the scheduled collector cron, falls back to static assets.
 */

import type { Env, Lang } from '../src/lib/types';
import { LANGS } from '../src/lib/types';
import { runCollectors } from '../src/lib/sources/contract';
import { allCollectors } from '../src/workers/collectors';
import { getHomePayload } from '../src/lib/homepage';
import { invalidateHomepage } from '../src/lib/kv';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function parseLang(url: URL): Lang {
  const q = url.searchParams.get('lang');
  return (LANGS as readonly string[]).includes(q ?? '')
    ? (q as Lang)
    : 'en';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health') {
        return json({ status: 'ok', timestamp: new Date().toISOString() });
      }

      // Live homepage payload (KV-cached, assembled from D1).
      if (url.pathname === '/api/homepage' && request.method === 'GET') {
        try {
          const payload = await getHomePayload(env, parseLang(url));
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=300',
            },
          });
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : 'assembly failed' },
            500
          );
        }
      }

      if (url.pathname === '/api/brief/latest' && request.method === 'GET') {
        return json({ message: 'Brief endpoint — admin API coming in Phase 3' }, 501);
      }

      return json({ error: 'Not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // Weekly cron (Sunday 08:00 UTC): pull every source. Each collector is
    // failure-isolated by runCollectors — one bad source degrades one widget.
    const summaries = await runCollectors(env, allCollectors);
    const failed = summaries.filter((s) => !s.ok);
    if (failed.length) {
      console.error('collector failures', JSON.stringify(failed));
    }
    console.log('collector run', JSON.stringify(summaries));
    // Fresh data → drop the cached homepage so the next request rebuilds it.
    await invalidateHomepage(env);
  },
} satisfies ExportedHandler<Env>;
