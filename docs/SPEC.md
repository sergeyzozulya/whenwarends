# whenwarends.org — Project specification

A non-commercial, Ukrainian-built dashboard that answers a single question with calm, transparent data: **when does this war end?**

Static-first Astro site on Cloudflare's free tier, fed by free and open data sources only. No partnership outreach, no paid data, no paid infrastructure beyond a small LLM bill. To be built end-to-end by Claude Code from this specification.

---

## 1. Mission and editorial posture

The site presents a market-implied probability distribution for the end of the Russia-Ukraine war, surrounded by a scrubbable timeline of measured indicators (conflict intensity/tone/fire, currency, GDP, inflation) and an auto-published, integrity-guarded AI narrative.

Tone is sober, restrained, never casino. The site never authors a prediction of its own — only displays market-derived numbers, observable events, and clearly-labeled editorial summary. Advocacy lives in the choice to build it, not in the presentation.

## 2. Audience

In rough order of size: Ukrainians abroad checking for hope or context; Ukrainians at home weighing major decisions; journalists wanting a quick reference; diaspora and international supporters; researchers and civil society; general public following the war. Not the audience: military operators and prediction-market traders.

## 3. Scope

**In:** hero CDF chart of war-end date, two summary cards (closest-to-consensus, most-optimistic), a scrubbable "war in data" timeline (conflict intensity/tone/fire, currency vs USD, real GDP % y/y, CPI % y/y for Russia and Ukraine), weekly AI-drafted auto-published brief (integrity-guarded, no human gate), methodology page, three languages (Ukrainian, English, Russian), full historical snapshots.

**Out:** casualty counters, real-time air-raid maps, news aggregation, login or accounts, paid tiers or ads, trading, any prediction authored by the site or its AI, any external partnership or outreach, donations (v1.1).

## 4. Tech stack

**Frontend.** Astro 5+ with TypeScript and Tailwind. Static-first; islands hydrated only for interactive charts. Astro's built-in i18n routing produces `/uk`, `/en`, `/ru`. Chart.js for the CDF; pure SVG sparklines. Locale bundles split — only active locale ships.

> **Revised 2026-05-18 (v1.2)** — see §6/§14 and `data/changelog.json`. No
> D1/KV/Cron; data is versioned repo JSON read at build. No Sentry (see §11).
>
> **Revised 2026-05-19 (v1.3)** — supersedes editor-approval throughout
> (§1/§3/§4/§10): the brief is **auto-published** on each data refresh;
> integrity guards in `src/lib/llm.ts` (citation allow-list, refusal,
> truncation, per-language isolation) replace human review. Prediction
> markets are **Polymarket + Manifold** (Kalshi/Metaculus dropped). The
> homepage is the hero CDF + two summary cards + a scrubbable timeline;
> the "today on the ground" cards, the editorial event list, and the
> in-page brief panel were removed. UCDP/Oryx/ISW/Russia Matters/IMF are
> not collected. See `data/changelog.json`.

**Hosting and infrastructure, all Cloudflare free tier:**

- Cloudflare Workers with Static Assets — Astro static build served by Worker, git-based deployment via `wrangler deploy`. The Worker is static-assets only (no runtime DB/secrets).
- Cloudflare Email Routing — `hello@whenwarends.org`
- Cloudflare Web Analytics — cookieless

Data lives in versioned repo JSON files (`data/`) read at build time; the weekly collector and brief jobs run as GitHub Actions, not Cloudflare Cron. Git is the time-series history, audit trail, and backup. Free tier covers v1 traffic comfortably; runtime cost is dominated by the weekly Anthropic API brief.

**AI layer.** Anthropic Claude API (Opus 4.7, prompt caching). On each data refresh the brief is drafted and written to `data/briefs.json` as `published` — there is no `pending_review` hop and no editor PR. Integrity is enforced in `src/lib/llm.ts` (enforced citation allow-list, refusal guard, truncation guard) and generation is per-language isolated, so a failing language cannot overwrite a good brief. Briefs reconstructed for past dates carry `reconstructed: true`, are labelled in the UI, and are grounded strictly in `data/snapshots.ndjson` as of their date.

**Build and ops.** GitHub source. GitHub Actions runs typecheck, lint, build, perf budget, unit + Playwright E2E, plus the scheduled collect/brief jobs. Cloudflare Workers deployment via `wrangler deploy` from `main`. No third-party error-tracking script (§11 privacy supersedes the original Sentry plan).

## 5. Data sources — free and open only

| Source | Use | License | Auth |
|---|---|---|---|
| Polymarket Gamma + Data API | Primary war-end probabilities + history | Public, viewable globally | None |
| Manifold Markets API | Secondary forecast signal; per-bet history | Public (CC BY 4.0) | None |
| GDELT 2.0 DOC API | Conflict volume intensity + tone | CC BY | None |
| Kiel Ukraine Support Tracker | Aid commitments (.xlsx) | CC BY 4.0 | None |
| NASA FIRMS | Fire/heat anomalies as combat-zone proxy | Public domain | Free API key |
| World Bank (Indicators + Global Economic Monitor) | RU annual macro; RU monthly CPI; RU/UA quarterly real GDP | Public | None |
| National Bank of Ukraine | UAH/USD FX; Ukraine monthly headline CPI | Public | None |
| Central Bank of Russia | RUB/USD FX (official daily) | Public | None |
| European Central Bank (via Frankfurter) | Daily reference rates for EUR conversion | Public | None |

Implemented collectors only; the registry is `src/workers/collectors/index.ts`.

**Explicitly excluded / not collected:**

- **ACLED** — EULA forbids dashboards re-presenting their data and restricts LLM use.
- **UCDP, Oryx, IMF, ISW, Russia Matters, Kalshi, Metaculus, DeepStateMap** — considered earlier; not implemented (no collector). Conflict signal comes from GDELT + NASA FIRMS; macro from World Bank + NBU; FX from CBR + NBU.

## 6. Architecture

> **Revised 2026-05-18** (see `data/changelog.json`): D1/KV/Cron replaced by
> versioned repo JSON files read at build time. Weekly data volume for a
> single editor does not justify a database; git provides immutable history,
> audit trail, and backups. Editorial approval becomes pull-request review.

```
[GitHub Actions — weekly cron]
        ↓
[scripts/collect.ts] ── pull → [Polymarket, GDELT, Kiel, NBU, FIRMS, …]
        ↓
[data/ JSON files]  ◄── snapshots.ndjson: (metric, source, ts, value, raw_blob, confidence)
        ↓                  markets.json · events.json · briefs.json
        ↓                                                    ↑
[Brief draft → pending_review file in a PR] ── editor merges ┘  (Phase 3)
        ↓
[Astro static build reads data/ → numbers baked into HTML]
        ↓
[Cloudflare Worker + Static Assets] → readers
```

Snapshots never overwrite (append-only NDJSON, deduped on metric+source+ts). Each collector is idempotent with retry/backoff and failure-isolated. One failing source degrades one widget, not the page — affected widgets show "data unavailable, last good X hours ago." The commit that updates `data/` triggers CI rebuild + deploy.

## 7. Page structure

> **Revised 2026-05-18 (v1.2)** — five ground cards, not four: a Ukrainian-economy
> card (UAH/USD via NBU) was added alongside the Russian-economy card for
> even-handedness; the NBU data was already collected.

Single-column reading flow, top to bottom:

1. **Header** — domain, last-updated UTC timestamp, language switcher
2. **Hero** — title "When does this war end?", CDF chart, two stat cards (median expected end date, 30-day shift)
3. **How beliefs have moved** — three reference markets with 12-month sparklines and current probability
4. **What moved the curve** — four recent dated events with shift attribution
5. **Today on the ground** — five indicator cards (frontline movement, conflict intensity, aid commitments, Russian economy, Ukrainian economy)
6. **Daily brief** — AI-drafted, editor-reviewed paragraph with source citations
7. **Footer** — about, methodology, sources, changelog, donate, "Built in Kharkiv · Non-commercial · CC BY 4.0"

Supporting pages: `/methodology`, `/about`, `/sources`, `/changelog`, optional read-only `/api` JSON endpoint for transparency. Mobile collapses two-column grids; the five ground cards reflow via `repeat(auto-fit, minmax(160px, 1fr))`.

## 8. The hero chart

A CDF for the end-of-war date:

- X-axis: 24-month forward horizon, configurable up to 36
- Y-axis: cumulative probability war has ended by that date; asymptotes near 80–85%, never reaches 100%
- Curve: monotonic cubic spline between liquidity-weighted market points
- Markers: dots at real market dates; distinct circle at the 50% crossing with drop-line
- Vertical dashed marker at today

Pipeline: pull markets → per resolution date, liquidity-weighted YES price → filter under $10k liquidity → isotonic regression for monotonicity → PCHIP interpolation → compute median crossing analytically. Implemented in `src/lib/cdf.ts`, fully unit-tested.

Definition toggle: ceasefire / formal peace deal / either. Default: ceasefire.

## 9. Multilanguage strategy

Three locales: **uk**, **en**, **ru**. Locale-prefixed URLs. No machine translation.

- **UI strings** — JSON per locale, namespaced by section, ICU MessageFormat for plurals
- **Glossary** — `glossary.{lang}.yaml` with locked translations for countries, agencies, place names, and domain terms; feeds UI + LLM prompts
- **AI narrative** — drafted separately per language with locale-specific tone guidance and glossary in the prompt

Date and number formatting through `Intl`.

## 10. Editorial workflow

> **Revised 2026-05-18 (v1.2)** — the admin page/API is replaced by GitHub
> PR review; "approve" means "merge the brief PR". No D1/KV.

Solo editor. Weekly cadence. Target: under 30 minutes per review. Sustainable indefinitely.

1. Every Sunday 08:00 UTC, the `collect` GitHub Action pulls fresh data and commits `data/`.
2. At 08:30 UTC the `brief` GitHub Action drafts the weekly brief in all three languages with citations and opens a pull request (`data/briefs.json` entries set to `pending_review`).
3. Editor reviews the PR — each draft is in the diff alongside the data the build will use and the previous week's brief.
4. To approve a language: edit its entry in the PR (set `status: published`, copy the possibly-edited text into `published`, set `reviewed_at`), then merge. To reject: set `status: rejected` (or leave `pending_review` and close).
5. Merging triggers CI rebuild + deploy; the published brief is baked into the static site. Changes are tracked in git history and `/changelog`.
6. If the editor doesn't act by Tuesday 23:59 UTC, the page keeps showing the previous week's brief with a "no fresh brief this week" notice.

Never auto-publishes — nothing is public until a human merges the PR.

## 11. Non-functional requirements

**Performance.** LCP under 2s on 4G. Page weight under 250 KB gzipped excluding chart JS. Chart JS lazy-loaded; sparklines pure SVG; locale bundles split.

**Accessibility.** WCAG AA contrast. `aria-label` data summaries on every chart. Full keyboard nav. Data-table fallbacks behind every visualization for screen readers.

**Privacy.** No cookies. System fonts only. No third-party script loads. Cloudflare Web Analytics is cookieless. GDPR-compliant by default.

**Reliability.** Each collector independently retries with backoff. Daily D1 backup to R2 (also free tier).

**Brand.** One accent color (muted blue), grayscale otherwise. No emoji. Sentence case throughout. Typography: 22/16/13 px, two weights (400, 500).

## 12. Repository structure

> **Revised 2026-05-18 (v1.2)** — the tree below is the original design.
> `CLAUDE.md` holds the authoritative current structure. Key deltas: removed
> `migrations/`, `src/lib/db.ts`, `src/lib/kv.ts`, `src/workers/llm-brief.ts`,
> `src/workers/admin-api.ts`; added `data/`, `scripts/collect.ts`,
> `scripts/draft-brief.ts`, `scripts/check-bundle.ts`, `src/lib/filestore.ts`,
> `src/lib/homepage.ts`, `src/i18n/glossary/`, and
> `.github/workflows/{collect,brief}.yml`.

```
whenwarends/
├── CLAUDE.md                          # Project conventions for Claude Code
├── README.md
├── package.json
├── tsconfig.json
├── astro.config.mjs
├── tailwind.config.ts
├── wrangler.toml                      # Cloudflare Workers + D1 + KV bindings
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
│   │   ├── glossary/{uk,en,ru}.yaml
│   │   └── index.ts
│   ├── workers/                        # Cloudflare Workers entry and handlers
│   │   ├── index.ts                   # main Worker entry: routes /api/*, falls through to ASSETS
│   │   ├── collectors/                # one cron per source
│   │   ├── llm-brief.ts               # daily brief generator
│   │   └── admin-api.ts               # editor approval endpoints
│   └── styles/global.css
├── worker/
│   └── index.ts                       # Worker entry point (wrangler main)
├── migrations/                        # D1 schema
│   └── 0001_initial.sql
├── tests/
│   ├── unit/
│   │   ├── cdf.test.ts
│   │   └── sources/*.test.ts
│   └── e2e/
│       └── homepage.e2e.ts
├── DEPLOY.md                          # Deployment and setup guide
└── .github/workflows/ci.yml
```

`CLAUDE.md` at the repo root holds long-lived project memory for Claude Code: the conventions below, the database schema, the data source matrix, and a short "always do / never do" list.

## 13. Conventions

- **TypeScript strict mode.** No `any` without an inline comment justifying it.
- **Zod schemas** for every external API response in `src/lib/sources/<name>.schema.ts`. Parse at the boundary; downstream code consumes typed objects.
- **Time** in UTC, stored as ISO-8601 strings.
- **Money** in EUR; conversion at ingest using daily ECB rates.
- **Probabilities** as 0–1 floats internally; format to `"X%"` only at render.
- **Components.** `.astro` for static; `.tsx` only when interactivity is required, marked with `client:visible` or `client:idle`.
- **Styling.** Tailwind utility classes only. No inline CSS except in SVG.
- **Test naming.** `*.test.ts` for unit (Vitest), `*.e2e.ts` for Playwright.
- **Commits.** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- **Branches.** `phase-N/<short-description>`.
- **Secrets.** Never in source. Use `wrangler secret put` for production; `.dev.vars` (gitignored) for local.
- **Sentence case** for all UI copy; no Title Case, no ALL CAPS.
- **Two font weights** only (400, 500). No 600/700.
- **No emoji** in UI. No flashing or animated numbers.

## 14. Data model

> **Revised 2026-05-18**: no D1. The shapes below now describe the JSON
> records in `data/` (`snapshots.ndjson`, `markets.json`, `briefs.json`,
> `events.json`, `changelog.json`); see `src/lib/types.ts` for the
> authoritative TypeScript types and `src/lib/filestore.ts` for access. The
> original DDL is retained as documentation of the record shape.

```sql
-- Time-series metric snapshots; never overwrite
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  value REAL,
  raw_blob TEXT,
  confidence REAL,
  UNIQUE(metric, source, ts)
);
CREATE INDEX idx_snapshots_metric_ts ON snapshots(metric, ts);

-- Current state per market; updated frequently
CREATE TABLE markets (
  market_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  question TEXT NOT NULL,
  resolution_date TEXT NOT NULL,
  category TEXT NOT NULL,
  current_price REAL,
  liquidity_usd REAL,
  last_updated TEXT NOT NULL
);

-- AI brief drafts and published versions
CREATE TABLE briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lang TEXT NOT NULL,
  date TEXT NOT NULL,
  draft TEXT NOT NULL,
  published TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_review','published','rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  citations TEXT NOT NULL,
  UNIQUE(lang, date)
);

-- Editorial events with attribution and shift impact
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description_uk TEXT NOT NULL,
  description_en TEXT NOT NULL,
  description_ru TEXT NOT NULL,
  shift_months REAL,
  source_url TEXT
);

-- Methodology change log
CREATE TABLE changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL
);
```

## 15. Phased delivery

Each phase ends with a deployable, runnable state.

| Phase | Duration | Deliverable | Key tasks |
|---|---|---|---|
| 0 — Foundations | 1 week | Holding page live on `whenwarends.org` | Repo + CI + Astro skeleton + i18n routing + Cloudflare Pages + Tailwind + CLAUDE.md |
| 1 — First vertical slice | 3 weeks | Hero CDF chart live with real data in UK + EN | D1 schema + Polymarket + Kalshi collectors + `cdf.ts` + HeroChart island + stat cards |
| 2 — Supporting widgets | 3 weeks | All four "ground" cards live, history sparklines populated | GDELT + Kiel + NBU + CBR + WorldBank + FIRMS collectors; Sparkline, EventList, IndicatorCard |
| 3 — Narrative + editorial | 2 weeks | Weekly brief generates, editor approves via PR, page publishes | brief draft script + brief PR workflow + glossaries + methodology + changelog |
| 4 — Polish + launch | 2 weeks | Public v1 | A11y audit (axe in E2E) + perf budget + RU locale + Playwright E2E + Cloudflare Web Analytics (no Sentry — §11) |

About 11 weeks of focused work, faster if Claude Code is doing the bulk of the implementation.

## 16. Cost envelope

| Item | Monthly |
|---|---|
| Cloudflare (Workers + Static Assets, Email, Analytics) | $0 |
| GitHub (Actions: CI + weekly collect/brief) | $0 |
| Anthropic Claude API — weekly brief × 3 languages, with prompt caching | $2–8 |
| Domains (annualized) | ~$5 |
| **Total** | **under $15/month** |

If Anthropic cost becomes a constraint, swap the LLM step to a free-tier provider (Groq, Together) — the workflow is provider-agnostic.

## 17. Top risks

1. **Editorial sustainability.** Solo editor, weekly review, indefinite duration. Mitigation: built-in "no fresh brief this week" path if editor is unavailable; glossary review is separate from brief approval.
2. **Frontline data quality.** Without partnership data, the frontline widget relies on ISW-observed estimates and GDELT/FIRMS proxies. Mitigation: clear "ISW-observed estimate" labeling; full method on `/methodology`; conservative confidence indicators.
3. **The war ends mid-build.** Architecture must pivot to reconstruction tracking — same data layer, different metrics. Mitigation: schema is source-agnostic (`metric, source, ts, value`); nothing about "war ongoing" is hardcoded.

## 18. Resolved decisions

1. **Editorial cadence** — **Weekly** (sustainable for solo editor; "no fresh brief this week" path always available).
2. **Glossary translations** — Claude drafts all three locales (uk, en, ru); human reviewer fixes domain-specific terms and tone. Separate from the approval loop.
3. **Donation channel** — Postponed to v1.1. Keep footer copy minimal: "Non-commercial · Built in Kharkiv".
4. **End-of-war plan** — Schema supports pivot to reconstruction tracker if needed. No hardcoded "war ongoing" assumptions.

## 19. Claude Code working agreement

The `CLAUDE.md` file at the repo root distills this spec into operational instructions for Claude Code. It should contain, at minimum:

- One-paragraph project summary
- Repository structure overview
- The conventions list verbatim
- The database schema verbatim
- The "always do / never do" checklist:
  - Always run `npm run typecheck && npm run lint` before committing
  - Always add a Zod schema before parsing any external response
  - Always add a unit test before changing `cdf.ts`
  - Never commit secrets or `.dev.vars`
  - Never auto-publish AI content
  - Never republish ISW or Russia Matters content beyond fair-use citation
  - Never add an emoji to the UI
- The phase tracker: which phase is active and what its acceptance criteria are
- The data source matrix and licensing reminders

Phase work proceeds by Claude Code creating a `phase-N/...` branch, completing the phase's tasks against the acceptance criteria, opening a PR, and merging on green CI.

---

*Specification version 1.2 · 18 May 2026 · v1.2 replaces D1/KV/Cron with versioned repo files + GitHub Actions collection (§6, §14; rationale in `data/changelog.json`). Update via PR to this file; track changes in `/changelog`.*
