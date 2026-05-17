# WhenWarEnds — Project Conventions for Claude Code

## One-paragraph summary

A non-commercial, Ukrainian-built dashboard that answers a single question with calm, transparent data: **when does this war end?** Static-first Astro site on Cloudflare's free tier (Workers + Static Assets), fed by free and open data sources only. Single-editor weekly cadence. Served in three languages (Ukrainian, English, Russian). Total cost under $15/month dominated by Anthropic API for the weekly AI-drafted, human-reviewed editorial brief.

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
├── wrangler.toml                      # Cloudflare Workers + D1 + KV
├── playwright.config.ts
├── src/
│   ├── pages/
│   │   └── [lang]/
│   │       ├── index.astro
│   │       ├── methodology.astro
│   │       ├── about.astro
│   │       ├── sources.astro
│   │       └── changelog.astro
│   ├── components/
│   │   ├── Header.astro
│   │   ├── Footer.astro
│   │   ├── HeroChart.tsx              # interactive island (Chart.js)
│   │   ├── Sparkline.astro            # pure SVG, no hydration
│   │   ├── EventList.astro
│   │   ├── IndicatorCard.astro
│   │   └── DailyBrief.astro
│   ├── layouts/
│   │   └── Layout.astro
│   ├── lib/
│   │   ├── cdf.ts                     # isotonic regression, PCHIP interpolation
│   │   ├── db.ts                      # D1 query helpers
│   │   ├── kv.ts                      # KV cache helpers
│   │   ├── llm.ts                     # Anthropic client wrapper
│   │   └── sources/
│   │       ├── polymarket.ts
│   │       ├── polymarket.schema.ts   # Zod
│   │       ├── kalshi.ts
│   │       ├── gdelt.ts
│   │       ├── kiel.ts
│   │       ├── firms.ts
│   │       ├── worldbank.ts
│   │       ├── nbu.ts
│   │       └── cbr.ts
│   ├── i18n/
│   │   ├── ui/{uk,en,ru}.json
│   │   ├── glossary/{uk,en,ru}.yaml   # (Phase 3)
│   │   └── index.ts
│   ├── workers/
│   │   ├── collectors/                # one per source, scheduled
│   │   ├── llm-brief.ts               # weekly brief generator
│   │   └── admin-api.ts               # editor approval endpoints
│   └── styles/global.css
├── worker/
│   └── index.ts                       # Worker entry point (wrangler main)
├── migrations/
│   └── 0001_initial.sql               # D1 schema
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

### Styling

- **Tailwind utility classes** only. No inline CSS except within `<svg>` tags.
- **Typography**: 22px (h1/lg), 16px (body/sm), 13px (caption/xs). Two weights only: 400 (normal), 500 (medium).
- **Color**: One accent (#2c5aa0), grayscale otherwise. No emoji anywhere.
- **Sentence case** for all UI copy. No Title Case, no ALL CAPS.

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

### Database

- **D1 schema** in `migrations/0001_initial.sql`. Immutable snapshots (never overwrite a row).
- **Backups**: Daily to R2 (also free tier). Script in `DEPLOY.md`.
- **Queries**: Use `src/lib/db.ts` helpers to avoid SQL injection.

### AI & editorial

- **Never** auto-publish AI output. Always require human approval.
- **Drafts** go to `briefs.status = 'pending_review'`. Editor approves to `published`.
- **Glossary**: Separate `.yaml` per locale. AI prompt includes glossary to ensure consistent terminology.
- **Citations**: Every claim in the brief must have a source URL. Stored in `briefs.citations` as JSON.

### Licensing

- **ISW daily assessments**: Cite and link. Fair-use summary only; never republish the full assessment.
- **Russia Matters**: Same — cite, link, summarize, don't republish.
- **GDELT, UCDP, Kiel, Oryx, NASA FIRMS**: CC BY or public domain. Always credit.

### Phase structure

**Phase 0**: Repo + CI + Astro skeleton + i18n routing + Workers + Tailwind. **Status**: In progress.

**Phase 1**: Hero CDF chart live with real data (UK + EN). Polymarket + Kalshi collectors, CDF computation, HeroChart island, stat cards.

**Phase 2**: Supporting widgets (GDELT, Kiel, NBU, CBR, World Bank, FIRMS collectors; Sparkline, EventList, IndicatorCard).

**Phase 3**: Weekly brief generation (LLM Worker, admin page, glossary review).

**Phase 4**: Polish + launch (A11y audit, perf budget, RU locale, Playwright E2E, analytics, Sentry).

### Always do

- Run `npm run typecheck && npm run lint && npm run build` before pushing.
- Add a Zod schema before parsing any external API response.
- Add a unit test before changing `src/lib/cdf.ts`.
- Use `npm run wrangler:dev` locally to test Worker routes.
- Verify i18n pages render in all three locales (`/uk/`, `/en/`, `/ru/`).

### Never do

- Commit `.dev.vars`, `.env`, secrets, or private keys.
- Auto-publish AI-generated content. No exceptions.
- Republish ISW or Russia Matters content beyond fair-use citation.
- Add emoji to the UI.
- Use `any` without an inline justification comment.
- Ship hardcoded "war is ongoing" assumptions. Schema must support "war ended" pivot.

## Data sources & licensing

| Source | Use | License | Notes |
|---|---|---|---|
| Polymarket Gamma + Data API | Primary forecast probabilities | Public, viewable globally | Free, no auth required |
| Kalshi public market data | Secondary forecast signal | Public | Free, no auth required |
| GDELT 2.0 | Conflict intensity, event density | CC BY | Free BigQuery tier ~6TB/month |
| UCDP Georeferenced Events | Academic baseline for intensity | CC BY 4.0 | Free download |
| Kiel Ukraine Support Tracker | Aid commitments curve | CC BY 4.0 | Free download |
| NASA FIRMS | Fire/heat anomalies (combat proxy) | Public domain | Free API key; rate limits: 100k events/month |
| World Bank | Russian macro indicators | Public | Free API |
| IMF | Russian macro indicators | Public | Free API |
| Russian CBR | FX rates, reserves | Public | Free website scrape |
| Ukrainian NBU | FX rates, reserves | Public | Free API |
| ISW daily assessments | Cite & link only | Standard copyright | Fair-use citation only |
| Russia Matters | Cite & link only | Standard copyright | Fair-use citation only |
| Oryx open dataset | Equipment losses (attributed) | CC BY-NC | Free download; non-commercial use |

## Cost envelope (realistic, weekly cadence)

- Anthropic Claude API: ~$2–8/month (1 brief/week × 3 langs, with prompt caching)
- Cloudflare (Pages, Workers, D1, KV, Cron, Email, Analytics): $0
- Domain (annualized): ~$1/month
- GitHub + Sentry: $0
- **Total**: ~$3–9/month. Easily under $15/month.

## Editorial calendar (Phase 3+)

**Weekly cadence**: Sunday 08:00 UTC data pull → LLM draft → Editor review by Tuesday 23:59 UTC → Publish or "no brief this week" notice.

**Glossary review** (separate, async): Weekly review of AI-generated terminology for accuracy and tone per language.

**Changelog**: Every decision logged with `date, description, category` (new source, schema change, methodology update, etc.).

---

**Last updated**: 17 May 2026 · Update via PR to this file · Track changes in `/changelog`.
