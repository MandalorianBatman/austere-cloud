# austere-cloud

Hosted share links for [austere-axi](https://github.com/MandalorianBatman/austere-axi): `austere-axi publish plan.html --invite Ana` uploads a review page and prints one link per invited reviewer (`/p/<id>#i=<token>`); invites are named and revocable, and an open link is opt-in (`--unlisted`).

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

`austere-axi/sync` is not on npm yet. Until the release that ships it (RLM-271), `package.json` installs it from `vendor/austere-axi-9f88d27.tgz`, an `npm pack` of austere-axi at commit `9f88d27` (the merge of RLM-313). To refresh it, run `npm ci && npm run build && npm pack` in an austere-axi checkout and install the tarball here; once the release is out, depend on it from npm and delete `vendor/`.

## Publish by hand

The CLI's `publish` does this for you: create the page, upload its HTML (and packs) as objects named by SHA-256, then send a `publish` mutation on the owner socket.

```sh
TOKEN=$(curl -s -X POST localhost:8787/api/owners | jq -r .token)
ID=$(curl -s -X POST localhost:8787/api/pages -H "authorization: Bearer $TOKEN" | jq -r .id)
SHA=$(sha256sum page.html | cut -d' ' -f1)
gzip -c page.html | curl -s -X PUT localhost:8787/api/objects/$SHA -H "authorization: Bearer $TOKEN" \
  -H 'content-type: text/html' -H 'content-encoding: gzip' --data-binary @-
```

Then open `ws://localhost:8787/api/pages/$ID/sync?cli=0.9.0` with the subprotocols `austere-sync.1, austere-owner.$TOKEN` and send

```json
{ "v": 1, "t": "mutation", "clientId": "<16+ base64url chars>", "n": 1, "name": "publish",
  "args": { "title": "Plan", "cliVersion": "0.9.0", "html": "<sha>", "packs": [], "auto": false, "unlisted": false, "presence": true } }
```

`scripts/smoke.mjs` does all of this with `austere-axi/sync`. `page.html` must load the runtime from `/rt/<cliVersion>/austere.js`, which the Worker proxies from jsDelivr.

## License

MIT
