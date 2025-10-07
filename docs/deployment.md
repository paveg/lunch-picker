# Production Deployment (Cloudflare)

This project runs entirely on Cloudflare. The API lives in `apps/api` (Workers + Hono), and the web client in `apps/web` (SvelteKit on Cloudflare Pages). The steps below provision a single production environment and outline how to deploy safely after verifying changes locally.

> **Important:** Never commit credentials (D1 IDs, KV IDs, API keys) to the repository. All sensitive values must stay in Cloudflare or local override files ignored by git.

## 1. Prepare the API Worker (`apps/api`)

1. Install dependencies and sign in to Cloudflare once:
   ```bash
   pnpm install
   pnpm --filter api exec wrangler login
   ```
2. Create the persistent resources (run once per account):
   ```bash
   cd apps/api
   pnpm exec wrangler d1 create lunch-picker
   pnpm exec wrangler kv namespace create lunch-picker-cache
   ```
   Copy the resulting `database_id` and `namespace_id` from the output.
3. Create `apps/api/wrangler.toml.local` (git-ignored) so Wrangler has the production identifiers:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "lunch-picker"
   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

   [[kv_namespaces]]
   binding = "CACHE"
   id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
   ```
4. Register secrets that must never appear in source control:
   ```bash
   cd apps/api
   pnpm exec wrangler secret put GOOGLE_PLACES_API_KEY
   ```
   Repeat for any additional secrets the Worker consumes. Local development continues to use `.dev.vars`.
5. Deploy after validating locally with `pnpm --filter api dev`:
   ```bash
   cd apps/api
   pnpm exec wrangler deploy
   ```
   The command publishes the Worker to `https://lunch-picker-api.<account>.workers.dev` (or your custom route) with the configured D1 and KV bindings.

## 2. Configure Cloudflare Pages (`apps/web`)

1. Connect the GitHub repository to a new Pages project.
2. Use the following build settings:
   - **Build command:** `pnpm --filter web build`
   - **Build output directory:** `apps/web/.svelte-kit/cloudflare`
   - **Package manager:** pnpm (set `PNPM_VERSION` and optionally `NODE_VERSION=20` in the Pages _Environment variables_ section)
   - **Pages Functions:** Keep enabled (the SvelteKit adapter outputs a Worker under `.svelte-kit/cloudflare`)
3. Configure deployment branches. Using `main` keeps production automatic; preview deployments are available for pull requests.
4. Add any environment variables the web app needs (for example, an API base URL if you later externalise it). Do **not** expose sensitive keys directly to the client.

## 3. Route `/api` traffic to the Worker

The web app calls the API through the same origin (`/api/...`). After assigning a custom domain to the Pages project, add a Worker Route so requests hit the production Worker:

1. In the Cloudflare dashboard, open **Workers & Pages → Workers → lunch-picker-api → Triggers**.
2. Add a route such as `https://your-domain.example/api/*` and point it to `lunch-picker-api`.
3. Verify that `https://your-domain.example/api/health` (or another endpoint) reaches the Worker. Requests from the web UI should now stay same-origin and respect KV/D1 bindings.

If you do not have a custom domain yet, use the default Workers subdomain for API calls during development. Update the web client configuration accordingly before shipping.

## 4. Production deployment flow

1. Develop locally (`pnpm --filter api dev`, `pnpm --filter web dev`).
2. Run checks (lint, tests) and open a pull request.
3. After merging to `main`, deploy:
   ```bash
   # API
   cd apps/api
   pnpm exec wrangler deploy

   # Web
   # Triggered automatically by Pages on new commits to main
   ```
4. Smoke-test the production URLs (Pages + Worker route) before announcing changes.

Keep this document updated whenever the deployment process changes (e.g. new secrets, additional services).
