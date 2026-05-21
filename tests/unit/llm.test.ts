import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  generateBrief,
  selectAndTranslateNews,
  type CreateMessage,
} from '../../src/lib/llm';
import type { BriefInput } from '../../src/lib/llm';
import type { Citation, NewsArticle } from '../../src/lib/types';

// The brief may cite only these. The model is told to reuse the URLs verbatim;
// llm.ts enforces the allow-list as defence in depth.
const SOURCES: Citation[] = [
  { source: 'Polymarket', url: 'https://polymarket.com', title: 'Forecast' },
  { source: 'GDELT', url: 'https://www.gdeltproject.org' },
];

const baseInput: BriefInput = {
  lang: 'en',
  weekOf: '2026-05-17',
  dataContext: 'Median war-end date: 2027-03-01.',
  sources: SOURCES,
  glossary: 'ceasefire: ceasefire',
};

// Build a minimal Anthropic.Message. generateBrief only reads stop_reason,
// stop_details?.explanation, and content[].{type,text}; the cast is the
// contained, justified escape for not stubbing the whole SDK response object.
function message(
  partial: Partial<Anthropic.Message> & Pick<Anthropic.Message, 'stop_reason'>
): Anthropic.Message {
  return { content: [], stop_details: null, ...partial } as Anthropic.Message;
}

const textMsg = (json: string): Anthropic.Message =>
  message({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: json } as Anthropic.ContentBlock],
  });

describe('generateBrief', () => {
  it('parses the structured draft and returns trimmed text + citations', async () => {
    const stub: CreateMessage = async () =>
      textMsg(
        JSON.stringify({
          draft: '  The market-implied median moved later this week.  ',
          citations: [{ source: 'Polymarket', url: 'https://polymarket.com' }],
        })
      );

    const { draft, citations } = await generateBrief(baseInput, stub);
    expect(draft).toBe('The market-implied median moved later this week.');
    expect(citations).toEqual([
      { source: 'Polymarket', url: 'https://polymarket.com' },
    ]);
  });

  it('drops citations whose URL is not in the allowed set', async () => {
    const stub: CreateMessage = async () =>
      textMsg(
        JSON.stringify({
          draft: 'A sober summary.',
          citations: [
            { source: 'GDELT', url: 'https://www.gdeltproject.org' },
            { source: 'Fabricated', url: 'https://evil.example/made-up' },
          ],
        })
      );

    const { citations } = await generateBrief(baseInput, stub);
    expect(citations).toEqual([
      { source: 'GDELT', url: 'https://www.gdeltproject.org' },
    ]);
  });

  it('sends Opus 4.7 config: adaptive thinking, effort+json_schema, two cached system blocks', async () => {
    let seen: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stub: CreateMessage = async (params) => {
      seen = params;
      return textMsg(JSON.stringify({ draft: 'ok', citations: [] }));
    };

    await generateBrief(baseInput, stub);
    expect(seen?.model).toBe('claude-opus-4-7');
    expect(seen?.thinking).toEqual({ type: 'adaptive' });
    expect(seen?.output_config?.effort).toBe('high');
    expect(seen?.output_config?.format?.type).toBe('json_schema');
    // Frozen constitution + per-locale block, both cached for prefix reuse.
    expect(Array.isArray(seen?.system)).toBe(true);
    const sys = seen?.system as Anthropic.TextBlockParam[];
    expect(sys).toHaveLength(2);
    expect(sys.every((b) => b.cache_control?.type === 'ephemeral')).toBe(true);
  });

  it('throws with the explanation on a refusal', async () => {
    const stub: CreateMessage = async () =>
      message({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      } as Partial<Anthropic.Message> & Pick<Anthropic.Message, 'stop_reason'>);

    await expect(generateBrief(baseInput, stub)).rejects.toThrow(
      /brief\[en\]: model refused \(no\)/
    );
  });

  it('throws an explicit error on max_tokens truncation (no opaque JSON.parse)', async () => {
    const stub: CreateMessage = async () =>
      message({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '{"draft":"hal' } as Anthropic.ContentBlock],
      });

    await expect(generateBrief(baseInput, stub)).rejects.toThrow(
      /truncated at max_tokens/
    );
  });

  it('throws when the model returns no text block', async () => {
    const stub: CreateMessage = async () => message({ stop_reason: 'end_turn' });
    await expect(generateBrief(baseInput, stub)).rejects.toThrow(
      /brief\[en\]: no text output/
    );
  });
});

const CANDIDATES: NewsArticle[] = [
  {
    title: 'Talks resume in Geneva',
    url: 'https://reuters.com/a',
    domain: 'reuters.com',
    seenAt: '2026-05-21T12:00:00.000Z',
    sourceCountry: 'United Kingdom',
    language: 'English',
    image: 'https://reuters.com/a.jpg',
  },
  {
    title: 'Front-line shelling continues',
    url: 'https://apnews.com/b',
    domain: 'apnews.com',
    seenAt: '2026-05-21T09:00:00.000Z',
  },
  {
    title: 'Переговоры в Женеве',
    url: 'https://example.fr/c',
    domain: 'example.fr',
    seenAt: '2026-05-20T18:00:00.000Z',
    language: 'Russian',
  },
];

const picksMsg = (picks: unknown): Anthropic.Message =>
  textMsg(JSON.stringify({ picks }));

describe('selectAndTranslateNews', () => {
  it('maps picked indices to NewsItems with localized titles, salient order kept', async () => {
    const stub: CreateMessage = async () =>
      picksMsg([
        { index: 1, uk: 'Обстріли тривають', en: 'Shelling continues', ru: 'Обстрелы продолжаются' },
        { index: 0, uk: 'Переговори в Женеві', en: 'Talks in Geneva', ru: 'Переговоры в Женеве' },
      ]);

    const out = await selectAndTranslateNews(CANDIDATES, { count: 10 }, stub);
    expect(out.map((i) => i.url)).toEqual([
      'https://apnews.com/b',
      'https://reuters.com/a',
    ]);
    expect(out[0].title).toEqual({
      uk: 'Обстріли тривають',
      en: 'Shelling continues',
      ru: 'Обстрелы продолжаются',
    });
    expect(out[0].original).toBe('Front-line shelling continues');
    // Trusted candidate fields are carried over, not taken from the model.
    expect(out[1].image).toBe('https://reuters.com/a.jpg');
  });

  it('drops out-of-range and duplicate indices', async () => {
    const stub: CreateMessage = async () =>
      picksMsg([
        { index: 0, uk: 'а', en: 'a', ru: 'а' },
        { index: 99, uk: 'x', en: 'x', ru: 'x' },
        { index: 0, uk: 'dup', en: 'dup', ru: 'dup' },
      ]);
    const out = await selectAndTranslateNews(CANDIDATES, {}, stub);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://reuters.com/a');
  });

  it('falls back to the original title when a translation is blank', async () => {
    const stub: CreateMessage = async () =>
      picksMsg([{ index: 0, uk: 'ок', en: '   ', ru: 'ок' }]);
    const out = await selectAndTranslateNews(CANDIDATES, {}, stub);
    expect(out[0].title.en).toBe('Talks resume in Geneva');
  });

  it('returns [] without calling the model when there are no candidates', async () => {
    let called = false;
    const stub: CreateMessage = async () => {
      called = true;
      return picksMsg([]);
    };
    expect(await selectAndTranslateNews([], {}, stub)).toEqual([]);
    expect(called).toBe(false);
  });

  it('runs on Sonnet with json_schema structured output and a cached system block', async () => {
    let seen: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stub: CreateMessage = async (params) => {
      seen = params;
      return picksMsg([]);
    };
    await selectAndTranslateNews(CANDIDATES, {}, stub);
    expect(seen?.model).toBe('claude-sonnet-4-6');
    expect(seen?.output_config?.format?.type).toBe('json_schema');
    const sys = seen?.system as Anthropic.TextBlockParam[];
    expect(sys).toHaveLength(1);
    expect(sys[0].cache_control?.type).toBe('ephemeral');
  });

  it('carries the Tier-2 flagged marker through to the NewsItem', async () => {
    const stub: CreateMessage = async () =>
      picksMsg([{ index: 0, uk: 'а', en: 'a', ru: 'а' }]);
    const out = await selectAndTranslateNews(
      [{ ...CANDIDATES[0], flagged: true }],
      {},
      stub
    );
    expect(out[0].flagged).toBe(true);
  });
});
