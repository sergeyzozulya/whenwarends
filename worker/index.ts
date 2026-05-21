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

    // The /en locale prefix was removed — English is served at the root.
    // Cloudflare Static Assets does not honour a `_redirects` file in this
    // Worker+Assets setup (it serves the file verbatim), so do the 301 here:
    // permanently redirect legacy /en and /en/* URLs to the unprefixed path,
    // preserving the query string. These paths have no matching asset, so the
    // request reaches the Worker.
    const legacyEn = url.pathname.match(/^\/en(\/.*)?$/);
    if (legacyEn) {
      url.pathname = legacyEn[1] ?? '/';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health') {
        return json({ status: 'ok', timestamp: new Date().toISOString() });
      }
      return json({ error: 'Not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
