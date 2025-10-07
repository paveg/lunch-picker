# Production Deployment (Cloudflare)

The entire stack runs on Cloudflare. The API lives in `apps/api` (Workers + Hono) and the web client in `apps/web` (SvelteKit on Cloudflare Pages). This guide shows how to deploy a single production environment while keeping secrets out of the repository.

> **Never** commit credentials such as D1 IDs, KV IDs, or API keys. Store them in Wrangler secrets or locally ignored files.

## 1. API Worker (`apps/api`)

1. Install dependencies and authenticate once:

   ```bash
   pnpm install
   pnpm --filter api exec wrangler login
   ```

2. Provision D1 and KV (run once per account):

   ```bash
   cd apps/api
   pnpm exec wrangler d1 create lunch-picker
   pnpm exec wrangler kv namespace create lunch-picker-cache
   ```

   Note the `database_id` and `namespace_id` from the output.
3. Copy `wrangler.toml.local.example` to `wrangler.toml.local` and paste the IDs:

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "lunch-picker"
   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

   [[kv_namespaces]]
   binding = "CACHE"
   id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
   ```

   The `.local` file is ignored by git and overrides the placeholders in `wrangler.toml`.
4. For local development, seed `.dev.vars`:

   ```bash
   cp apps/api/.dev.vars.example apps/api/.dev.vars
   ```

   Fill in `GOOGLE_PLACES_API_KEY` (this file stays local and is read by `wrangler dev`).
5. Register production secrets so they never touch git:

   ```bash
   cd apps/api
   pnpm exec wrangler secret put GOOGLE_PLACES_API_KEY
   ```

   Repeat for any additional secrets.
6. Deploy after testing with `pnpm --filter api dev`:

   ```bash
   cd apps/api
   pnpm exec wrangler deploy
   ```

   The worker will be available at `https://lunch-picker-api.<account>.workers.dev` unless you later attach a custom domain.

## 2. Cloudflare Pages (`apps/web`)

1. Create a Pages project and connect this GitHub repository.
2. Use these build settings:
   - Build command: `pnpm --filter web build`
   - Output directory: `apps/web/.svelte-kit/cloudflare`
   - Package manager: pnpm (set `PNPM_VERSION` and optionally `NODE_VERSION=20` in environment variables)
   - Pages Functions: keep enabled (the SvelteKit adapter emits a worker under `.svelte-kit/cloudflare`)
3. Deployment branches: set `main` for production; PR branches automatically produce preview deployments.
4. Environment variables: at minimum set `PUBLIC_API_BASE_URL=https://lunch-picker-api.<account>.workers.dev/api` for both Production and Preview so the front end targets the Worker. Mirror the same value in `.env` locally if you want to exercise the remote API during development. Do **not** expose sensitive keys (only public-safe values should be prefixed with `PUBLIC_`).

## 3. Optional: custom domain routing

If you add your own domain to Cloudflare and want `/api/*` served from the Worker on the same origin:

1. Cloudflare dashboard → **Workers & Pages → Workers → lunch-picker-api → Triggers**.
2. Add a route such as `https://your-domain.example/api/*` pointing to `lunch-picker-api`.
3. Confirm that `https://your-domain.example/api/health` reaches the Worker.

Without a custom domain, simply keep `PUBLIC_API_BASE_URL` targeting the default Workers URL (e.g. `https://lunch-picker-api.pavegy.workers.dev/api`).

## 4. Release checklist

1. Develop locally (`pnpm --filter api dev`, `pnpm --filter web dev`).
2. Run quality checks (`pnpm lint`, tests) and open a pull request.
3. After merging to `main`, deploy:

   ```bash
   # API
   cd apps/api
   pnpm exec wrangler deploy

   # Web
   # Pages deploys automatically when main updates
   ```

4. Smoke-test the production URLs (Pages + Worker route) before sharing the change.

Keep this document current whenever the deployment flow changes (new secrets, new services, etc.).

## 5. GitHub Actions automation

Continuous integration and deployment are automated via two workflows under `.github/workflows/`:

- `ci.yml` — runs on every pull request and push to `main`. It installs dependencies, runs `pnpm lint`, and builds the web client. Treat this job as required for PR merge protection.
- `deploy.yml` — runs on pushes to `main` (and on manual `workflow_dispatch`). It deploys the Worker (`wrangler deploy`) and publishes the Pages project via `cloudflare/pages-action`.

> Note: Because the repository does not track `pnpm-lock.yaml`, the workflows skip package-manager caching and run `pnpm install` without `--frozen-lockfile`. If you add a lock file later, re-enable caching by setting `cache: pnpm` in `actions/setup-node` and switch the install command to `pnpm install --frozen-lockfile`.

### Required GitHub secrets

| Secret | Description | Scope |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with **Workers KV Storage:Edit**, **Workers Scripts:Edit**, and **Pages:Edit** permissions. | Used by wrangler deploy and Pages action |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (32 characters, available in the dashboard). | Used by both deploy steps |
| `CLOUDFLARE_PAGES_PROJECT` | Cloudflare Pages project name (e.g. `lunch-picker-web`). | Required by Pages action |

Set these values in the repository’s **Settings → Secrets and variables → Actions**. Optionally add them as organization secrets if multiple repos share the same infrastructure.

#### How to create the Cloudflare API token

1. Log in to the Cloudflare dashboard and open **My Profile → API Tokens**.
2. Click **Create Token** → **Create Custom Token**.
3. Add these permissions:
   - Workers KV Storage → Edit
   - Workers Scripts → Edit
   - Pages → Edit
4. Under **Account Resources**, select your target account (or “All accounts” if you prefer).
5. Create the token and copy the generated string once. Store it as the `CLOUDFLARE_API_TOKEN` GitHub secret.
6. From the same account overview page, copy the **Account ID**; this becomes `CLOUDFLARE_ACCOUNT_ID`.
7. In the Cloudflare Pages project settings, note the project slug (e.g. `lunch-picker-web`) and store it as `CLOUDFLARE_PAGES_PROJECT`.

### Manual rollback

- Worker: redeploy a previous git revision by checking it out locally and running `pnpm exec wrangler deploy` from `apps/api`, or trigger `deploy.yml` via `workflow_dispatch` while pinning the commit to roll back to.
- Pages: upload a previous build by re-running the `Deploy Cloudflare Pages` job from the desired commit (GitHub UI → Actions → Deploy → select run → Re-run with same SHA). Cloudflare Pages also keeps revision history in the dashboard, allowing direct rollback.
