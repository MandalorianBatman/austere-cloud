# austere-cloud

Hosted share links for [austere-axi](https://github.com/MandalorianBatman/austere-axi): `austere-axi publish plan.html` uploads a review page and returns a public URL that anyone can open and annotate.

A Cloudflare Worker (TypeScript) with D1 for metadata and R2 for page blobs. Design, API, limits and threat model: [docs/design.md](docs/design.md).

## Develop

```sh
npm ci
npm test            # vitest in Miniflare (@cloudflare/vitest-pool-workers)
npm run typecheck

cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply austere-cloud --local
npm run dev         # http://localhost:8787
```

Publish by hand (the CLI's `publish` command does this for you):

```sh
TOKEN=$(curl -s -X POST localhost:8787/api/owners | jq -r .token)
jq -n --rawfile html page.html '{cliVersion:"0.4.1", title:"Plan", html:$html}' | gzip |
  curl -s -X POST localhost:8787/api/pages -H "authorization: Bearer $TOKEN" \
    -H 'content-encoding: gzip' -H 'content-type: application/json' --data-binary @-
```

`page.html` must load the runtime from `/rt/<cliVersion>/austere.js`, which the Worker proxies from jsDelivr.

## License

MIT
