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
MANIFOLD_MARKET_ID=...     # optional, override the tracked Manifold market
ANTHROPIC_API_KEY=...      # only needed for the brief
```

The scripts auto-load `.dev.vars` — no manual `export` needed:

```bash
npm run collect        # pull all sources → append data/snapshots.ndjson, data/markets.json
npm run draft-brief    # draft + auto-publish the weekly brief → data/briefs.json
```

`collect` is failure-isolated: one source failing degrades one widget, never
the run (it exits non-zero only if *every* source fails). Commit the changed
`data/` files to publish — the deploy bakes them in.

**Automated (weekly):** `.github/workflows/collect.yml` runs every Sunday
08:00 UTC, drafts + auto-publishes the brief when the data changed (integrity
guards in `src/lib/llm.ts` replace human review), and commits `data/` — one
push, rebuild + deploy. For it to authenticate, add the same values as
**GitHub Actions repository secrets** (Settings → Secrets and variables →
Actions): `FIRMS_MAP_KEY`, `KIEL_DATASET_URL`, `ANTHROPIC_API_KEY`
(`MANIFOLD_MARKET_ID` optional).

## Documentation

- **[SPEC.md](docs/SPEC.md)** — Full project specification, architecture, data sources, phased delivery plan
- **[CLAUDE.md](CLAUDE.md)** — Conventions for Claude Code: repository structure, TypeScript style, routing & i18n, data storage, always/never checklists
- **[DEPLOY.md](DEPLOY.md)** — One-time Cloudflare setup, local dev, manual deploy, troubleshooting

## Project phases

| Phase | Status | Deliverable |
|-------|--------|-------------|
| **0** | Done | Repo + CI + Astro skeleton + i18n + Workers |
| **1** | Done | Hero CDF chart live with real data (uk/en/ru) |
| **2** | Done | Secondary timeline + collectors |
| **3** | Done | Weekly brief — auto-published behind integrity guards |
| **4** | Done | Polish + public launch (initial version) |

## Tech stack

- **Astro 5** with TypeScript + Tailwind CSS
- **Cloudflare Workers** + Static Assets (static-only; no runtime DB)
- **Versioned repo JSON** (`data/`) for time-series snapshots — read at build
- **Chart.js** for the CDF visualization
- **satori + @resvg/resvg-js** for build-time per-locale OG share images
- **Anthropic Claude API** for weekly editorial briefs
- **Playwright** for E2E testing
- **GitHub Actions** for CI + the weekly collect/brief jobs

## Data sources

Free, open, publicly accessible sources only:

- **Polymarket + Manifold** — prediction markets (war-end CDF; normalized per source, combined 50/50)
- **GDELT 2.0** — conflict volume intensity + tone
- **NASA FIRMS** — fire/heat anomalies (combat proxy)
- **Oryx** — visually-confirmed RU/UA equipment losses (CC BY-NC)
- **Kiel Ukraine Support Tracker** — aid commitments
- **World Bank** (Indicators + Global Economic Monitor) — RU annual macro, RU monthly CPI, RU/UA quarterly real GDP
- **National Bank of Ukraine** — UAH/USD FX + Ukraine monthly CPI
- **Central Bank of Russia** — RUB/USD FX
- **European Central Bank** (via Frankfurter) — daily rates for EUR conversion

## Cost envelope

~$3–9/month (weekly cadence):

- Anthropic Claude API: $2–8
- Cloudflare: $0
- Domain: ~$1
- **Total**: <$15/month

## Editorial

Weekly cadence (Sunday 08:00 UTC pull). When the data changed, the AI brief is
drafted and **auto-published** on the same push — no human approval gate.
Integrity is enforced in code (`src/lib/llm.ts`): citation allow-list, refusal
guard, truncation guard, per-language isolation. Briefs reconstructed for past
dates are labelled and grounded only in the snapshots as of their date.

Glossary review (separate, async). Three languages from day one: Ukrainian, English, Russian.

## License

CC BY 4.0 — non-commercial, transparent, contributor-friendly.

---

Built in Kharkiv. For Ukraine.
