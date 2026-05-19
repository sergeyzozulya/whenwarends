import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { generateBrief, type CreateMessage } from '../../src/lib/llm';
import type { BriefInput } from '../../src/lib/llm';
import type { Citation } from '../../src/lib/types';

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
