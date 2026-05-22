// GDELT 2.0 "related news" collector — the actual news articles behind the
// conflict-intensity curve, for display below the weekly brief.
//
// Data source: GDELT DOC 2.0 API, mode=artlist (CC BY 4.0, no auth). This is the
// same endpoint and war query as the timeline collector (src/lib/sources/gdelt
// .ts) — so "related events" are sourced from exactly the coverage that drives
// the intensity index — but here we read the matching articles, not a timeline.
//
// We reuse gdelt.ts's rate-limit-aware JSON fetcher (GDELT answers a 1-req/5s
// violation with plain-text, not JSON) and its date normalizer. Parsing happens
// at the boundary via Zod; downstream works with typed NewsArticle objects. The
// fetcher is injectable so unit tests run offline against mocked GDELT JSON.

import { gdeltJsonFetcher, normalizeGdeltDate, type JsonFetcher } from './gdelt';
import { GdeltArtListResponseSchema } from './gdeltArticles.schema';
import { isBlockedSource } from './denylist';
import type { NewsArticle } from '../types';

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

// Same war definition as the timeline query, but WITHOUT `sourcelang:eng`: we
// want the broadest credible pool and let the selection pass translate the
// chosen titles into all three locales. (GDELT keyword matching is still
// English-leaning, but we no longer exclude other matches.)
const QUERY = '(Ukraine OR Russia) (war OR military OR offensive OR ceasefire)';

// Restrict the candidate pool to the recent window. Without a timespan, GDELT
// searches ~3 months and `hybridrel` relevance favours older, heavily-covered
// stories — so the pool (and the picks) skewed weeks stale even though fresh
// coverage exists. A 7-day window keeps candidates recent AND lets relevance
// surface the salient ones; it matches the weekly brief's span. (Verified live
// 2026-05-22: 7d → ~200 articles spread evenly across the last week.)
const NEWS_WINDOW = '7d';

/** Build a fully percent-encoded GDELT artlist URL (spaces => %20). */
function buildUrl(maxRecords: number): string {
  const qs = [
    ['query', QUERY],
    ['mode', 'artlist'],
    ['maxrecords', String(maxRecords)],
    // Recent window only — see NEWS_WINDOW. Combined with relevance ranking
    // below, the pool is both fresh and salient (not weeks-stale, not just the
    // latest 15-minute batch).
    ['timespan', NEWS_WINDOW],
    // Relevance ranking ("best") within the window, not pure freshness.
    ['sort', 'hybridrel'],
    ['format', 'json'],
  ]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${BASE}?${qs}`;
}

/**
 * Curate a raw GDELT article list into a diverse candidate pool: drop entries
 * missing a title/url, dedupe identical headlines, cap each domain so one
 * outlet can't dominate, and keep the first `limit` (input is relevance-sorted,
 * so these are the most salient diverse stories). The LLM selection pass picks
 * the final top-N from this pool.
 *
 * Source policy (see src/lib/sources/denylist.ts): Tier-1 state media and the
 * Pravda/Doppelganger swarm networks are dropped entirely; Tier-2 amplifiers
 * are NOT dropped but `flagged`, so they can still be selected and shown with a
 * warning rather than silently removed.
 */
export function curateArticles(
  articles: NewsArticle[],
  limit = 150,
  maxPerDomain = 3
): NewsArticle[] {
  const seenTitles = new Set<string>();
  const perDomain = new Map<string, number>();
  const out: NewsArticle[] = [];
  for (const a of articles) {
    if (!a.title || !a.url) continue;
    const block = a.domain ? isBlockedSource(a.domain) : null;
    // Hard-drop state media + spoof/swarm networks; keep amplifiers, flagged.
    if (block && block !== 'amplifier') continue;
    const titleKey = a.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenTitles.has(titleKey)) continue;
    const used = perDomain.get(a.domain) ?? 0;
    if (a.domain && used >= maxPerDomain) continue;
    seenTitles.add(titleKey);
    perDomain.set(a.domain, used + 1);
    out.push(block === 'amplifier' ? { ...a, flagged: true } : a);
    if (out.length >= limit) break;
  }
  return out;
}

export interface FetchArticlesOptions {
  /** How many records to pull from GDELT (max 250). */
  maxRecords?: number;
  /** How many candidates to keep in the pool the selection pass chooses from. */
  limit?: number;
}

/**
 * Fetch a relevance-ranked, state-media-filtered candidate pool of war-related
 * news from GDELT. Throws on a non-JSON / rate-limited response (typed error
 * from the shared fetcher) so the caller can isolate the failure and keep any
 * previous news file.
 */
export async function fetchGdeltArticles(
  fetcher: JsonFetcher = gdeltJsonFetcher,
  opts: FetchArticlesOptions = {}
): Promise<NewsArticle[]> {
  const { maxRecords = 200, limit = 150 } = opts;
  const raw = await fetcher(buildUrl(maxRecords));
  const parsed = GdeltArtListResponseSchema.parse(raw);
  const mapped: NewsArticle[] = parsed.articles.map((a) => ({
    title: a.title.trim(),
    url: a.url.trim(),
    domain: a.domain ?? '',
    seenAt: normalizeGdeltDate(a.seendate) ?? '',
    sourceCountry: a.sourcecountry,
    language: a.language,
    image: a.socialimage?.trim() || undefined,
  }));
  return curateArticles(mapped, limit);
}
