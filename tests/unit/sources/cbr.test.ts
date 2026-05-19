import { describe, it, expect } from 'vitest';
import {
  collectCbr,
  collectCbrHistory,
  cbrCollector,
  cbrDynamicUrl,
  CBR_DAILY_URL,
  CBR_USD_VAL_NM,
  SOURCE,
  METRIC_RUB_USD_RATE,
  type TextFetcher,
} from '../../../src/lib/sources/cbr';

// Real captured https://www.cbr.ru/scripts/XML_daily.asp body (16 May 2026,
// truncated to USD/EUR/AMD). The official feed:
//   - is windows-1251 XML (the collector's defaultFetcher decodes it; mocks
//     supply an already-decoded string, as the network layer would yield),
//   - uses a comma decimal separator ("73,1275"),
//   - has a Moscow calendar `Date="DD.MM.YYYY"` (no time, no offset),
//   - quotes some currencies per Nominal 10/100 (AMD here) — proving the
//     Value/Nominal handling, though we only emit USD.
const sampleXml = `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="16.05.2026" name="Foreign Currency Market"><Valute ID="R01060"><NumCode>051</NumCode><CharCode>AMD</CharCode><Nominal>100</Nominal><Name>Армянских драмов</Name><Value>19,8592</Value><VunitRate>0,198592</VunitRate></Valute><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>73,1275</Value><VunitRate>73,1275</VunitRate></Valute><Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>Евро</Name><Value>82,4501</Value><VunitRate>82,4501</VunitRate></Valute></ValCurs>`;

const mockFetcher =
  (body: string): TextFetcher =>
  async (url: string) => {
    expect(url).toBe(CBR_DAILY_URL);
    return body;
  };

describe('cbr collector', () => {
  it('parses the XML and emits one rub_usd_rate snapshot', async () => {
    const { snapshots, markets } = await collectCbr(mockFetcher(sampleXml));

    expect(markets).toBeUndefined();
    expect(snapshots).toHaveLength(1);

    const [snap] = snapshots;
    expect(snap.metric).toBe(METRIC_RUB_USD_RATE);
    expect(snap.metric).toBe('rub_usd_rate');
    expect(snap.source).toBe(SOURCE);
    expect(snap.source).toBe('cbr');
    expect(snap.confidence).toBe(1);
  });

  it('normalises the comma decimal and computes RUB-per-USD as Value / Nominal', async () => {
    const { snapshots } = await collectCbr(mockFetcher(sampleXml));
    // USD Nominal is 1, so value === Value ("73,1275" → 73.1275).
    expect(snapshots[0].value).toBeCloseTo(73.1275, 6);
  });

  it('applies Nominal in the per-unit computation', async () => {
    // Rewrite USD to be quoted per 100 units → RUB-per-USD must be Value / 100.
    const xml = sampleXml
      .replace(
        '<CharCode>USD</CharCode><Nominal>1</Nominal>',
        '<CharCode>USD</CharCode><Nominal>100</Nominal>'
      )
      .replace(
        '<Name>Доллар США</Name><Value>73,1275</Value>',
        '<Name>Доллар США</Name><Value>7312,75</Value>'
      );

    const { snapshots } = await collectCbr(mockFetcher(xml));
    expect(snapshots[0].value).toBeCloseTo(73.1275, 6);
  });

  it('converts the Moscow DD.MM.YYYY date to canonical UTC ISO-8601', async () => {
    const { snapshots } = await collectCbr(mockFetcher(sampleXml));
    const { ts } = snapshots[0];

    // 16.05.2026 effective 00:00 Moscow (+03:00) → 2026-05-15T21:00:00Z.
    expect(ts).toBe('2026-05-15T21:00:00.000Z');
    expect(ts).toBe(new Date(ts).toISOString());
    expect(ts.endsWith('Z')).toBe(true);
  });

  it('stores the parsed USD entry in raw_blob', async () => {
    const { snapshots } = await collectCbr(mockFetcher(sampleXml));
    const blob = JSON.parse(snapshots[0].raw_blob ?? 'null');
    expect(blob.CharCode).toBe('USD');
    expect(blob.Value).toBeCloseTo(73.1275, 6);
    expect(blob.Nominal).toBe(1);
  });

  it('throws on an unparseable Date attribute', async () => {
    const xml = sampleXml.replace('Date="16.05.2026"', 'Date="not-a-date"');
    await expect(collectCbr(mockFetcher(xml))).rejects.toThrow(
      /unparseable Date/
    );
  });

  it('throws when the ValCurs Date attribute is absent', async () => {
    const xml = sampleXml.replace(' Date="16.05.2026"', '');
    await expect(collectCbr(mockFetcher(xml))).rejects.toThrow(
      /missing ValCurs Date/
    );
  });

  it('throws on a garbage (non-XML) body', async () => {
    await expect(
      collectCbr(mockFetcher('totally not xml shaped'))
    ).rejects.toThrow();
  });

  it('throws on an empty body', async () => {
    await expect(collectCbr(mockFetcher(''))).rejects.toThrow();
  });

  it('throws when the USD valute entry is absent', async () => {
    // Drop the whole USD <Valute> block; EUR/AMD remain so the XML is valid.
    const xml = sampleXml.replace(
      /<Valute ID="R01235">[\s\S]*?<\/Valute>/,
      ''
    );
    await expect(collectCbr(mockFetcher(xml))).rejects.toThrow(/missing USD/);
  });

  it('rejects a non-positive Nominal at the schema boundary', async () => {
    const xml = sampleXml.replace(
      '<CharCode>USD</CharCode><Nominal>1</Nominal>',
      '<CharCode>USD</CharCode><Nominal>0</Nominal>'
    );
    await expect(collectCbr(mockFetcher(xml))).rejects.toThrow();
  });

  it('rejects a non-numeric Value at the schema boundary', async () => {
    // A malformed Value that cannot be coerced → NaN → schema rejects.
    const xml = sampleXml.replace(
      '<Value>73,1275</Value>',
      '<Value>not-a-number</Value>'
    );
    await expect(collectCbr(mockFetcher(xml))).rejects.toThrow();
  });

  it('exposes a Collector with the stable name', () => {
    expect(cbrCollector.name).toBe(SOURCE);
    expect(typeof cbrCollector.run).toBe('function');
  });
});

// Real captured https://www.cbr.ru/scripts/XML_dynamic.asp shape (2026-05-19):
// single-currency series, `<Record Date="DD.MM.YYYY">` rows with comma
// decimals and no CharCode/NumCode.
const dynamicXml = `<?xml version="1.0" encoding="windows-1251"?><ValCurs ID="R01235" DateRange1="24.02.2022" DateRange2="01.03.2022" name="Foreign Currency Market Dynamic"><Record Date="25.02.2022" Id="R01235"><Nominal>1</Nominal><Value>86,9288</Value><VunitRate>86,9288</VunitRate></Record><Record Date="26.02.2022" Id="R01235"><Nominal>1</Nominal><Value>83,5485</Value><VunitRate>83,5485</VunitRate></Record></ValCurs>`;

describe('cbr history (XML_dynamic)', () => {
  const FROM = Date.UTC(2022, 1, 24);
  const TO = Date.UTC(2022, 2, 1);

  it('builds a DD/MM/YYYY USD dynamic URL', () => {
    const u = cbrDynamicUrl(FROM, TO);
    expect(u).toContain('date_req1=24/02/2022');
    expect(u).toContain('date_req2=01/03/2022');
    expect(u).toContain(`VAL_NM_RQ=${CBR_USD_VAL_NM}`);
    expect(u.startsWith('https://www.cbr.ru/scripts/XML_dynamic.asp?')).toBe(
      true
    );
  });

  it('maps every Record to a rub_usd_rate snapshot, comma-decimals normalised', async () => {
    const fetcher: TextFetcher = async () => dynamicXml;
    const { snapshots } = await collectCbrHistory(FROM, TO, fetcher);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.metric === METRIC_RUB_USD_RATE)).toBe(true);
    expect(snapshots.every((s) => s.source === SOURCE)).toBe(true);
    expect(snapshots[0].value).toBeCloseTo(86.9288, 6);
    expect(snapshots[1].value).toBeCloseTo(83.5485, 6);
    // 25.02.2022 00:00 Moscow (+03:00) → 24.02.2022 21:00Z.
    expect(snapshots[0].ts).toBe('2022-02-24T21:00:00.000Z');
    expect(new Date(snapshots[0].ts).toISOString()).toBe(snapshots[0].ts);
  });

  it('skips malformed rows but never fabricates, and fails on an empty body', async () => {
    const partial = dynamicXml.replace(
      '<Record Date="26.02.2022" Id="R01235"><Nominal>1</Nominal><Value>83,5485</Value><VunitRate>83,5485</VunitRate></Record>',
      '<Record Date="26.02.2022" Id="R01235"><Nominal>1</Nominal></Record>'
    );
    const { snapshots } = await collectCbrHistory(
      FROM,
      TO,
      async () => partial
    );
    expect(snapshots).toHaveLength(1); // the partial row is skipped, not faked

    await expect(
      collectCbrHistory(FROM, TO, async () => '<ValCurs></ValCurs>')
    ).rejects.toThrow(/no parseable Record/);
  });
});
