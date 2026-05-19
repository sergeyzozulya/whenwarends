// Russian CBR collector — RUB FX rate (RUB per USD) for the macro widgets.
//
// Endpoint (OFFICIAL CBR, no auth, daily refresh; durable):
//   GET https://www.cbr.ru/scripts/XML_daily.asp
//
// Why this source: the previous implementation used the community JSON mirror
// https://www.cbr-xml-daily.ru/daily_json.js, which was observed completely
// unreachable from this environment (connection/DNS failure → "fetch failed").
// The official cbr.ru host is stable and authoritative; the cost is parsing
// windows-1251 XML instead of JSON. We accept that for durability.
//
// Live-verified facts (captured 16 May 2026 via curl from this environment):
//   - HTTP 200 ONLY when a User-Agent header is sent (a header-less request is
//     blocked), so we always send one via the frozen fetcher's `init`.
//   - Body is `windows-1251`-encoded XML. The only non-ASCII content is the
//     `<Name>` field (Cyrillic), which we do NOT consume; CharCode/Nominal/
//     Value/Date are pure ASCII. We still decode windows-1251 (Node 20's
//     global TextDecoder supports it) so the parse is correct regardless.
//   - Root: `<ValCurs Date="16.05.2026" name="Foreign Currency Market">` —
//     `Date` is a Moscow CALENDAR date in DD.MM.YYYY (no time, no offset).
//   - USD: `<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode>
//     <Nominal>1</Nominal><Name>Доллар США</Name><Value>73,1275</Value>
//     <VunitRate>73,1275</VunitRate></Valute>`.
//   - Numbers use a COMMA decimal separator ("73,1275"); we normalise to dot.
//
// Parsing strategy: the feed is flat, namespace-free and CDATA-free, so a
// small scoped regex extractor (no XML dependency added) is sufficient and
// safer than pulling a heavy parser. Extracted fields are normalised then
// Zod-validated at the boundary (see cbr.schema.ts).
//
// Date handling: CBR publishes the rate that is in effect on the given Moscow
// date, set as of 00:00 Moscow (UTC+03:00) of that calendar day. We re-emit
// it as canonical UTC ISO-8601 so the stored `ts` is timezone-unambiguous.
//
// Reserves are NOT exposed by this daily FX feed (CBR publishes international
// reserves on a separate weekly feed). Reserves remain intentionally out of
// scope here; only the FX metric is emitted. Documented so the omission is a
// deliberate decision, not a gap.
//
// Mapping:
//   - SnapshotInput: metric 'rub_usd_rate', source 'cbr',
//     value = RUB per USD (Value / Nominal), ts = UTC ISO-8601 from `Date`.

import { fetchWithRetry } from './contract';
import { CbrDailySchema, CbrHistoryRecordSchema } from './cbr.schema';
import type {
  Collector,
  CollectorResult,
  Env,
  SnapshotInput,
} from '../types';

export const CBR_DAILY_URL =
  'https://www.cbr.ru/scripts/XML_daily.asp';

// CBR's internal currency id for USD (used by the dynamic/history feed).
export const CBR_USD_VAL_NM = 'R01235' as const;
// Full-war history start (aligns with the other collectors / Kiel earliest).
const HISTORY_START_UTC = Date.UTC(2022, 0, 1);

export const SOURCE = 'cbr' as const;
export const METRIC_RUB_USD_RATE = 'rub_usd_rate' as const;

/** Date → CBR's `DD/MM/YYYY` (UTC) used by XML_dynamic date_req params. */
function ddmmyyyySlashUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Historical single-currency series URL for [from, to] (USD by default). */
export function cbrDynamicUrl(
  fromMs: number,
  toMs: number,
  valNm: string = CBR_USD_VAL_NM
): string {
  const qs =
    `date_req1=${ddmmyyyySlashUtc(fromMs)}` +
    `&date_req2=${ddmmyyyySlashUtc(toMs)}` +
    `&VAL_NM_RQ=${valNm}`;
  return `https://www.cbr.ru/scripts/XML_dynamic.asp?${qs}`;
}

// cbr.ru blocks header-less requests; a UA is mandatory. Accept advertises XML.
const CBR_FETCH_INIT: RequestInit = {
  headers: {
    'User-Agent':
      'WhenWarEnds/1.0 (+https://whenwarends.org; non-commercial dashboard)',
    Accept: 'application/xml, text/xml; q=0.9, */*; q=0.8',
  },
};

/** Injectable fetcher so unit tests can supply a mocked CBR XML body. */
export type TextFetcher = (url: string) => Promise<string>;

const defaultFetcher: TextFetcher = async (url) => {
  const res = await fetchWithRetry(url, { init: CBR_FETCH_INIT });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // CBR serves windows-1251. Decode explicitly rather than res.text() (which
  // assumes UTF-8) so any future consumption of the Cyrillic Name is correct.
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder('windows-1251').decode(buf);
};

/** "73,1275" → 73.1275. Returns NaN on anything malformed (schema rejects). */
function parseCbrNumber(raw: string): number {
  return Number(raw.trim().replace(/\s+/g, '').replace(',', '.'));
}

/**
 * Convert CBR's Moscow calendar date "DD.MM.YYYY" to canonical UTC ISO-8601.
 * The rate is effective at 00:00 Moscow time (UTC+03:00) on that date, so the
 * UTC instant is 21:00 on the previous day. Returns null if unparseable.
 */
function moscowDateToIsoUtc(ddmmyyyy: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ddmmyyyy.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  // Construct the 00:00 Moscow (+03:00) instant explicitly, then normalise.
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00+03:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Extract the `Date` attribute from the `<ValCurs ...>` root element. */
function extractDateAttr(xml: string): string | null {
  const m = /<ValCurs\b[^>]*\bDate="([^"]+)"/i.exec(xml);
  return m ? m[1] : null;
}

/**
 * Extract a single child tag's text from a `<Valute>` block. The feed is flat
 * and CDATA-free, so a scoped, non-greedy match is safe and dependency-free.
 */
function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

/** Find the `<Valute>...</Valute>` block whose CharCode is USD. */
function extractUsdBlock(xml: string): string | null {
  const re = /<Valute\b[^>]*>[\s\S]*?<\/Valute>/gi;
  for (const match of xml.matchAll(re)) {
    const block = match[0];
    if (tagText(block, 'CharCode') === 'USD') return block;
  }
  return null;
}

/**
 * Pull the official CBR daily XML, defensively extract + normalise the USD
 * entry, Zod-parse at the boundary, and map it to a single RUB-per-USD
 * snapshot. `fetcher` is injectable for mock tests. Throws on a missing/garbage
 * body or a missing USD entry — the runner captures the error per-source (see
 * contract.ts), so one bad source degrades one widget, not the whole run.
 */
export async function collectCbr(
  fetcher: TextFetcher = defaultFetcher
): Promise<CollectorResult> {
  const xml = await fetcher(CBR_DAILY_URL);

  const dateAttr = extractDateAttr(xml);
  if (dateAttr === null) {
    throw new Error('CBR XML missing ValCurs Date attribute');
  }

  const usdBlock = extractUsdBlock(xml);
  if (usdBlock === null) {
    throw new Error('CBR XML missing USD valute entry');
  }

  const rawNominal = tagText(usdBlock, 'Nominal');
  const rawValue = tagText(usdBlock, 'Value');
  const rawCharCode = tagText(usdBlock, 'CharCode');
  if (rawNominal === null || rawValue === null || rawCharCode === null) {
    throw new Error('CBR XML USD entry missing required child fields');
  }

  const dateIso = moscowDateToIsoUtc(dateAttr);
  if (dateIso === null) {
    throw new Error(`CBR payload has unparseable Date: ${dateAttr}`);
  }

  // Parse at the boundary: downstream code works only with typed objects.
  const parsed = CbrDailySchema.parse({
    DateIso: dateIso,
    USD: {
      CharCode: rawCharCode,
      Nominal: parseCbrNumber(rawNominal),
      Value: parseCbrNumber(rawValue),
    },
  });

  // RUB per 1 USD. Nominal is schema-guaranteed a positive integer, so this
  // division is always a finite number.
  const rubPerUsd = parsed.USD.Value / parsed.USD.Nominal;

  const snapshot: SnapshotInput = {
    metric: METRIC_RUB_USD_RATE,
    source: SOURCE,
    ts: parsed.DateIso,
    value: rubPerUsd,
    raw_blob: JSON.stringify(parsed.USD),
    confidence: 1,
  };

  return { snapshots: [snapshot] };
}

/**
 * Pull the full RUB-per-USD daily series from CBR's XML_dynamic feed for
 * [from, to] and map every `<Record>` to a snapshot. One request returns the
 * whole war-to-now history (verified live 2026-05-19). Same windows-1251 /
 * comma-decimal / DD.MM.YYYY conventions as the daily feed; the `<Record>`
 * rows carry no CharCode (single-currency series). Throws on a
 * missing/garbage body or zero parseable records so the source stays
 * failure-isolated.
 */
export async function collectCbrHistory(
  fromMs: number,
  toMs: number,
  fetcher: TextFetcher = defaultFetcher
): Promise<CollectorResult> {
  const xml = await fetcher(cbrDynamicUrl(fromMs, toMs));

  const snapshots: SnapshotInput[] = [];
  const re = /<Record\b[^>]*\bDate="([^"]+)"[^>]*>([\s\S]*?)<\/Record>/gi;
  for (const m of xml.matchAll(re)) {
    const dateAttr = m[1];
    const block = m[2];
    const rawNominal = tagText(block, 'Nominal');
    const rawValue = tagText(block, 'Value');
    if (rawNominal === null || rawValue === null) continue; // skip partial row
    const dateIso = moscowDateToIsoUtc(dateAttr);
    if (dateIso === null) continue; // skip unparseable date, never fabricate

    const rec = CbrHistoryRecordSchema.safeParse({
      DateIso: dateIso,
      Nominal: parseCbrNumber(rawNominal),
      Value: parseCbrNumber(rawValue),
    });
    if (!rec.success) continue; // a malformed row must not poison the series

    snapshots.push({
      metric: METRIC_RUB_USD_RATE,
      source: SOURCE,
      ts: rec.data.DateIso,
      value: rec.data.Value / rec.data.Nominal,
      raw_blob: JSON.stringify({
        Date: dateAttr,
        Value: rec.data.Value,
        Nominal: rec.data.Nominal,
      }),
      confidence: 1,
    });
  }

  if (snapshots.length === 0) {
    throw new Error(
      `CBR XML_dynamic returned no parseable Record rows for ${cbrDynamicUrl(fromMs, toMs)}`
    );
  }
  return { snapshots };
}

export const cbrCollector: Collector = {
  name: SOURCE,
  async run(_env: Env): Promise<CollectorResult> {
    // History (war start → now) is the substantive series; the daily feed
    // adds the freshest business day in case XML_dynamic lags by one. Merge
    // and de-dupe on ts (filestore also dedupes on (metric,source,ts)).
    const hist = await collectCbrHistory(HISTORY_START_UTC, Date.now());
    let daily: CollectorResult = { snapshots: [] };
    try {
      daily = await collectCbr();
    } catch {
      // The historical series alone is sufficient; a transient daily-feed
      // failure must not drop the whole (already-fetched) history.
    }
    const byTs = new Map<string, SnapshotInput>();
    for (const s of [...hist.snapshots, ...daily.snapshots]) {
      byTs.set(s.ts, s);
    }
    return { snapshots: [...byTs.values()] };
  },
};
