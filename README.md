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
- **Cloudflare Workers** + Static Assets (not Pages; Pages is deprecated)
- **Cloudflare D1** (SQLite) for time-series snapshots
- **Cloudflare KV** for homepage payload caching
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
