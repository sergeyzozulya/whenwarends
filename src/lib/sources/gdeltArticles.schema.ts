import { z } from 'zod';

// GDELT DOC 2.0 API — Zod schema for the `mode=artlist` JSON response.
//
// Real endpoint (CC BY 4.0, no auth required):
//
//   https://api.gdeltproject.org/api/v2/doc/doc
//     ?query=(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng
//     &mode=artlist
//     &maxrecords=50
//     &sort=datedesc
//     &format=json
//
// Unlike the timeline modes (see gdelt.schema.ts), artlist returns the matching
// news articles themselves: title, canonical URL, the originating domain, the
// time GDELT first saw the article (`seendate`, compact `YYYYMMDDTHHMMSSZ`
// UTC), and source country/language metadata. A zero-result query can come back
// as `{}` or `{"articles":[]}`, so `articles` is optional and defaults to [].
// `.passthrough()` keeps GDELT free to add fields (url_mobile, socialimage, …)
// without breaking the parse — we only consume the fields below.

// Per-article fields are lenient (missing strings default to ''): GDELT
// occasionally emits an article with a blank title or url, and one noisy entry
// must not reject the whole batch. curateArticles() drops the empty ones. A
// structurally-wrong response (e.g. `articles` not an array) still throws.
export const GdeltArticleSchema = z
  .object({
    url: z.string().default(''),
    title: z.string().default(''),
    // Compact UTC form e.g. "20260521T120000Z"; normalized in the collector.
    seendate: z.string().optional().default(''),
    domain: z.string().optional().default(''),
    // Publisher share/OG image URL. Often present, sometimes empty.
    socialimage: z.string().optional().default(''),
    language: z.string().optional(),
    sourcecountry: z.string().optional(),
  })
  .passthrough();

export type GdeltArticle = z.infer<typeof GdeltArticleSchema>;

export const GdeltArtListResponseSchema = z
  .object({
    articles: z.array(GdeltArticleSchema).optional().default([]),
  })
  .passthrough();

export type GdeltArtListResponse = z.infer<typeof GdeltArtListResponseSchema>;
