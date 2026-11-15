# Hosted share links (austere-cloud): implementation notes

The contract is [`docs/hosted-share-links.md` in austere-axi](https://github.com/MandalorianBatman/austere-axi/blob/main/docs/hosted-share-links.md): decisions Q1–Q12 (approved by sid.kasat on RLM-245, 2026-11-09) and Q13–Q18, sync, access and presence (locked 2026-11-14). The wire protocol is implemented once, in the `austere-axi/sync` module; this service imports it and validates every client frame with its `parseClientFrame`. RLM-271 moves the contract into this repo. This file records how the service implements it and what it does not implement yet.

## Shape

```
Worker (src/index.ts)                     thin handlers: route, check credentials, hand off
  /api/owners, /api/pages, /api/objects   owner HTTP (src/api.ts, src/objects.ts)
  /api/pages/:id/sync, /p/:id/sync        WebSocket handshakes (src/sync.ts)
  /p/:id/asset-token                      invite -> asset token for the frame (src/sync.ts)
  /p/:id, /p/:id/a/<assetToken>/, /pk/<sha>.js   serving (src/serve.ts)
  /rt/<version>/<asset>                   pinned runtime proxy (src/runtime.ts)
PageObject (src/page.ts)                  one SQLite-backed Durable Object per page
D1                                        owners, pages (the owner's index), page_objects, reports, limits, blocked_ids
R2                                        objects/<sha256>: page HTML and pack JS
```

## Owner HTTP

Owner routes take `Authorization: Bearer <token>`. A missing or unknown token is 401, a blocked owner 403. Errors are JSON `{ error }`.

| Route | Behaviour |
|---|---|
| `POST /api/owners` | `201 { token }`. 5 per IP per day. |
| `POST /api/pages` | `201 { id, url }`: an empty page. It is not served or listed until its first `publish`, and its `expires_at` is creation + 24 h, so the retention cron (RLM-269) removes it like any expired page. |
| `PUT /api/objects/:sha256` | Body: the object, `Content-Type: text/html` or `text/javascript`, optionally `Content-Encoding: gzip`. The name must be lowercase hex. The decoded bytes must hash to the name (400). 1 MB on the wire and 16 MB decoded (413, naming the size). Stored as `objects/<sha256>` with its type; an existing object is left as is. `204`. |
| `GET /api/pages` | `{ pages: [{ id, title, url, expiresAt, notes }] }`: published, unexpired pages, newest first. |

`PUT /api/pages/:id`, `DELETE /api/pages/:id`, the notes long-poll, `POST …/replies`, `POST /p/:id/send` and `GET /p/:id/conversation` do not exist: they are the `publish` and `delete` mutations and the change feed now.

## Sockets

- `GET /api/pages/:id/sync?cli=<version>` (owner) and `GET /p/:id/sync` (reviewer). The handshake checks, in order: a WebSocket upgrade offering `austere-sync.1` (else 426), for the owner the `cli` version against `MIN_CLI_VERSION` (426) and the owner token from `austere-owner.<token>` (403), for the reviewer a same-origin `Origin` when one is sent (403); then the page in D1: taken down, tombstoned or a blocked owner's (410), missing, expired or another owner's (404). Reviewers also need a published page whose `cliVersion` still meets `MIN_CLI_VERSION` (426). The answer is `Sec-WebSocket-Protocol: austere-sync.1`; a credential is never echoed.
- A refused handshake is `{ error: { code, message } }`. 404 and 410 have no code of their own in the closed `ErrorCode` set: 404 carries `invalid` and 410 `forbidden`; clients act on the status.
- The Worker passes the socket's identity (role, owner id, `ip_hash`, and for a reviewer the SHA-256 of the offered invite token) to the page object in an internal header on a fresh request, so a client cannot set it. The raw invite token never leaves the Worker.

## Access (invites)

- Invites live in the page object's `invites` table: name, base64url SHA-256 of the token, expiry, revoked. Reviewers see no `acl` rows and the token hash is never in a row.
- A reviewer socket or asset token is let in by a live invite (not revoked, unexpired) whose hash matches; otherwise, on an `unlisted` page, as the open link; otherwise 403 `forbidden`. A wrong token on an unlisted page is the open link. The owner token is not accepted on reviewer routes.
- `grant` creates an invite, or replaces its token and expiry (and un-revokes it). A new token closes the sockets that came in with the old one (`error` `forbidden`, 1008); the same token only moves the expiry. A past `expiresAt`, or a `tokenHash` another name holds, is `invalid`.
- `revoke` marks the invite revoked, writes its `acl` row with `revoked: true` and closes its sockets (`error` `forbidden`, 1008). An unknown name is `invalid`; revoking twice changes nothing.
- Expiry: the object's alarm is set to the earliest live invite expiry; it closes the expired invite's sockets and re-arms. A frame on a socket whose invite has expired also closes it.
- `POST /p/:id/asset-token` (same origin; invite in `X-Austere-Invite`): `200 { token, expiresAt, name }`, `name` null on the open link. The token is 32 random bytes, stored as its SHA-256 in `asset_tokens` for 10 minutes, for that page only. `GET /p/:id/a/<assetToken>/` serves the artifact while the token is unexpired and what it was issued on still holds (the invite is live, or the page is still unlisted); otherwise 403. 404 and 410 follow the page.
- Notes on an invited socket count 60 per hour per invite; the open link counts per `ip_hash`.

## Page object

SQLite tables, all private to the object:

| Table | Holds |
|---|---|
| `meta` | The page id. |
| `ops` | The op log: every applied mutation as sent, with its key, role, time and `ip_hash`. Never sent to a client. |
| `rows` | The current state of each row by `(type, id)`, with the `seq` of its last change. The page's counter is the highest `seq`. |
| `acks` | The answer given to each `(clientId, n)`; `rate_limited` is not stored. |
| `invites` | Invite name, token SHA-256 (base64url), expiry, revoked. |
| `asset_tokens` | Asset token SHA-256, the invite hash it was issued on (NULL: open link), expiry. |

- Mutations run one at a time, including their awaits on D1 and R2, so a duplicate key can't slip in between. The rows, the op and the ack commit in one transaction; then the ack goes to the sender and the rows to every socket that has finished a pull. An unexpected failure closes the socket with 1011, so the client re-sends.
- `publish` checks that the HTML object (type `text/html`) and every pack (type `text/javascript`, at most 16) were uploaded, runs the `<script src>` check below, then counts toward the publish limits (20 per owner and 100 per IP per day; `rate_limited` with `retryAfter`). It writes the D1 `pages` row and `page_objects` before it commits the `page` row, so a crash in between repeats on re-send. Objects the page no longer names are deleted once no page names them. The title is trimmed, capped at 200 characters, and `Untitled` when empty.
- `addNote` needs a published page and counts 60 per hour per invite (open link: per `ip_hash`) per page. `author` is the invite name; on the open link it is `name`, trimmed and cut to 40 characters (`LIMITS.nameChars`), or `Reviewer`. The note is `released` on an `auto` page, else `held`. It also bumps `pages.notes` in D1.
- `releaseNote` / `discardNote` change a `held` note and leave a settled one alone; an unknown note is `invalid`. `addReply` adds a `reply` row.
- `delete` removes the D1 row and the page's object references (deleting unreferenced objects), sends the `page` row with `deleted: true` to every socket, closes them with 1000 and deletes the object's storage.
- `grant` and `revoke`: see [Access](#access-invites). Presence: see [Presence](#presence).
- `pull` sends rows after the cursor in frames of 500 (`more: true` on all but the last; `reset: true` when the cursor is ahead of the counter). Reviewers never get `acl` rows; their live frames still carry the page's counter.
- Socket identity and the "has pulled" flag live in the socket attachment, so they survive hibernation.

## Presence

`src/presence.ts` holds the rules; the page object holds the roster. Nothing about presence touches SQLite: each viewer lives in its socket's attachment (`viewer: { id, name, colour, role, status, focus, last }`), so it survives hibernation and goes with the socket.

- Runs while the `page` row has `presence: true` and is not deleted. Otherwise every presence frame is dropped, including on an owner socket before the first `publish`. A `publish` with `presence: false` sends every viewer a `bye` for every viewer and clears the roster.
- `hello` makes the socket a viewer. A second `hello` keeps the id, updates `status` and the name (the chrome sends one when its name prompt is answered), and re-sends the roster. The joiner gets a `hello` for each other viewer, then its own with `self: true`; the others get its `hello`. `id` is 8 random bytes, base64url, per socket.
- Names: the owner is `Owner`; a reviewer is `hello.name`, trimmed, cut to 40 characters, `Reviewer` when empty (`viewerName`). An invited socket's name is its invite name (`viewerName`), whatever `hello.name` says.
- Colour: FNV-1a of the name into a 10-colour palette, moved on to the next colour no viewer present has. Another socket under a name already present gets that name's colour. Alone, a name always gets the same colour.
- `status` and `focus` are sent to the others only when they change; a repeated `status` is just the heartbeat. A socket gets no presence frames before its own `hello`, and none of its own changes back.
- Any frame from a viewer (presence, `pull`, mutation) counts as its heartbeat. The object's one alarm serves both presence and invite expiry (`scheduleAlarm`: the earlier of the next invite expiry and the next viewer that would go silent); a viewer silent for 60 s is marked gone and the others get its `bye`. Its next frame brings it back under the same id with a `hello` to the others. A gone viewer still receives presence, so its roster stays current.
- `bye`, a closed or errored socket, and every server-side close (1008, 1011) send `bye` to the others. `delete` closes everyone, so it sends none.
- More than 10 presence frames in one second from one socket are dropped.

## Publish rules

The `<script src>` check is the one from the first slice, applied to the HTML object at `publish`: every `src` must be `/rt/<cliVersion>/<allow-listed asset>` or `/pk/<sha256>.js` for a pack the same `publish` names. It is strict on purpose: no query strings, whitespace or entities. `cliVersion` must be a plain `x.y.z` release at or above `MIN_CLI_VERSION`. Both failures are `invalid`.

## Serving

- `GET /p/:id` is the chrome shell (public: it holds no content), `GET /p/:id/a/<assetToken>/` the page HTML object (403 without a valid asset token), both 404 until the first publish. The shell's CSP allows its inline boot script by SHA-256; the artifact is served with `sandbox allow-scripts` and `connect-src 'none'`. Both send `Referrer-Policy: no-referrer`. The boot object's `artifactUrl` (`/p/:id/a/`) is the prefix the chrome appends `<assetToken>/` to.
- `GET /pk/<sha>.js` serves a `text/javascript` object that some page names (`immutable`, `nosniff`). An object nobody has named yet, or an HTML object, is 404.
- `GET /rt/<version>/<asset>` proxies `https://cdn.jsdelivr.net/npm/austere-axi@<version>/dist/<asset>` for versions at or above `MIN_CLI_VERSION` and the assets `austere.js`, `chrome/chrome.js`, `chrome/chrome.css` and `packs/<name>.js` (mapped to `dist/packs/<name>/pack.js`). Only 200s are cached; a missing version is 404, any other upstream failure 502.

## Not here yet

| What | Ticket |
|---|---|
| Presence relay to the local review page (SSE) | RLM-270 |
| Retention cron, unnamed-object cleanup, report, takedown (and closing open sockets on takedown) | RLM-269 |
| `MIN_CLI_VERSION` confirmed, deploy, `austere-axi/sync` from npm | RLM-271 |
