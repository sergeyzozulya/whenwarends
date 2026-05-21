import { describe, it, expect, vi } from 'vitest';
import worker from '../../worker/index';
import type { Env } from '../../src/lib/types';

// env.ASSETS.fetch returns a sentinel so we can tell when the Worker delegates
// to static assets vs. handles (redirects / api) the request itself.
const ASSETS_SENTINEL = new Response('assets', { status: 299 });
const env = {
  ASSETS: { fetch: vi.fn(async () => ASSETS_SENTINEL.clone()) },
} as unknown as Env;

const call = (path: string): Promise<Response> =>
  worker.fetch!(
    new Request(`https://whenwarends.org${path}`),
    env,
    {} as ExecutionContext
  );

describe('worker: legacy /en redirects', () => {
  it.each([
    ['/en', '/'],
    ['/en/', '/'],
    ['/en/methodology', '/methodology'],
    ['/en/methodology/', '/methodology/'],
    ['/en/og.png', '/og.png'],
  ])('301s %s → %s', async (from, toPath) => {
    const res = await call(from);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`https://whenwarends.org${toPath}`);
  });

  it('preserves the query string', async () => {
    const res = await call('/en/methodology?ref=x');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      'https://whenwarends.org/methodology?ref=x'
    );
  });
});

describe('worker: non-/en paths are not redirected', () => {
  it.each(['/', '/methodology', '/uk/', '/ru/methodology', '/endpoint', '/engine'])(
    'delegates %s to static assets',
    async (path) => {
      const res = await call(path);
      expect(res.status).toBe(299);
    }
  );
});

describe('worker: api', () => {
  it('answers the health probe', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('404s unknown api routes', async () => {
    const res = await call('/api/nope');
    expect(res.status).toBe(404);
  });
});
