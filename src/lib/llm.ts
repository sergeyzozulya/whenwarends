// Anthropic SDK wrapper for the weekly editorial brief (Phase 3).
//
// Node-only (runs in scripts/draft-brief.ts, not the Worker). Drafts one brief
// per language with prompt caching, glossary + tone in the prompt, and
// structured-output citations. The draft is written to data/briefs.json as
// `pending_review`; a human approves it via PR review (see CLAUDE.md). This
// module NEVER publishes.
//
// Caching strategy (see prompt-caching guidance): render order is
// system → messages. The frozen editorial constitution is identical across
// every language and every week → first cached system block. The per-locale
// glossary + tone changes rarely → second cached system block. The week's
// volatile data context goes in the user message, after the last breakpoint,
// so it never invalidates the cached prefix.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Lang, Citation } from './types';

const MODEL = 'claude-opus-4-7';

export interface BriefInput {
  lang: Lang;
  /** ISO date of the editorial week (UTC). */
  weekOf: string;
  /** Pre-rendered factual summary of the week's numbers and deltas. */
  dataContext: string;
  /** Allowed citations — the model may cite only these source URLs. */
  sources: Citation[];
  /** Locked terminology for this locale (glossary.{lang}.yaml contents). */
  glossary: string;
  /** Last week's published brief, for tone/continuity (optional). */
  previousBrief?: string;
}

export interface BriefResult {
  draft: string;
  citations: Citation[];
}

const BriefSchema = z.object({
  draft: z
    .string()
    .describe(
      'The editorial brief in the target language: 1–2 sober paragraphs, ~120–220 words, sentence case, no markdown headings, no emoji. Describes what the market-derived numbers and observable events did this week. Never authors a prediction of its own.'
    ),
  citations: z
    .array(
      z.object({
        source: z.string(),
        url: z.string(),
        title: z.string().optional(),
      })
    )
    .describe(
      'Every factual claim in the draft must map to one of the supplied sources. Use only the provided source URLs verbatim; do not invent or alter URLs.'
    ),
});

// Hand-written JSON Schema for output_config.format. Kept in lock-step with
// BriefSchema above. We don't use the SDK's zodOutputFormat helper because it
// targets zod v4 and this project is pinned to zod v3 (used across every
// collector schema); the server enforces this schema, we re-validate with
// BriefSchema on the way out.
const BRIEF_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['draft', 'citations'],
  properties: {
    draft: {
      type: 'string',
      description:
        'The editorial brief in the target language: 1–2 sober paragraphs, ~120–220 words, sentence case, no markdown, no emoji.',
    },
    citations: {
      type: 'array',
      description:
        'Every factual claim must map to one of the supplied sources. Use the provided URLs verbatim.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'url'],
        properties: {
          source: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
  },
};

// Frozen across all languages and weeks — the cacheable prefix.
const EDITORIAL_CONSTITUTION = `You draft the weekly editorial brief for whenwarends.org, a non-commercial, calm, transparent dashboard about when the Russia–Ukraine war ends.

Editorial posture (non-negotiable):
- Sober and restrained. Never sensational, never "casino".
- The site NEVER authors a prediction of its own. You only summarize market-derived numbers, observable dated events, and clearly-labelled context.
- Every factual claim must be traceable to one of the sources supplied in the user message. Do not introduce facts that are not in the provided data context.
- Do not invent, estimate, or extrapolate numbers. If the data is thin or a source is unavailable, say so plainly.
- No hype words, no emoji, sentence case, no markdown headings. Plain prose.
- This draft is reviewed by a human editor before any publication. Write it as a draft, not as a published verdict.
- Length: roughly 120–220 words. One or two short paragraphs.

Return the draft and the list of citations actually used, as structured output.`;

const TONE: Record<Lang, string> = {
  en: 'Write in English. Neutral, precise, internationally legible. Use the locked English terminology from the glossary.',
  uk: 'Write in Ukrainian (українською). Sober and respectful in register; this audience lives the war. Use the locked Ukrainian terminology from the glossary exactly.',
  ru: 'Write in Russian (по-русски). Neutral, factual, non-propagandistic register. Use the locked Russian terminology from the glossary exactly.',
};

function localeSystemBlock(lang: Lang, glossary: string): string {
  return `Target language and tone:
${TONE[lang]}

Locked glossary for this locale (use these translations verbatim for the listed terms):
${glossary.trim() || '(no glossary entries provided)'}`;
}

function userContent(input: BriefInput): string {
  const sourceList = input.sources
    .map(
      (s, i) =>
        `  [${i + 1}] ${s.title ? `${s.title} — ` : ''}${s.source} :: ${s.url}`
    )
    .join('\n');

  return [
    `Editorial week (UTC): ${input.weekOf}`,
    '',
    'Factual data context for this week (the ONLY facts you may use):',
    input.dataContext.trim(),
    '',
    'Allowed sources (cite only these; reuse the URL exactly):',
    sourceList || '  (none supplied — state that data is unavailable)',
    input.previousBrief
      ? `\nLast week's published brief (for continuity of tone; do not copy):\n${input.previousBrief.trim()}`
      : '',
    '',
    'Draft this week\'s brief now.',
  ].join('\n');
}

/**
 * Injectable message creator so unit tests never hit the network (mirrors the
 * collectors' injectable-fetcher pattern). Defaults to the real Anthropic
 * client; tests pass a stub returning a crafted Message.
 */
export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming
) => Promise<Anthropic.Message>;

let cachedClient: Anthropic | null = null;
const defaultCreateMessage: CreateMessage = (params) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — required to draft the weekly brief.'
    );
  }
  cachedClient ??= new Anthropic();
  return cachedClient.messages.create(params);
};

/**
 * Draft one brief for one language. Throws on refusal, truncation, or if the
 * model returns no structured output, so the caller can isolate the failure
 * per language.
 */
export async function generateBrief(
  input: BriefInput,
  createMessage: CreateMessage = defaultCreateMessage
): Promise<BriefResult> {
  const response = await createMessage({
    model: MODEL,
    // Adaptive thinking + effort:'high' on Opus 4.7 spends thinking tokens
    // against this cap; the visible brief is short but the reasoning is not,
    // so keep generous headroom (skill guidance: ~16000 non-streaming) — too
    // low and the JSON answer truncates and JSON.parse throws opaquely.
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: BRIEF_JSON_SCHEMA },
    },
    system: [
      {
        type: 'text',
        text: EDITORIAL_CONSTITUTION,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: localeSystemBlock(input.lang, input.glossary),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userContent(input) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `brief[${input.lang}]: model refused (${response.stop_details?.explanation ?? 'no detail'})`
    );
  }

  // Truncated output is unparseable JSON — fail explicitly per language
  // rather than letting JSON.parse throw an opaque SyntaxError below.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `brief[${input.lang}]: output truncated at max_tokens — raise max_tokens or lower effort`
    );
  }

  // The server enforced BRIEF_JSON_SCHEMA; re-validate with the zod schema as
  // defence in depth and to get a typed object.
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(
      `brief[${input.lang}]: no text output (stop_reason=${response.stop_reason})`
    );
  }
  const parsed = BriefSchema.parse(JSON.parse(textBlock.text));

  // Defence in depth: never cite a URL that was not in the allowed set.
  const allowed = new Set(input.sources.map((s) => s.url));
  const citations: Citation[] = parsed.citations.filter((c) =>
    allowed.has(c.url)
  );

  return { draft: parsed.draft.trim(), citations };
}
