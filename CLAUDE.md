# WhenWarEnds — Project Conventions for Claude Code

## One-paragraph summary

A non-commercial, Ukrainian-built dashboard that answers a single question with calm, transparent data: **when does this war end?** Static-first Astro site on Cloudflare's free tier (Workers + Static Assets), fed by free and open data sources only. Single-editor weekly cadence. Served in three languages (Ukrainian, English, Russian). Total cost under $15/month dominated by Anthropic API for the weekly AI-drafted, auto-published (integrity-guarded) editorial brief.

## Repository structure

```
whenwarends/
├── CLAUDE.md                          # This file
├── README.md
├── DEPLOY.md                          # Deployment & setup guide
├── package.json
├── tsconfig.json
├── astro.config.mjs
├── tailwind.config.ts
├── wrangler.toml                      # Cloudflare Workers (static assets only)
├── playwright.config.ts
├── src/
│   ├── pages/
│   │   └── [...lang]/                  # optional locale prefix: en at root, /uk, /ru
│   │       ├── index.astro
│   │       ├── methodology.astro
│   │       ├── about.astro
│   │       ├── sources.astro
│   │       ├── changelog.astro
│   │       └── og.png.ts               # build-time per-locale OG share image (satori+resvg)
│   ├── components/
│   │   ├── Header.astro
│   │   ├── Footer.astro
│   │   ├── HeroChart.tsx              # interactive island (Chart.js) — all markets, 3 marked picks
│   │   ├── StatCard.astro             # closest / consensus / optimistic summary card
│   │   ├── TrendBadge.astro           # ▲/▼ trend pill (renders only with ≥2 points)
│   │   ├── HistoryTimeline.tsx        # "war in data" timeline island
│   │   ├── BriefTimeline.astro        # inline brief archive
│   │   ├── Sparkline.astro            # pure SVG, no hydration
│   │   ├── EventList.astro
│   │   ├── IndicatorCard.astro
│   │   ├── DailyBrief.astro           # "This week": brief (left) + news (right)
│   │   └── RelatedNews.astro          # related-news column, locale-translated titles
│   ├── layouts/
│   │   └── Layout.astro
│   ├── lib/
│   │   ├── cdf.ts                     # isotonic regression, PCHIP interpolation
│   │   ├── cards.ts                   # qualify/weight markets, closest/consensus/optimistic picks
│   │   ├── heroChartData.ts           # chart payload shaping + probColor
│   │   ├── icons.ts                   # shared SVG path constants (chart + cards + OG)
│   │   ├── filestore.ts               # repo-file data store (read/append)
│   │   ├── homepage.ts                # build-time payload assembly
│   │   ├── briefContext.ts            # snapshot context for the brief prompt
│   │   ├── llm.ts                     # Anthropic wrapper: brief + news select/translate
│   │   ├── newsImages.ts              # download/downscale/cache article thumbnails
│   │   └── sources/
│   │       ├── warEndFilter.ts        # shared war-end market filter + resolution-date parse
│   │       ├── contract.ts            # fetch helpers (shared by collectors)
│   │       ├── polymarket.ts
│   │       ├── polymarket.schema.ts   # Zod
│   │       ├── manifold.ts
│   │       ├── manifold.schema.ts     # Zod
│   │       ├── oryx.ts                # equipment losses (CC BY-NC)
│   │       ├── kalshi.ts              # prepared collector, not yet in active registry
│   │       ├── gdelt.ts
│   │       ├── gdeltArticles.ts        # related-news artlist collector (pool)
│   │       ├── gdeltArticles.schema.ts # Zod
│   │       ├── denylist.ts             # state-media / propaganda source policy
│   │       ├── kiel.ts
│   │       ├── firms.ts
│   │       ├── worldbank.ts           # annual + Global Economic Monitor
│   │       ├── nbu.ts                 # UAH/USD FX
│   │       ├── nbuCpi.ts              # Ukraine monthly CPI
│   │       └── cbr.ts
│   ├── i18n/
│   │   ├── ui/{uk,en,ru}.json
│   │   ├── glossary/{uk,en,ru}.yaml   # (Phase 3)
│   │   └── index.ts
│   ├── workers/
│   │   └── collectors/                # registry + per-source re-exports
│   └── styles/global.css
├── scripts/
│   ├── collect.ts                     # weekly orchestrator (data → collect-news → draft-brief)
│   ├── collect-news.ts                # GDELT pool → AI select/translate → news.json
│   ├── draft-brief.ts                 # draft + auto-publish the weekly brief
│   ├── backfill-briefs.ts             # reconstruct + publish historical briefs
│   ├── isEntrypoint.ts                # run-as-CLI vs imported guard
│   └── ...                            # history importers, seeds, bundle check
├── data/                              # versioned data store (read at build)
│   ├── snapshots.ndjson               # append-only immutable history
│   ├── markets.json                   # current market state (derived picks + per-market)
│   ├── events.json                    # legacy editorial events (read, not rendered in UI)
│   ├── briefs.json                    # AI briefs (Phase 3)
│   ├── news.json                      # current related-news selection (locale-translated)
│   └── changelog.json                 # per-locale change log (id, date, category, description_{uk,en,ru})
├── worker/
│   └── index.ts                       # Worker entry: static assets + health
├── tests/
│   ├── unit/
│   │   ├── cdf.test.ts
│   │   └── sources/*.test.ts
│   └── e2e/
│       └── homepage.e2e.ts
├── .github/workflows/ci.yml
├── .gitignore
├── .env.example
└── .dev.vars.example
```

## Conventions

### TypeScript & strict mode

- **Always**: `npx tsc --noEmit` before committing. No `any` without inline comment.
- **Always**: Use `as const` for literal types; use `satisfies` for type checking without re-assignment.
- **Never**: Loose typing. If external API returns a union, narrow it with Zod or explicit type guards.

### Schemas & validation

- **Always**: Create a `*.schema.ts` Zod file for every external API before parsing.
- **Always**: Parse at the boundary (collector/LLM endpoint). Downstream code works with typed objects.
- **Example**: `src/lib/sources/polymarket.schema.ts` parses the Polymarket API response; `src/lib/sources/polymarket.ts` uses the schema and returns typed data.

### Time & numbers

- **Time**: UTC, stored as ISO-8601 strings (`2026-05-17T08:00:00Z`). Use `new Date().toISOString()`.
- **Money**: EUR; convert at ingest using daily ECB rates (free API).
- **Probabilities**: 0–1 floats internally; format to `"X%"` only at render time.
- **Confidence**: 0–1 floats for data quality signals.

### Components

- **`.astro` files**: Static; no hydration needed. Use for layout, lists, static text.
- **`.tsx` files**: Only when interactivity required (charts, forms). Mark with `client:visible` or `client:idle`.
- **No `client:only`**: Always pre-render on the server if possible.

### Routing & i18n

- **Optional locale prefix**: pages live under `src/pages/[...lang]/` with
  `prefixDefaultLocale: false`. English (the default locale) is served at the
  **root** (`/`, `/methodology`); uk/ru are prefixed (`/uk`, `/ru`). There is
  **no `/en` prefix** and no root redirect.
- **getStaticPaths** returns the three locales as
  `[{ params: { lang: undefined } }, { params: { lang: 'uk' } }, { params: { lang: 'ru' } }]`;
  derive the locale with `const lang = (Astro.params.lang ?? 'en') as Lang`.
- **Always build links with `localizedPath(lang, path)`** (`src/i18n/index.ts`) —
  it returns root-relative paths for en and prefixed paths for uk/ru. Never
  hardcode a locale segment.
- **Layout** emits canonical + hreflang alternates (uk/en/ru + `x-default`→en)
  and a per-locale `og:image` (`/og.png`, `/uk/og.png`, `/ru/og.png`).
- **Language preference**: a head script auto-detects from the browser on first
  visit and honours an explicit switch saved to `localStorage` thereafter.

### Styling

- **Tailwind utility classes** only. No inline CSS except within `<svg>` tags.
- **Typeface**: Inter (self-hosted via `@fontsource-variable/inter` — no third-party request; privacy posture). System stack is the fallback.
- **Typography**: 24px (hero h1), 22px (h1/lg), 18px (h2), 16px (body/sm), 13px (caption/xs). Two weights only: 400 (normal), 600 (medium).
- **Color**: One accent (#2c5aa0), grayscale otherwise. No tints, no fills. No emoji anywhere.
- **Sentence case** everywhere — body, headings, nav, labels, buttons. No Title Case, no ALL CAPS.
- **Quiet editorial**: white background, generous whitespace, strong type hierarchy. Structure with hairline `border-gray-200` rules/dividers — no card shadows, no background fills, no rounded "panels". A single thin accent rule may mark the masthead. Restraint is the identity; never sensational.

### Testing

- **Unit tests**: `src/**/*.test.ts` using Vitest. Run: `npm run test`.
- **E2E tests**: `tests/e2e/**/*.e2e.ts` using Playwright. Run: `npm run test:e2e`.
- **CDF changes**: Always add a unit test for `src/lib/cdf.ts` before committing logic changes.
- **Collectors**: Test with mock data before hitting real APIs.

### Git workflow

- **Branches**: `phase-N/<short-description>`. Example: `phase-1/polymarket-cdf`.
- **Commits**: Conventional Commits. Examples: `feat: add Polymarket collector`, `fix: PCHIP interpolation edge case`, `docs: update README`.
- **PR**: Open against `main`. Merge only when CI passes (typecheck, lint, build, E2E).

### Secrets & environment

- **Never** commit `.dev.vars` or `.env`. Template files end with `.example`.
- **Production secrets**: Set via `wrangler secret put NAME` or Cloudflare dashboard.
- **Local dev**: Copy `.env.example` → `.env` and `.dev.vars.example` → `.dev.vars`, then fill in your keys.
- **Anthropic API key**: `ANTHROPIC_API_KEY` in `.dev.vars` (local) or `wrangler secret` (production).

### Data storage (no database)

- **No D1/KV.** Data lives in versioned repo files under `data/`, read at
  build time by `src/lib/homepage.ts`. See `data/changelog.json` (2026-05-18)
  for the rationale.
- **Immutable snapshots**: append to `data/snapshots.ndjson`, never rewrite a
  line. `src/lib/filestore.ts` dedupes on `(metric, source, ts)`.
- **History / audit / backup**: git. The collect commit is the audit trail.
- **Collection**: `npm run collect` (or weekly via
  `.github/workflows/collect.yml`) runs the collectors and commits `data/`;
  the push triggers a rebuild + deploy.
- **No SQL**: collectors return typed objects; the runner persists via
  `filestore.ts`. No injection surface.

### AI & editorial

- **Auto-publish, no human review gate** (owner decision, 2026-05-18; see
  `data/changelog.json`). `scripts/draft-brief.ts` writes briefs straight to
  `briefs.status = 'published'` on each data refresh; `scripts/backfill-briefs.ts`
  publishes reconstructed historical briefs the same way. There is no
  `pending_review` hop. This **replaces** the former "never auto-publish /
  require human approval" rule — that rule is retired, not merely waived.
- **Integrity safeguards are non-negotiable and replace review.** A brief may
  only ship if it passes the `src/lib/llm.ts` guards: enforced citation
  allow-list (never cite a URL not supplied), refusal guard, and truncation
  (`max_tokens`) guard. Generation is per-language isolated — a language that
  throws is skipped, so a prior good brief survives rather than being
  overwritten with garbage. The git commit is the audit trail.
- **Reconstructed briefs must be labelled.** Backfilled briefs carry
  `reconstructed: true` and the UI labels them "reconstructed from archived
  data" — never presented as written at the time. They are grounded strictly
  in `data/snapshots.ndjson` as of their date; never fabricated or
  forward-looking.
- **Glossary**: Separate `.yaml` per locale. AI prompt includes glossary to ensure consistent terminology.
- **Citations**: Every claim in the brief must have a source URL. Stored in `briefs.citations` as JSON.

### Licensing

- **GDELT, Kiel, NASA FIRMS, Manifold, World Bank**: CC BY or public domain. Always credit.
- **Oryx**: CC BY-**NC** — usable only because this project is non-commercial; always credit. Do not reuse Oryx data in any commercial context.

### Phase structure

**Phase 0** (done): Repo + CI + Astro skeleton + i18n routing + Workers + Tailwind.

**Phase 1** (done): Hero CDF chart live with real data (uk/en/ru). Polymarket + Manifold collectors, CDF computation, HeroChart island plotting all qualifying markets sized by liquidity, and three labelled summary cards — **closest** (nearest resolution date), **consensus** (liquidity-weighted centroid of probability and date), **optimistic** (highest probability). See `src/lib/cards.ts` and `docs/SPEC.md` §8.

**Phase 2** (done): Secondary "war in data" timeline + collectors (GDELT, Kiel, NBU FX, NBU CPI, CBR, World Bank Indicators + Global Economic Monitor, FIRMS). The earlier "today on the ground" cards and editorial event list were removed.

**Phase 3**: Brief generation — auto-published on data refresh
(`draft-brief.ts`), historical backfill (`backfill-briefs.ts`), inline brief
timeline, glossary review. No admin/review page (auto-publish; integrity
guards in `llm.ts` replace review).

**Phase 4** (done): Polish + launch — initial public version (see `data/changelog.json`).

### Always do

- Run `npm run typecheck && npm run lint && npm run build` before pushing.
- Add a Zod schema before parsing any external API response.
- Add a unit test before changing `src/lib/cdf.ts`.
- Use `npm run wrangler:dev` locally to test Worker routes.
- Verify i18n pages render in all three locales: en at the root (`/`, `/methodology`, …), uk/ru prefixed (`/uk/`, `/ru/`). Never hardcode locale prefixes — always build hrefs with `localizedPath(lang, path)`.

### Never do

- Commit `.dev.vars`, `.env`, secrets, or private keys.
- Ship a brief that bypasses the `src/lib/llm.ts` integrity guards (citation
  allow-list, refusal, truncation) — these replace human review and are not
  optional. (Auto-publishing itself is now intended; see "AI & editorial".)
- Present a reconstructed (backfilled) brief as if written at the time, or
  ground one in anything other than `data/snapshots.ndjson` as of its date.
- Add emoji to the UI.
- Use `any` without an inline justification comment.
- Ship hardcoded "war is ongoing" assumptions. Schema must support "war ended" pivot.

## Data sources & licensing

| Source | Use | License | Notes |
|---|---|---|---|
| Polymarket Gamma + Data API | War-end probabilities + per-market history (one of two market sources) | Public, viewable globally | Free, no auth |
| Manifold Markets API | War-end / ceasefire markets (play money); per-bet history (second market source) | Public (CC BY 4.0) | Free, no auth |
| GDELT 2.0 DOC API | Conflict volume intensity + tone (timeline); related-news article list (artlist) | CC BY | Free; ~1 req / 5 s rate limit |
| Kiel Ukraine Support Tracker | Aid commitments (.xlsx) | CC BY 4.0 | Free download; `KIEL_DATASET_URL` |
| NASA FIRMS | Fire/heat anomalies (combat proxy) | Public domain | Free API key (`FIRMS_MAP_KEY`) |
| Oryx (machine-readable mirror) | Visually-confirmed RU/UA equipment losses (cumulative) | CC BY-NC | Free; non-commercial use only |
| World Bank (Indicators + Global Economic Monitor) | RU annual macro; RU monthly CPI; RU/UA quarterly real GDP | Public | Free API |
| National Bank of Ukraine | UAH/USD FX; Ukraine monthly headline CPI | Public | Free API |
| Central Bank of Russia | RUB/USD FX (official daily) | Public | Free |
| European Central Bank (via Frankfurter) | Daily reference rates for EUR conversion | Public | Free |

Both market sources feed the war-end CDF: probabilities are normalized **per
source**, then combined **50/50** (no source dominates on raw liquidity). See
`src/lib/cards.ts` (qualify → weight → derive) and `docs/SPEC.md` §8.

Implemented collectors only — registry: `src/workers/collectors/index.ts`. A
Kalshi collector exists (`src/lib/sources/kalshi.ts`) but is not yet in the
active registry. UCDP, IMF, Metaculus, ISW, Russia Matters were considered but
are not collected.

**Related news (shown beside the brief).** GDELT's `artlist` mode (no language
filter, relevance-sorted) supplies a multilingual candidate pool. Source policy
lives in `src/lib/sources/denylist.ts` — `isBlockedSource()` hard-drops Tier-1
state/sanctioned media and the Pravda/Doppelganger swarm patterns, and *flags*
Tier-2 amplifiers (kept, shown with a "flagged source" warning that links to
the methodology). One Sonnet pass (`selectAndTranslateNews` in `llm.ts`) picks
the top ~10 by index and translates each title into uk/en/ru; thumbnails are
downscaled (≤100px WebP) and cached under `public/news/` (`newsImages.ts`) so
no third-party image request is made. `scripts/collect-news.ts` writes
`data/news.json`; the brief consumes the picked headlines as cite-able context
(numbers stay the backbone). `npm run collect` runs data → news → brief.

## Cost envelope (realistic, weekly cadence)

- Anthropic Claude API: ~$2–8/month (1 brief/week × 3 langs, with prompt caching)
- Cloudflare (Workers + Static Assets, Email, Analytics): $0
- GitHub Actions (weekly collection + CI): $0 (public repo / free tier)
- Domain (annualized): ~$1/month
- GitHub + Sentry: $0
- **Total**: ~$3–9/month. Easily under $15/month.

## Editorial calendar (Phase 3+)

**Weekly cadence**: Sunday 08:00 UTC data pull → if the data changed, LLM
draft → integrity guards (`llm.ts`) → auto-publish + commit (one push →
rebuild + deploy). No editor step. Historical archive backfilled on demand
via `npm run backfill-briefs` (manual, not CI; idempotent).

**Glossary review** (separate, async): Weekly review of AI-generated terminology for accuracy and tone per language.

**Changelog**: Every decision logged with `date, description, category` (new source, schema change, methodology update, etc.).

---

**Last updated**: 20 May 2026 · Update via PR to this file · Track changes in `/changelog`.
