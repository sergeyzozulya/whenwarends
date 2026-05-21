import { describe, it, expect } from 'vitest';
import {
  fetchGdeltArticles,
  curateArticles,
} from '../../../src/lib/sources/gdeltArticles';
import type { NewsArticle } from '../../../src/lib/types';

// A representative GDELT mode=artlist response (the live shape, sorted newest
// first), including a duplicate headline and several same-domain entries so the
// curation rules are exercised without touching the network.
const SAMPLE = {
  articles: [
    {
      url: 'https://www.reuters.com/world/europe/talks-1',
      title: 'Ukraine and Russia resume prisoner-exchange talks',
      seendate: '20260521T120000Z',
      domain: 'reuters.com',
      socialimage: 'https://reuters.com/img/talks.jpg',
      language: 'English',
      sourcecountry: 'United Kingdom',
    },
    {
      url: 'https://www.reuters.com/world/europe/talks-1-dup',
      // Same headline, different URL -> deduped by normalized title.
      title: 'Ukraine and Russia Resume Prisoner-Exchange Talks',
      seendate: '20260521T123000Z',
      domain: 'reuters.com',
    },
    {
      url: 'https://apnews.com/article/front-2',
      title: 'Front-line shelling continues in the east',
      seendate: '20260521T090000Z',
      domain: 'apnews.com',
    },
    {
      url: 'https://www.reuters.com/world/europe/aid-3',
      title: 'EU debates next aid tranche',
      seendate: '20260520T180000Z',
      domain: 'reuters.com',
    },
    {
      url: 'https://www.reuters.com/world/europe/fx-4',
      // Third distinct reuters.com item -> kept (per-domain cap defaults to 3).
      title: 'Ruble firms against the dollar',
      seendate: '20260520T150000Z',
      domain: 'reuters.com',
    },
    {
      // State media -> dropped by the denylist.
      url: 'https://www.rt.com/russia/spin',
      title: 'State outlet spin on the war',
      seendate: '20260521T100000Z',
      domain: 'rt.com',
    },
    {
      // Missing title -> dropped.
      url: 'https://example.com/no-title',
      title: '',
      seendate: '20260520T150000Z',
      domain: 'example.com',
    },
  ],
};

const fetcherFor = (payload: unknown) => async () => payload;

describe('fetchGdeltArticles', () => {
  it('parses, normalizes dates, curates, and drops state media', async () => {
    const out = await fetchGdeltArticles(fetcherFor(SAMPLE));
    // Dedup the repeated talks headline; drop empty title and rt.com (denylist).
    // Per-domain cap defaults to 3, so all three distinct reuters items remain.
    expect(out.map((a) => a.url)).toEqual([
      'https://www.reuters.com/world/europe/talks-1',
      'https://apnews.com/article/front-2',
      'https://www.reuters.com/world/europe/aid-3',
      'https://www.reuters.com/world/europe/fx-4',
    ]);
    expect(out.some((a) => a.domain === 'rt.com')).toBe(false);
    // seendate -> ISO-8601 UTC; language carried through.
    expect(out[0].seenAt).toBe('2026-05-21T12:00:00.000Z');
    expect(out[0].sourceCountry).toBe('United Kingdom');
    expect(out[0].language).toBe('English');
    // socialimage -> image (hotlinked); absent => undefined.
    expect(out[0].image).toBe('https://reuters.com/img/talks.jpg');
    expect(out[1].image).toBeUndefined();
  });

  it('honours the limit option', async () => {
    const out = await fetchGdeltArticles(fetcherFor(SAMPLE), { limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe('reuters.com');
  });

  it('tolerates a zero-result response (missing articles key)', async () => {
    expect(await fetchGdeltArticles(fetcherFor({}))).toEqual([]);
    expect(await fetchGdeltArticles(fetcherFor({ articles: [] }))).toEqual([]);
  });

  it('tolerates a sparse article and drops it (no url)', async () => {
    expect(
      await fetchGdeltArticles(fetcherFor({ articles: [{ title: 'no url' }] }))
    ).toEqual([]);
  });

  it('rejects a structurally-wrong payload (Zod throws at the boundary)', async () => {
    await expect(
      fetchGdeltArticles(fetcherFor({ articles: 'not-an-array' }))
    ).rejects.toThrow();
  });
});

describe('curateArticles', () => {
  const mk = (over: Partial<NewsArticle>): NewsArticle => ({
    title: 't',
    url: 'u',
    domain: 'd.com',
    seenAt: '',
    ...over,
  });

  it('caps repeats per domain and total count', () => {
    const many: NewsArticle[] = Array.from({ length: 10 }, (_, i) =>
      mk({ title: `t${i}`, url: `u${i}`, domain: 'one.com' })
    );
    expect(curateArticles(many, 8, 2)).toHaveLength(2);
  });

  it('drops entries missing a title or url', () => {
    const rows = [mk({ title: '', url: 'u1' }), mk({ title: 't', url: '' }), mk({ url: 'ok' })];
    expect(curateArticles(rows)).toHaveLength(1);
  });

  it('drops state-media domains and their subdomains', () => {
    const rows = [
      mk({ title: 'a', url: 'a', domain: 'rt.com' }),
      mk({ title: 'b', url: 'b', domain: 'edition.tass.com' }),
      mk({ title: 'c', url: 'c', domain: 'reuters.com' }),
    ];
    expect(curateArticles(rows).map((a) => a.domain)).toEqual(['reuters.com']);
  });
});
