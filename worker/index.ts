/**
 * Cloudflare Worker entry point
 * Routes API requests, falls back to static assets for everything else
 */

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  DB: D1Database;
  KV_CACHE: KVNamespace;
  ANTHROPIC_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith('/api/')) {
      // /api/health
      if (url.pathname === '/api/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // /api/brief/latest - editor admin endpoint (phase 3)
      if (url.pathname === '/api/brief/latest' && request.method === 'GET') {
        return new Response(
          JSON.stringify({
            message: 'Brief endpoint — admin API coming in Phase 3',
          }),
          {
            status: 501,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Catch-all for unknown API routes
      return new Response(
        JSON.stringify({ error: 'Not found' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Everything else: serve static assets
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Cron handler for Sunday 08:00 UTC
    console.log('Scheduled event triggered');
    // Collector Workers will be implemented in Phase 1-2
  },
} satisfies ExportedHandler<Env>;
