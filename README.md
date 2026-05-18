# WhenWarEnds

A non-commercial, Ukrainian-built dashboard that answers a single question with calm, transparent data: **when does this war end?**

Static-first Astro site on Cloudflare's free tier, fed by free and open data sources only.

## Quick start

```bash
# Install
npm install

# Local dev (builds + serves via wrangler)
npm run wrangler:dev
# Opens http://localhost:8787

# Deploy
npm run build
npm run wrangler:deploy
```

## Data collection

Data lives in versioned JSON files under [`data/`](data/) (no database). The
collectors fetch from the public sources and write those files; the static
build bakes the numbers into the HTML. Git is the history, audit trail, and
backup.

**Run it locally:**

Copy `.dev.vars.example` → `.dev.vars` (gitignored) and fill in:

```
FIRMS_MAP_KEY=...          # free: https://firms.modaps.eosdis.nasa.gov/api/area/
KIEL_DATASET_URL=...       # current Kiel Ukraine Support Tracker .xlsx (rotates per release)
KALSHI_SERIES_TICKER=...   # optional, override the Kalshi series
ANTHROPIC_API_KEY=...      # only needed for the brief
```

The scripts auto-load `.dev.vars` — no manual `export` needed:

```bash
npm run collect        # pull all sources → append data/snapshots.ndjson, data/markets.json
npm run draft-brief    # draft the weekly brief → data/briefs.json (status: pending_review)
```

`collect` is failure-isolated: one source failing degrades one widget, never
the run (it exits non-zero only if *every* source fails). Commit the changed
`data/` files to publish — the deploy bakes them in.

**Automated (weekly):** `.github/workflows/collect.yml` runs every Sunday
08:00 UTC and commits `data/`; `.github/workflows/brief.yml` then opens a
review PR (merging it is the editorial approval). For these to authenticate,
add the same values as **GitHub Actions repository secrets** (Settings →
Secrets and variables → Actions): `FIRMS_MAP_KEY`, `KIEL_DATASET_URL`,
`KALSHI_SERIES_TICKER`, `ANTHROPIC_API_KEY`.

## Documentation

- **[SPEC.md](docs/SPEC.md)** — Full project specification, architecture, data sources, phased delivery plan
- **[CLAUDE.md](CLAUDE.md)** — Conventions for Claude Code: repository structure, TypeScript style, database schema, always/never checklists
- **[DEPLOY.md](DEPLOY.md)** — One-time Cloudflare setup, local dev, manual deploy, troubleshooting

## Project phases

| Phase | Duration | Status | Deliverable |
|-------|----------|--------|-------------|
| **0** | 1 week | In progress | Repo + CI + Astro skeleton + i18n + Workers |
| **1** | 3 weeks | Blocked | Hero CDF chart live with real data (UK + EN) |
| **2** | 3 weeks | Blocked | Supporting widgets + collectors |
| **3** | 2 weeks | Blocked | Weekly brief + editor approval workflow |
| **4** | 2 weeks | Blocked | Polish + public launch |

## Tech stack

- **Astro 5** with TypeScript + Tailwind CSS
- **Cloudflare Workers** + Static Assets (static-only; no runtime DB)
- **Versioned repo JSON** (`data/`) for time-series snapshots — read at build
- **GitHub Actions** for the weekly collect + brief jobs
- **Chart.js** for the CDF visualization
- **Anthropic Claude API** for weekly editorial briefs
- **Playwright** for E2E testing
- **GitHub Actions** for CI/CD

## Data sources

Nine free, open sources:

- **Polymarket + Kalshi** — prediction markets
- **GDELT 2.0** — global events
- **NASA FIRMS** — heat anomalies (combat proxy)
- **Kiel Ukraine Support Tracker** — aid commitments
- **World Bank + IMF** — economic data
- **Ukrainian NBU + Russian CBR** — FX rates
- **ISW + Russia Matters** — cited for reference

## Cost envelope

~$3–9/month (weekly cadence):

- Anthropic Claude API: $2–8
- Cloudflare: $0
- Domain: ~$1
- **Total**: <$15/month

## Editorial

Weekly cadence (Sunday 08:00 UTC pull, Tuesday deadline for approval). If no decision, previous week's brief displays with "no fresh brief this week" notice. Never auto-publishes.

Glossary review (separate, async). Three languages from day one: Ukrainian, English, Russian.

## License

CC BY 4.0 — non-commercial, transparent, contributor-friendly.

---

Built in Kharkiv. For Ukraine.
