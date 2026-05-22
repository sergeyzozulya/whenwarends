// Anthropic SDK wrapper for the weekly editorial brief (Phase 3).
//
// Node-only (runs in scripts/draft-brief.ts, not the Worker). Drafts one brief
// per language with prompt caching, glossary + tone in the prompt, and
// structured-output citations. This module only GENERATES and validates a
// draft (citation allow-list, refusal + truncation guards); scripts/draft-brief
// .ts auto-publishes it verbatim to data/briefs.json. Per owner policy there is
// no human review gate — these integrity guards replace it (see CLAUDE.md).
//
// Caching strategy (see prompt-caching guidance): render order is
// system → messages. The frozen editorial constitution is identical across
// every language and every week → first cached system block. The per-locale
// glossary + tone changes rarely → second cached system block. The week's
// volatile data context goes in the user message, after the last breakpoint,
// so it never invalidates the cached prefix.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { LANGS, type Lang, type Citation, type NewsArticle, type NewsItem } from './types';

const MODEL = 'claude-opus-4-7';

// News selection + translation is light next to the brief, so it runs on a
// cheaper, faster model. Translation quality for uk/ru is the main concern;
// Sonnet handles it well.
const NEWS_MODEL = 'claude-sonnet-4-6';

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
- The site NEVER authors a prediction of its own. You only summarize market-derived numbers, observable dated events, and clearly-labelled context. State this caveat at most once and briefly — do not repeat it or pad the brief with disclaimers about what the site does not do.
- Lead with what CHANGED over the past week or two: movement and direction in the numbers (which rose, which fell, what held flat, what is stale or unavailable). Spend the brief on what the data did, not on restating every current level. You need not mention every metric — omit the flat, stale, or unavailable ones rather than listing them for completeness.
- Every factual claim must be traceable to one of the sources supplied in the user message. Do not introduce facts that are not in the provided data context.
- Do not invent, estimate, or extrapolate numbers. If the data is thin or a source is unavailable, say so plainly, once.
- No hype words, no emoji, sentence case, no markdown headings. Plain prose.
- This brief is auto-published verbatim after automated integrity checks; there is no human edit pass. Write it as the finished, published brief — accurate, self-contained, ready to ship.
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
      'ANTHROPIC_API_KEY is not set — required to draft the brief.'
    );
  }
  // maxRetries 4 (SDK default is 2): a daily unattended job hits transient
  // Anthropic overloads (HTTP 529) more often; the SDK retries with backoff.
  cachedClient ??= new Anthropic({ maxRetries: 4 });
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

// ---------------------------------------------------------------------------
// News selection + translation
//
// One language-neutral pass over the GDELT candidate pool: pick the most
// salient, non-duplicate, credible stories and translate each chosen title into
// all three site locales. The model returns INDICES into the supplied list (not
// URLs), so it cannot invent or alter a link — we map indices back to the
// trusted candidate objects. The same result feeds both the displayed news and
// the brief's headline context. Runs on NEWS_MODEL (cheaper than the brief).

const NewsSelectionSchema = z.object({
  picks: z.array(
    z.object({
      index: z.number().int(),
      uk: z.string(),
      en: z.string(),
      ru: z.string(),
    })
  ),
});

const NEWS_SELECT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      description: 'Chosen articles, most salient first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'uk', 'en', 'ru'],
        properties: {
          index: {
            type: 'integer',
            description: '0-based index into the supplied candidate list.',
          },
          uk: { type: 'string', description: 'Title translated into Ukrainian.' },
          en: { type: 'string', description: 'Title translated into English.' },
          ru: { type: 'string', description: 'Title translated into Russian.' },
        },
      },
    },
  },
};

function newsSelectionSystem(count: number): string {
  return `You curate "related news" for whenwarends.org, a calm, non-propaganda dashboard about the Russia–Ukraine war.

From the supplied candidate articles, choose the ${count} most useful for a reader tracking the war's trajectory and the question of when it ends. Then translate each chosen title into Ukrainian, English, and Russian.

Selection rules:
- Prefer recent reporting. Each candidate line is tagged with its publication date (YYYY-MM-DD) and the pool already covers roughly the past week; favour the freshest substantive stories, and choose an older item only when it is a genuinely major development still unfolding. Do not pick a stale story when comparable fresher coverage is present.
- Prefer substantive, credible reporting on the war and directly related diplomacy, economy, sanctions, or front-line developments. Drop off-topic, clickbait, thin-opinion, or duplicate items.
- Treat near-duplicates as one: if several candidates cover the same event (including the same story across different outlets or languages), keep only the single best and skip the rest.
- Favour a diversity of outlets and angles over many takes on one story.
- State-controlled and sanctioned propaganda outlets are already filtered out upstream; judge the remaining candidates on substance and credibility, and prefer mainstream reporting over fringe commentary.
- Order the picks most salient first. Return fewer than ${count} if the pool lacks enough good, distinct stories.

Translation rules:
- Translate each title faithfully and neutrally — no editorialising, no added words; preserve proper nouns and meaning.
- Sentence case; fix any stray spacing around punctuation from the source.
- If a title is already in the target language, return it cleaned up rather than awkwardly re-translated.

Return only structured output: the chosen articles as { index (0-based, into the supplied list), uk, en, ru }.`;
}

function buildNewsUserContent(candidates: NewsArticle[], count: number): string {
  const list = candidates
    .map((c, i) => {
      const date = c.seenAt ? c.seenAt.slice(0, 10) : 'date unknown';
      const meta = [c.domain, c.sourceCountry, c.language]
        .filter(Boolean)
        .join(' · ');
      return `[${i}] (${date}) ${c.title}${meta ? ` — ${meta}` : ''}`;
    })
    .join('\n');
  return [
    `Candidate articles (${candidates.length}); each line is "[index] (YYYY-MM-DD) title — domain · country · language":`,
    '',
    list,
    '',
    `Select the ${count} best per the rules and translate each chosen title into Ukrainian (uk), English (en), and Russian (ru).`,
  ].join('\n');
}

export interface NewsSelectionOptions {
  /** How many articles to pick (the model may return fewer). */
  count?: number;
}

/**
 * Pick the top news from a candidate pool and translate each chosen title into
 * all three locales. Throws on refusal/truncation/no-output so the caller can
 * keep any previous news file. Out-of-range or duplicate indices are dropped.
 */
export async function selectAndTranslateNews(
  candidates: NewsArticle[],
  opts: NewsSelectionOptions = {},
  createMessage: CreateMessage = defaultCreateMessage
): Promise<NewsItem[]> {
  const count = opts.count ?? 10;
  if (candidates.length === 0) return [];

  const response = await createMessage({
    model: NEWS_MODEL,
    max_tokens: 6000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: NEWS_SELECT_JSON_SCHEMA },
    },
    system: [
      {
        type: 'text',
        text: newsSelectionSystem(count),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: buildNewsUserContent(candidates, count) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `news: model refused (${response.stop_details?.explanation ?? 'no detail'})`
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('news: output truncated at max_tokens — raise max_tokens');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(`news: no text output (stop_reason=${response.stop_reason})`);
  }
  const parsed = NewsSelectionSchema.parse(JSON.parse(textBlock.text));

  const out: NewsItem[] = [];
  const used = new Set<number>();
  for (const p of parsed.picks) {
    if (p.index < 0 || p.index >= candidates.length || used.has(p.index)) continue;
    used.add(p.index);
    const c = candidates[p.index];
    // A blank translation falls back to the original title (never empty UI).
    const title = {} as Record<Lang, string>;
    const trans: Record<Lang, string> = { uk: p.uk, en: p.en, ru: p.ru };
    for (const lang of LANGS) title[lang] = trans[lang].trim() || c.title;
    out.push({
      url: c.url,
      domain: c.domain,
      seenAt: c.seenAt,
      sourceCountry: c.sourceCountry,
      image: c.image,
      flagged: c.flagged,
      original: c.title,
      title,
    });
    if (out.length >= count) break;
  }
  return out;
}
