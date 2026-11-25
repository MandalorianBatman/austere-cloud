# austere-cloud

Hosted share links for [austere-axi](https://github.com/MandalorianBatman/austere-axi): `austere-axi publish plan.html --invite Ana` uploads a review page and prints one link per invited reviewer (`/p/<id>#i=<token>`); invites are named and revocable, and an open link is opt-in (`--unlisted`).

Accounts (WorkOS AuthKit): the owner runs `austere-axi cloud login` once (device flow) and is then the owner of every own page, from the CLI and from the same account in the browser; the hub at `/` (austere-axi's hub shell) lists the pages, grouped by project, and grants them to collaborators by email, who sign in on the AuthKit page (email code, Google, GitHub, passkey) and comment under their account name. Without an account, `austere-axi publish login <file>` still signs the owner in on one page: the CLI asks `POST /api/pages/:id/login` for a single-use code and opens `/p/<id>?login=<code>`, which trades it for a page-scoped `austere_owner` cookie (30 days). The public shell holds nothing about the page, not even its title; that comes with access.

A Cloudflare Worker (TypeScript) with D1 for the owner's index, R2 for content-addressed objects, and one SQLite-backed Durable Object per page that owns its notes, replies and change feed. The CLI and the reviewer chrome talk to the page object over a WebSocket using the `austere-axi/sync` protocol. Implementation notes: [docs/design.md](docs/design.md); the contract: [austere-axi docs/hosted-share-links.md](https://github.com/MandalorianBatman/austere-axi/blob/main/docs/hosted-share-links.md).

## Develop

```sh
npm ci
npm test            # vitest in Miniflare (@cloudflare/vitest-pool-workers)
npm run typecheck

cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply austere-cloud --local
npm run dev         # http://localhost:8787
npm run smoke       # in another shell: publish, two invites, notes, replies, idempotency, live revoke, delete
```

Accounts are off until the WorkOS secrets are set (`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`; in `.dev.vars` for `wrangler dev`, as repo secrets for the deploy workflow in production; RLM-415). Tests run against a WorkOS stub with a test-only key (`test/workos.ts`), never real keys.

`austere-axi/sync` comes from the `austere-axi` npm package (0.10.0 or later).

## Deploy

Live at https://austere.blundertech.com. A push to `main` runs `.github/workflows/deploy.yml`: typecheck, tests, then it creates the D1 database `austere-cloud` and the R2 bucket `austere-cloud-pages` if they are missing, applies `migrations/` remotely, and runs `wrangler deploy` with the Worker secrets below. The route is a Workers custom domain (`wrangler.toml`), so Cloudflare creates the DNS record.

Repo secrets the workflow needs: `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, R2 and Workers Routes edit, plus DNS edit, for the `blundertech.com` zone), `CLOUDFLARE_ACCOUNT_ID`, `IP_HMAC_KEY` (`openssl rand -base64 32`). Rotating `IP_HMAC_KEY` only resets the rate-limit counters. Optional, all three together to turn accounts on: `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD` (`openssl rand -base64 32`; rotating it signs every browser out). The workflow uploads the ones that are set.

The very first deploy of a new Worker can fail with `This Worker does not exist on your account [code: 10007]` after the upload; re-run the job.

Until the CLI release whose default URL is this host, point the CLI at it: `AUSTERE_AXI_CLOUD_URL=https://austere.blundertech.com austere-axi publish page.html`. Check the live service with `node scripts/smoke.mjs https://austere.blundertech.com`.

## Publish by hand

The CLI's `publish` does this for you: create the page, upload its HTML (and packs) as objects named by SHA-256, then send a `publish` mutation on the owner socket. Every owner is an account: sign in with `austere-axi cloud login` (with accounts on, see Deploy) and use the access token it stores in `cloud.json` (`account.accessToken`, valid for 5 minutes; `austere-axi cloud whoami` refreshes it).

```sh
TOKEN=$(jq -r .account.accessToken ~/.austere-axi/cloud.json)
ID=$(curl -s -X POST localhost:8787/api/pages -H "authorization: Bearer $TOKEN" | jq -r .id)
SHA=$(sha256sum page.html | cut -d' ' -f1)
gzip -c page.html | curl -s -X PUT localhost:8787/api/objects/$SHA -H "authorization: Bearer $TOKEN" \
  -H 'content-type: text/html' -H 'content-encoding: gzip' --data-binary @-
```

Then open `ws://localhost:8787/api/pages/$ID/sync?cli=0.9.0` with the subprotocol `austere-sync.1` and the header `Authorization: Bearer $TOKEN`, and send

```json
{ "v": 1, "t": "mutation", "clientId": "<16+ base64url chars>", "n": 1, "name": "publish",
  "args": { "title": "Plan", "cliVersion": "0.9.0", "html": "<sha>", "packs": [], "auto": false, "unlisted": false, "presence": true } }
```

`AUSTERE_ACCESS_TOKEN=$TOKEN node scripts/smoke.mjs` does all of this with `austere-axi/sync`. `page.html` must load the runtime from `/rt/<cliVersion>/austere.js`, which the Worker proxies from jsDelivr.

## License

MIT
