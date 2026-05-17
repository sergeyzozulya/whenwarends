# Deploy — Cloudflare Workers (with Static Assets)

The site is a static Astro build served by a Cloudflare Worker via the [Static Assets](https://developers.cloudflare.com/workers/static-assets/) binding. The Worker entry is [worker/index.ts](worker/index.ts): it routes `/api/*` requests to handlers and falls through to `env.ASSETS.fetch(request)` for everything else.

Cloudflare has deprecated new Pages project creation in the dashboard, so this project uses the Workers + Static Assets model that replaces it. Config lives in [wrangler.toml](wrangler.toml).

---

## One-time setup

### 1. Cloudflare account & domain

1. Create or log in to [Cloudflare dashboard](https://dash.cloudflare.com).
2. Add the domain `whenwarends.org`. Cloudflare will guide you through nameserver updates at your registrar.
3. Wait for nameserver propagation (typically 24–48 hours, sometimes instant).

### 2. Cloudflare Worker project

1. Dashboard → **Workers & Pages** → **Create application** → **Workers** → **Create a Service**.
2. Name it `whenwarends-worker`.
3. Go to **Settings** → **Build & Deploy**. Ensure the build directory is set to `dist/`.
4. Alternatively, use the Git integration:
   - Dashboard → **Workers & Pages** → **Create application** → **Pages**.
   - Connect your GitHub repo.
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Save and deploy.

### 3. D1 Database

1. Dashboard → **Workers & Pages** → **D1** → **Create database**.
2. Name it `whenwarends_db`.
3. Copy the database ID.
4. Update [wrangler.toml](wrangler.toml):
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "whenwarends_db"
   database_id = "<your-database-id>"
   ```
5. Apply the schema:
   ```bash
   wrangler d1 migrations apply whenwarends_db --local
   wrangler d1 migrations apply whenwarends_db --remote
   ```

### 4. KV Namespace

1. Dashboard → **Workers & Pages** → **KV** → **Create namespace**.
2. Name it `whenwarends-cache`.
3. Copy the namespace ID.
4. Update [wrangler.toml](wrangler.toml):
   ```toml
   [[kv_namespaces]]
   binding = "KV_CACHE"
   id = "<your-namespace-id>"
   ```

### 5. Anthropic API key

1. Sign up at [Anthropic](https://console.anthropic.com) or log in.
2. Create an API key in **Account Settings** → **API Keys**.
3. Set it in production:
   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   # Paste your key when prompted
   ```

### 6. Environment variables (production)

1. Dashboard → **Workers & Pages** → select your worker → **Settings** → **Variables and Secrets**.
2. Add plaintext variables (if not already in wrangler.toml):
   - `CONTACT_TO_EMAIL=hello@whenwarends.org`
   - `CONTACT_FROM_EMAIL=noreply@whenwarends.org`
   - `CONTACT_FROM_NAME=When War Ends`
3. Add secrets:
   - `ANTHROPIC_API_KEY=sk-ant-...` (via `wrangler secret put` or this dashboard)

### 7. Custom domain

1. Dashboard → select your Worker → **Settings** → **Domains & Routes**.
2. Add `whenwarends.org` and `www.whenwarends.org`.
3. Cloudflare will create CNAME records automatically if your DNS is on the same account.

### 8. Cron triggers

1. Dashboard → **Workers & Pages** → select your Worker → **Triggers**.
2. Add a Cron trigger: `0 8 * * 0` (Sunday 08:00 UTC).
3. This will call the `scheduled` handler in [worker/index.ts](worker/index.ts).

### 9. Email Routing (optional, for `hello@whenwarends.org`)

1. Dashboard → **Email Routing** → **Add rule**.
2. Source: `hello@whenwarends.org`
3. Destination: your personal or team email address.
4. Activate. Email sent to `hello@whenwarends.org` will forward to the destination you set.

---

## Local development

```bash
# First-time setup — two env files, two purposes:

# 1. .env — build-time vars for Astro (PUBLIC_* gets baked into HTML)
cp .env.example .env
# Edit if needed (usually no secrets here)

# 2. .dev.vars — runtime secrets for the Worker (wrangler reads these)
cp .dev.vars.example .dev.vars
# Fill in: ANTHROPIC_API_KEY=sk-ant-...

# Install deps
npm install

# Local dev: builds Astro, serves via wrangler + static assets locally
npm run wrangler:dev
# Opens http://localhost:8787

# In another terminal: test E2E
npm run test:e2e
```

Both `.env` and `.dev.vars` are gitignored. Never commit them.

---

## Manual deploy

```bash
# Typecheck, lint, build
npm run typecheck && npm run lint && npm run build

# Deploy to Cloudflare
npm run wrangler:deploy

# Check deployment
curl https://whenwarends.org/api/health
# Should return: {"status":"ok","timestamp":"2026-05-17T08:00:00Z"}
```

Or use GitHub Actions (see `.github/workflows/ci.yml`): push to `main` and CI will build, typecheck, and deploy automatically.

---

## Database backups

Daily backups to R2 (free tier, 10GB/month):

```bash
# First-time setup: create R2 bucket
wrangler r2 bucket create whenwarends-backups

# Add to wrangler.toml:
# [[r2_buckets]]
# binding = "R2_BACKUPS"
# bucket_name = "whenwarends-backups"

# In a Worker scheduled handler (or manual cron):
export async function backupDB(env: Env) {
  const snapshot = await env.DB.dump();
  const key = `backup-${new Date().toISOString()}.db`;
  await env.R2_BACKUPS.put(key, snapshot);
}
```

---

## Troubleshooting

### `wrangler dev` fails with "no such table"

You need to apply D1 migrations locally first:

```bash
wrangler d1 migrations apply whenwarends_db --local
```

### API endpoints return 404

Ensure the Worker is correctly routing. Check [worker/index.ts](worker/index.ts) matches your route pattern. Common issue: missing `/api/` prefix.

### Astro build fails: "i18n not configured"

Make sure [astro.config.mjs](astro.config.mjs) has the `i18n` block:

```javascript
i18n: {
  defaultLocale: 'en',
  locales: ['uk', 'en', 'ru'],
  routing: {
    prefixDefaultLocale: true,
  },
},
```

### Static Assets not serving

Make sure [wrangler.toml](wrangler.toml) has:

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
```

And that `npm run build` produces a `dist/` folder.

---

## Deployment checklist

- [ ] Domain (`whenwarends.org`) is registered and pointing to Cloudflare nameservers
- [ ] Worker created in dashboard or via Git integration
- [ ] D1 database created, migrations applied, ID in `wrangler.toml`
- [ ] KV namespace created, ID in `wrangler.toml`
- [ ] Anthropic API key set via `wrangler secret put`
- [ ] Custom domain added to Worker routes
- [ ] Cron trigger configured for Sunday 08:00 UTC
- [ ] Email Routing enabled (if using `hello@whenwarends.org`)
- [ ] GitHub Actions workflow (`.github/workflows/ci.yml`) pushes to `main` to deploy
- [ ] Test: `curl https://whenwarends.org/api/health` returns 200

---

**Last updated**: 17 May 2026
