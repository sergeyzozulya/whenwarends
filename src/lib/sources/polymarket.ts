// Polymarket collector — primary Russia–Ukraine war-end forecast signal.
//
// Endpoint (public, no auth, no key — verified live against the real Gamma API
// on 2026-05-18):
//   GET https://gamma-api.polymarket.com/events
//       ?closed=false
//       &active=true
//       &limit=100
//       &order=volume
//       &ascending=false
//       &tag_slug=ukraine
//
//   Why /events and not /markets: the `tag` param on /markets is silently
//   IGNORED by the live API (it returns unrelated esports/crypto markets).
//   Tag filtering only works on /events via `tag_slug`. Each event nests a
//   `markets[]` array; we walk those and keep the ones about the war ending /
//   a ceasefire / a peace deal (see isWarEndMarket).
//
//   Resolution-date derivation (the load-bearing fix for the CDF): grouped
//   markets such as "Russia x Ukraine ceasefire agreement by December 31,
//   2026?" all share ONE event-level `endDate` (2026-12-31). Using that would
//   collapse every horizon to a single point and destroy the CDF. The true
//   per-market resolution date is in the question text ("by <Month Day>,
//   <Year>" / "before <Year>"). We parse that first, then fall back to
//   groupItemTitle + an inferred year, then endDate/endDateIso.
//
//   For each binary market the "Yes" outcome price (outcomePrices[0]) is
//   already a 0–1 probability that the war ends / ceasefire is reached by
//   that market's resolution date.
//
// Output:
//   - snapshots: one aggregate `war_end_probability` (liquidity-weighted mean
//     of qualifying markets). The runner persists with UNIQUE(metric, source,
//     ts), so per-market detail stays in MarketRow[], not extra snapshots.
//   - markets: one MarketRow per qualifying war-end market (the CDF pipeline
//     reads these markets → resolution dates → liquidity-weighted YES price).
//
// The HTTP layer is injectable (defaults to the real fetchJson) so unit tests
// run fully offline with a mocked payload.

import type { Collector, CollectorResult, Env, MarketRow, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import {
  PolymarketEventsResponseSchema,
  decodeJsonStringArray,
  type PolymarketMarket,
} from './polymarket.schema';

export const POLYMARKET_SOURCE = 'polymarket';
export const WAR_END_METRIC = 'war_end_probability';

const GAMMA_EVENTS_URL =
  'https://gamma-api.polymarket.com/events' +
  '?closed=false&active=true&limit=100&order=volume&ascending=false&tag_slug=ukraine';

/**
 * Intent terms for "the Russia–Ukraine war ends / ceasefire / peace deal".
 * Broad on phrasing so the live markets ("ceasefire agreement by...",
 * "signs peace deal with Russia", "war end") all match.
 */
const WAR_END_PATTERN =
  /\b(war ends?|end of (?:the )?war|end the war|ceasefire|cease-fire|truce|armistice|peace deal|peace agreement|peace treaty|peace settlement|peace plan|invasion ends?|end of (?:the )?invasion)\b/i;

/** Must clearly be the Russia–Ukraine conflict, not some other war. */
const CONFLICT_PATTERN =
  /\b(ukrain\w*|russia\w*|russo[- ]ukrainian|kyiv|kremlin|putin|zelensk\w*)\b/i;

/**
 * Exclusions: markets that mention ceasefire/peace tangentially but are NOT a
 * "when does the war end" forecast (so they don't pollute the CDF). Tuned to
 * the real live Ukraine tag: territory captures, troop deployments, summit
 * locations, and "referendum scheduled" markets.
 */
const EXCLUDE_PATTERN =
  /\b(referendum (?:scheduled|called)|calls a referendum|capture|captures?|recaptur\w*|troops fighting|enter ukraine|meet next|where will|nobel|nuclear weapon|drone strike|how many)\b/i;

/** Injectable HTTP layer so tests can supply a mock payload. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

function isWarEndMarket(question: string): boolean {
  if (EXCLUDE_PATTERN.test(question)) return false;
  return WAR_END_PATTERN.test(question) && CONFLICT_PATTERN.test(question);
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/** UTC ISO-8601 (`...Z`) for a given Y/M/D at midnight, or undefined. */
function isoUtcDate(year: number, monthIdx: number, day: number): string | undefined {
  if (!Number.isInteger(year) || year < 2022 || year > 2100) return undefined;
  if (monthIdx < 0 || monthIdx > 11) return undefined;
  if (day < 1 || day > 31) return undefined;
  const t = Date.UTC(year, monthIdx, day);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Best-effort ISO-8601 UTC normalisation of an already-timestamped string.
 * Re-serialises through Date to guarantee a valid UTC `Z` string and reject
 * garbage. Returns undefined when unparseable.
 */
function toIsoUtc(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Derive the TRUE per-market resolution date. Priority:
 *  1. A full date in the question text: "by December 31, 2026", "before 2027",
 *     "by June 30" (year then inferred from any explicit year nearby or the
 *     event endDate).
 *  2. groupItemTitle ("December 31") + a year inferred from the question or
 *     the event-level endDate.
 *  3. endDateIso / endDate (event-level fallback — coarse for grouped markets).
 */
function resolveResolutionDate(
  m: PolymarketMarket,
  fallbackIso: string
): string {
  const q = m.question;

  // Year hint: an explicit 4-digit year anywhere in the question, else the
  // year of the event endDate, else the fallback (now) year.
  const yearFromText = q.match(/\b(20\d{2})\b/);
  const endYear = m.endDate ? new Date(m.endDate).getUTCFullYear() : undefined;
  const fallbackYear = new Date(fallbackIso).getUTCFullYear();

  // "before 2027" / "by end of 2026" → end of the prior boundary. We treat
  // "before <Y>" as Dec 31 of <Y-1> (i.e. by the end of the year before).
  const beforeYear = q.match(/\bbefore\s+(20\d{2})\b/i);
  if (beforeYear) {
    const y = Number(beforeYear[1]) - 1;
    const iso = isoUtcDate(y, 11, 31);
    if (iso) return iso;
  }

  // "<Month> <Day>" (optionally followed by a year): "by December 31, 2026?"
  // or grouped row text "December 31".
  const md =
    q.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s*(20\d{2}))?/i
    ) ??
    (m.groupItemTitle
      ? m.groupItemTitle.match(
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s*(20\d{2}))?/i
        )
      : null);
  if (md) {
    const monthIdx = MONTHS[md[1].toLowerCase()];
    const day = Number(md[2]);
    const year = md[3]
      ? Number(md[3])
      : yearFromText
        ? Number(yearFromText[1])
        : endYear ?? fallbackYear;
    const iso = isoUtcDate(year, monthIdx, day);
    if (iso) return iso;
  }

  // "in 2026" / "by 2027" with no month → end of that year.
  const bareYear = q.match(/\b(?:in|by|during)\s+(20\d{2})\b/i);
  if (bareYear) {
    const iso = isoUtcDate(Number(bareYear[1]), 11, 31);
    if (iso) return iso;
  }

  // Event-level timestamps as a last resort (coarse for grouped markets).
  return (
    toIsoUtc(m.endDate) ??
    toIsoUtc(m.endDateIso) ??
    toIsoUtc(m.closedTime) ??
    fallbackIso
  );
}

/** "Yes" probability for a binary market, clamped to [0, 1]. */
function yesProbability(m: PolymarketMarket): number | null {
  const outcomes = decodeJsonStringArray(m.outcomes).map((s) => s.toLowerCase());
  const prices = decodeJsonStringArray(m.outcomePrices)
    .map((s) => Number(s))
    .map((n) => (Number.isFinite(n) ? n : null));

  let p: number | null = null;
  if (prices.length > 0) {
    // Prefer the explicit "Yes" index when outcomes are labelled; Polymarket
    // binary markets are ordered [Yes, No] but be defensive.
    const yesIdx = outcomes.indexOf('yes');
    const idx = yesIdx >= 0 && yesIdx < prices.length ? yesIdx : 0;
    p = prices[idx];
  }
  if ((p === null || !Number.isFinite(p)) && typeof m.lastTradePrice === 'number') {
    p = m.lastTradePrice;
  }
  if (
    (p === null || !Number.isFinite(p)) &&
    typeof m.bestBid === 'number' &&
    typeof m.bestAsk === 'number'
  ) {
    p = (m.bestBid + m.bestAsk) / 2;
  }
  if (p === null || !Number.isFinite(p)) return null;
  return Math.min(1, Math.max(0, p));
}

function liquidityUsd(m: PolymarketMarket): number | null {
  const l = m.liquidityNum ?? m.liquidity;
  return typeof l === 'number' && Number.isFinite(l) ? l : null;
}

/**
 * Parse a raw Polymarket /events response and map it to snapshots + markets.
 * Exported so tests can exercise the pure mapping without the fetch layer.
 */
export function mapPolymarketResponse(raw: unknown, nowIso: string): CollectorResult {
  const events = PolymarketEventsResponseSchema.parse(raw);

  const rows: MarketRow[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  let plainSum = 0;
  let plainCount = 0;
  // Guard against duplicate markets appearing under more than one event/tag.
  const seen = new Set<string>();

  for (const ev of events) {
    if (ev.closed === true) continue;
    for (const m of ev.markets) {
      if (m.closed === true) continue;
      if (m.active === false) continue;
      if (!isWarEndMarket(m.question)) continue;
      const marketId = `polymarket:${m.id}`;
      if (seen.has(marketId)) continue;
      seen.add(marketId);

      const prob = yesProbability(m);
      const resolution = resolveResolutionDate(m, nowIso);
      const liq = liquidityUsd(m);

      rows.push({
        market_id: marketId,
        source: POLYMARKET_SOURCE,
        question: m.question,
        resolution_date: resolution,
        category: 'war_end',
        current_price: prob,
        liquidity_usd: liq,
        last_updated: nowIso,
      });

      if (prob !== null) {
        plainSum += prob;
        plainCount += 1;
        // Weight by liquidity when available; deeper markets are more reliable.
        const w = liq && liq > 0 ? liq : 1;
        weightedSum += prob * w;
        weightTotal += w;
      }
    }
  }

  const snapshots: SnapshotInput[] = [];
  if (plainCount > 0) {
    const aggregate = weightTotal > 0 ? weightedSum / weightTotal : plainSum / plainCount;
    snapshots.push({
      metric: WAR_END_METRIC,
      source: POLYMARKET_SOURCE,
      ts: nowIso,
      value: Math.min(1, Math.max(0, aggregate)),
      // Confidence rises with the number of qualifying markets, capped at 1.
      confidence: Math.min(1, plainCount / 3),
      raw_blob: JSON.stringify({
        markets: plainCount,
        liquidityWeighted: weightTotal > 0,
      }),
    });
  }

  return { snapshots, markets: rows };
}

/**
 * Build a Polymarket collector. The fetcher is injectable purely for testing;
 * production code uses the real retrying fetchJson by default.
 */
export function createPolymarketCollector(fetcher: JsonFetcher = defaultFetcher): Collector {
  return {
    name: POLYMARKET_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      const raw = await fetcher(GAMMA_EVENTS_URL);
      const nowIso = new Date().toISOString();
      return mapPolymarketResponse(raw, nowIso);
    },
  };
}

export const polymarketCollector: Collector = createPolymarketCollector();
