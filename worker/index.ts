/**
 * Cloudflare Worker entry point.
 *
 * Data lives in versioned repo JSON files baked into the static build by the
 * weekly collect script — there is no runtime database. The Worker only serves
 * static assets and a health probe; collection runs in GitHub Actions.
 */

import type { Env } from '../src/lib/types';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health') {
        return json({ status: 'ok', timestamp: new Date().toISOString() });
      }
      return json({ error: 'Not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
