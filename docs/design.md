# Hosted share links (austere-cloud): design

Status: approved by sid.kasat on RLM-245 (2026-11-09; decisions Q1–Q12). Everything else below follows from them. Sections marked "Implementation notes" record details settled while building RLM-264 that refine the original proposal.

## Goal

`austere-axi publish plan.html` uploads a review page and prints a public URL. Anyone with the URL can open the page and add notes. The owner's agent receives those notes through the normal `poll` and `feedback`. Every hosted page links back to austere-axi.

Out of scope: a paid tier (teams, private pages, longer history; see RLM-249), live push, GitHub login, and page version history.

## Constraints

- The CLI stays MIT and local-first. `publish` is the only command that talks to the service. Nothing contacts the service until the user runs `publish`; after that, only sessions that were published do.
- The service is a separate public MIT repo: `MandalorianBatman/austere-cloud` (Q12). This document lives here as `docs/design.md`, and the austere-axi README keeps a short section on the protocol.
- A hosted artifact runs exactly as sandboxed as it does in the local server: an `iframe sandbox="allow-scripts"` without `allow-same-origin`, so the frame has an opaque origin.

## Decisions

| # | Topic | Decision |
|---|---|---|
| Q1 | Hosting | Cloudflare Workers, R2 for page blobs, and D1 for pages, notes, tokens and reports. Free tier. |
| Q2 | Domain | `https://austere.kasat.xyz`, with pages at `/p/<id>`. No separate user-content domain; the sandbox's opaque origin isolates the artifact. A brandable alias can be added later. |
| Q3 | Upload | The raw artifact plus third-party pack bundles. The service serves pinned runtime, Mermaid, chrome and `@austere-axi/*` packs by CLI version. Relative images are inlined as data URLs within the size cap. |
| Q4 | Republish | `publish` on the same file updates the same URL. The page id is stored in local state, keyed by absolute path. `--new` forces a fresh link. Old versions are not kept. |
| Q5 | Identity | An anonymous owner token, created on first `publish` and stored in `~/.austere-axi/cloud.json`. GitHub login comes later. |
| Q6 | Reviewers | Open link with a 128-bit unguessable id, unlisted, `noindex`. A one-time name prompt (stored in localStorage) appears before the first note. Names are self-declared. |
| Q7 | Hold | Remote notes are **held** by default. `publish --auto` sends them straight to the agent. |
| Q8 | Delivery | Remote notes are synced into the local session files, so `poll`, `feedback`, `reply` and the hub keep their current code paths. |
| Q9 | Live updates | None in v1. A hosted reviewer sees new versions and replies on reload, or through a 30 s background check. |
| Q10 | Limits | See [Limits](#limits). |
| Q11 | Abuse | A footer with "Made with austere-axi" and "Report". Reports go to D1 and email the admin. Takedown is an admin command. |
| Q12 | Repo | Public, MIT, `MandalorianBatman/austere-cloud`. |

## Architecture

```
austere-axi (CLI, local)                         austere-cloud (Cloudflare Worker)
────────────────────────                         ──────────────────────────────────
publish plan.html ──── PUT /api/pages/:id ─────► R2: pages/<id>/index.html, packs/<sha>.js
  cloud.json (token, path → page id)             D1: owners, pages, notes, replies, reports
local server (already running for poll)
  cloud sync loop ──── GET /api/pages/:id/notes ─► long-poll (25 s) for notes after a cursor
  SessionStore.addUserBatch(author, hold, remote)
reply ──────────────── POST /api/pages/:id/replies ►
                                                  GET /p/:id         chrome shell (hosted mode)
reviewer's browser ◄──────────────────────────────  GET /p/:id/a/      artifact, sandboxed frame
                    ───── POST /p/:id/send ──────►  GET /p/:id/conversation (30 s check)
                                                  GET /rt/<ver>/*    pinned runtime + chrome
                                                  POST /p/:id/report
```

### What the CLI uploads

`publish` reuses `readArtifact` and `rewriteRuntime` (see `src/cli/export.js`):

1. Replace the runtime `<script>` tag with `<script src="/rt/<cliVersion>/austere.js"></script>`. Add `/rt/<cliVersion>/mermaid.min.js` when the program uses `Mermaid(`. Add `/rt/<cliVersion>/packs/<name>.js` for each implicit `@austere-axi/*` pack.
2. Each installed third-party pack is uploaded as a blob and referenced as `/pk/<sha256>.js`. A pack that is missing locally or doesn't match is an error, because the hosted page can't fetch it from a CDN.
3. Relative-path images are inlined as `data:` URLs.
4. Everything else in the file is byte-for-byte unchanged, which keeps the AGENTS.md rule that the served artifact equals the file except for runtime tags.

Request body (`application/json`, gzip-encoded):

```json
{ "cliVersion": "0.5.0", "title": "Plan", "html": "<!doctype html>…", "packs": [{ "sha256": "…", "name": "@acme/charts", "version": "1.2.0", "code": "…" }], "auto": false, "thirdPartyPacks": true }
```

The Worker checks that every `<script src>` in `html` points to `/rt/<cliVersion>/<allow-listed asset>` or to an uploaded `/pk/<sha>.js`, recomputes each pack's SHA-256 (over the UTF-8 bytes of `code`), and rejects anything else with 400.

Implementation notes:

- The request may be gzip-encoded (`Content-Encoding: gzip`) or plain JSON. The 1 MB limit applies to the bytes on the wire; the inflated JSON is capped at 16 MB so a small gzip bomb can't exhaust memory. Both return 413.
- `thirdPartyPacks` is not read: the service derives it from `packs`, so the two can't disagree. Uploaded packs that `html` doesn't reference are ignored and not stored.
- `cliVersion` must be a plain `x.y.z` release at or above `MIN_CLI_VERSION`, otherwise 400.
- The `src` check is strict on purpose: no query strings, no whitespace, no entities. The CLI's rewrite always produces exact paths.
- Timestamps in the database and the API are Unix milliseconds.

### Pinned runtime (`/rt/<version>/…`)

The Worker proxies `https://cdn.jsdelivr.net/npm/austere-axi@<version>/dist/<asset>` and caches the result with the Cache API. Only versions at or above `MIN_CLI_VERSION` are allowed, and only an allow-listed set of asset paths (runtime, Mermaid, chrome JS/CSS, packs). Pages stay same-origin, and `script-src 'self'` holds. No R2 copy of the runtime is needed.

`MIN_CLI_VERSION` is the first austere-axi release that ships chrome hosted mode and `publish`. Releasing it to npm is a human step for sid.kasat.

Implementation notes: assets are `austere.js`, `mermaid.min.js`, `chrome/chrome.js`, `chrome/chrome.css` and `packs/<name>.js` (`<name>` is lowercase letters, digits and `-`). A pack is public as `packs/<name>.js` but lives in the npm package as `dist/packs/<name>/pack.js`, and the Worker maps between the two. Only 200 responses are cached; a missing version returns 404 and any other upstream failure 502. Responses are `immutable`, since a published version never changes.

### Hosted page

`GET /p/:id` returns the same shell the local server builds (`src/cli/server.js`), loading `/rt/<v>/chrome/chrome.{js,css}`, with:

```js
window.__AUSTERE__ = {
  id, title, file: "", name: title, artifactUrl: "/p/<id>/a/", version: cliVersion,   // the fields the local chrome already reads
  viewer: { role: "reviewer", name: "" },
  hosted: { base: "/p/<id>", report: "/p/<id>/report", publishedAt }                   // publishedAt: chrome compares it for "new version, reload"
};
```

Chrome hosted mode (an austere-axi change):

- All `/s/${SID}/…` URLs come from one `base`, which defaults to `/s/${SID}`.
- With `hosted` set, chrome polls `GET {base}/conversation?after=<cursor>` every 30 s, and on focus, instead of opening `EventSource`.
- It asks for the reviewer's name before the first send, stores it in localStorage under `austere:name`, and sends it with every batch.
- It hides owner and local-only controls: end review, export, held-note release, and the `bye` beacon.
- It renders the footer: "Made with austere-axi" (links to the GitHub repo) and "Report".

Headers on `/p/:id`:

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-<boot script>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
X-Robots-Tag: noindex, nofollow
Referrer-Policy: no-referrer
```

`GET /p/:id/a/` serves the artifact with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`. The frame cannot make network requests. Notes leave it only by `postMessage` to the chrome, which is how it already works locally (`src/runtime/index.jsx`).

Implementation notes: `script-src 'self'` blocks the inline boot script, so the shell allows exactly that script by its SHA-256, computed per response. `GET /pk/<sha>.js` serves uploaded packs from R2 (`immutable`, `nosniff`).

### Data model (D1)

```sql
owners   (id TEXT PK, token_hash TEXT UNIQUE, created_at INT, blocked INT DEFAULT 0)
pages    (id TEXT PK, owner_id TEXT, title TEXT, cli_version TEXT, auto INT, bytes INT,
          packs TEXT DEFAULT '[]' /* JSON [{ sha256, name, version }] of uploaded packs: feeds the third-party warning and blob cleanup */,
          created_at INT, published_at INT, expires_at INT, taken_down INT DEFAULT 0)
notes    (seq INTEGER PK AUTOINCREMENT, page_id TEXT, author TEXT, items TEXT /* JSON */,
          ip_hash TEXT, at INT)
replies  (seq INTEGER PK AUTOINCREMENT, page_id TEXT, text TEXT, at INT)
reports  (id INTEGER PK AUTOINCREMENT, page_id TEXT, reason TEXT, ip_hash TEXT, at INT)
limits   (key TEXT PK, window_start INT, count INT)          -- fixed-window rate limits
blocked_ids (page_id TEXT PK)                                -- takedown tombstones
```

The token is 32 random bytes, base64url, and only its SHA-256 is stored. Page ids are 16 random bytes, base64url (22 characters). `ip_hash` is HMAC-SHA-256 of the IP under a Worker secret, used only for rate limits and abuse.

### API

Owner routes need `Authorization: Bearer <token>`. They return JSON and are not CORS-enabled, since the CLI calls them from Node. A missing or unknown token is 401, a blocked owner 403. A page that doesn't exist, is expired or taken down, or belongs to another owner is 404.

| Route | Purpose |
|---|---|
| `POST /api/owners` | Creates an owner and returns `{ token }`. Rate-limited per IP. |
| `POST /api/pages` | Creates a page from the upload body and returns `{ id, url, expiresAt }`. |
| `PUT /api/pages/:id` | Replaces the page (republish) and resets `expires_at`. Notes are kept. |
| `DELETE /api/pages/:id` | Deletes the page, its blobs, notes and replies at once. |
| `GET /api/pages` | Lists the owner's live pages as `{ pages: [{ id, title, url, expiresAt, notes }] }`, newest first. |
| `GET /api/pages/:id/notes?after=<seq>&wait=25` | Long-poll. Returns `{ notes: [{ seq, author, items, at }], cursor }` once there are notes after `seq`, or empty after `wait` seconds (D1 is re-checked every 2 s). |
| `POST /api/pages/:id/replies` | `{ text }`, an agent reply shown in the hosted conversation. |

Reviewer routes are same-origin from the hosted chrome, and a foreign `Origin` is rejected:

| Route | Purpose |
|---|---|
| `GET /p/:id`, `GET /p/:id/a/` | Shell and artifact (above). Returns 404 when expired, deleted or taken down. |
| `POST /p/:id/send` | `{ name, items, end? }`, the same `items` shape the chrome posts locally. `end` is ignored for reviewers. |
| `GET /p/:id/conversation?after=<cursor>` | The reviewer's view: replies plus notes, with the page's `published_at` so chrome can offer "new version, reload". |
| `POST /p/:id/report` | `{ reason }`. Inserts a report row and emails the admin. |

### CLI side

New state: `~/.austere-axi/cloud.json` (mode 0600)

```json
{ "url": "https://austere.kasat.xyz", "token": "…", "pages": { "/abs/path/plan.html": { "id": "…", "auto": false, "cursor": 0 } } }
```

The service URL defaults to `https://austere.kasat.xyz`, and `AUSTERE_AXI_CLOUD_URL` overrides it for tests and self-hosting.

Commands:

```
austere-axi publish <file> [--auto] [--new]   upload; prints the URL (and on republish, "updated")
austere-axi publish list                      your hosted pages, expiry, note counts
austere-axi publish rm <file|id>              delete at once
```

Sync into local sessions (Q8). This runs in the local server, which `poll` already starts:

- For every session whose file has an entry in `cloud.json`, the server runs one long-poll loop against `GET /api/pages/:id/notes`. A loop runs while a `poll` is listening on that session, and also once on server start so `feedback` sees notes that arrived while nothing was listening.
- Each remote note becomes `SessionStore.addUserBatch(s, items, { author: name, hold: !auto })`, with `entry.remote = true`. The cursor is saved in `cloud.json` only after the session flushes, so a crash re-delivers rather than losing notes. Entries are de-duplicated by `(pageId, seq)`.
- `poll` and `feedback` output adds `remote: true` next to `from: <name>`.
- `reply` on a published file also calls `POST /api/pages/:id/replies`. A failure there is reported as a warning, and the local reply stands.
- Held remote notes appear in the local chrome's side panel with the existing Send, Send all and Discard controls. Nothing new is needed there.
- Without network, the loop backs off (up to 60 s) and `poll` still works for local notes.

## Limits

| Limit | Value | Response |
|---|---|---|
| Upload size (gzip request body) | 1 MB | 413 with a message that names the size |
| Publishes (create and update) per owner token | 20 per day | 429 |
| Publishes per IP | 100 per day | 429 |
| New owners per IP | 5 per day | 429 |
| Notes per page per IP | 60 per hour | 429 |
| Note batch size | 4 KB of JSON `items` | 413 |
| Reviewer name | 40 characters, plain text | Truncated |
| Retention | 30 days after the last publish | A daily cron deletes pages, blobs, notes and replies |

All text is rendered with `textContent` in chrome, never as HTML. Rate limits use the D1 `limits` table with fixed windows. This is cheap and good enough at this scale. Cloudflare's rate-limiting binding can replace it later.

## Abuse and takedown

- The footer on every page reads: "Made with austere-axi · Report".
- `POST /p/:id/report` stores the report and sends one email per report to the admin address (`ADMIN_EMAIL` secret) through the Cloudflare Email Routing `send_email` binding. Reports are rate-limited at 5 per IP per day.
- `npx austere-cloud-admin takedown <id> [--owner]` is a small script in the cloud repo that uses `ADMIN_TOKEN`. It sets `taken_down`, deletes the blobs, adds a `blocked_ids` tombstone, and with `--owner` blocks the owner token so every one of its pages returns 410.
- `npx austere-cloud-admin reports` lists open reports.

## Threats

| Threat | Mitigation |
|---|---|
| Artifact JS steals reviewer data or calls the API as the reviewer | Opaque-origin sandbox, `connect-src 'none'` on the frame, no cookies anywhere on the domain |
| Prompt injection through public notes | Held by default (Q7). Remote notes are marked `remote: true`. `--auto` is an explicit opt-in. |
| Phishing or malware hosting gets the domain flagged | Report and takedown, 30-day expiry, `noindex`, 1 MB cap, upload rate limits |
| Owner token leak | The token only controls that owner's pages. A token can be rotated by deleting `cloud.json`, which loses control of existing pages until they expire. |
| Note spam | Per-IP per-page limits, 4 KB cap, and holding |
| Untrusted third-party pack code | Runs only in the sandboxed frame, as locally. The page shows the same third-party-pack warning. |

## Build tickets

The tickets are staged under RLM-245. The service and the CLI are separate repos, so their tickets can run in parallel against the contract above.

| Stage | Ticket | Repo |
|---|---|---|
| 1 | Cloud scaffold, schema, publish and serve slice | austere-cloud (new) |
| 1 | Chrome hosted mode | austere-axi |
| 1 | Cloudflare account, DNS, D1/R2, secrets (human) | — |
| 2 | `publish` command (upload, republish, list, rm) | austere-axi |
| 2 | Notes and replies API, reviewer send, long-poll | austere-cloud |
| 2 | Retention cron, report, takedown | austere-cloud |
| 3 | Sync remote notes into local sessions, reply push | austere-axi |
| 4 | Release, deploy, end-to-end smoke, docs | both |
