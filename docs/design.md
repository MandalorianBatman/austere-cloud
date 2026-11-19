# Hosted share links (austere-cloud): implementation notes

The contract is [`docs/hosted-share-links.md` in austere-axi](https://github.com/MandalorianBatman/austere-axi/blob/main/docs/hosted-share-links.md): decisions Q1–Q12 (approved by sid.kasat on RLM-245, 2026-11-09) and Q13–Q18, sync, access and presence (locked 2026-11-14). The wire protocol is implemented once, in the `austere-axi/sync` module; this service imports it and validates every client frame with its `parseClientFrame`. RLM-271 moves the contract into this repo. This file records how the service implements it and what it does not implement yet.

## Shape

```
Worker (src/index.ts)                     thin handlers: route, check credentials, hand off
  /api/owners, /api/pages, /api/objects   owner HTTP (src/api.ts, src/objects.ts)
  /api/me, /api/owners/claim, /api/pages/:id/{html,grants}   accounts (src/api.ts, src/accounts.ts)
  /api/pages/:id/sync, /p/:id/sync        WebSocket handshakes (src/sync.ts)
  /p/:id/asset-token                      account, owner session or invite -> asset token for the frame (src/sync.ts)
  /p/:id, /p/:id?login=<code>, /p/:id/a/<assetToken>/, /pk/<sha>.js   serving, owner sign-in (src/serve.ts)
  /auth/*, /, /dash/*                     AuthKit sign-in, the owner dashboard (src/web.ts, src/session.ts)
  /rt/<version>/<asset>                   pinned runtime proxy (src/runtime.ts)
PageObject (src/page.ts)                  one SQLite-backed Durable Object per page
D1                                        owners, users, grants, pages (the owner's index), page_objects, reports, limits, blocked_ids
R2                                        objects/<sha256>: page HTML and pack JS
```

## Owner HTTP

Owner routes take `Authorization: Bearer <credential>`: an anonymous owner token, or an account's WorkOS access token (see [Accounts](#accounts-workos-authkit)). A missing, unknown or unverified credential is 401, a blocked owner 403. Errors are JSON `{ error }`.

| Route | Behaviour |
|---|---|
| `POST /api/owners` | `201 { token }`. 5 per IP per day. |
| `POST /api/pages` | `201 { id, url }`: an empty page. It is not served or listed until its first `publish`, and its `expires_at` is creation + 24 h, so the retention cron (RLM-269) removes it like any expired page. |
| `PUT /api/objects/:sha256` | Body: the object, `Content-Type: text/html` or `text/javascript`, optionally `Content-Encoding: gzip`. The name must be lowercase hex. The decoded bytes must hash to the name (400). 1 MB on the wire and 16 MB decoded (413, naming the size). Stored as `objects/<sha256>` with its type; an existing object is left as is. `204`. |
| `GET /api/pages` | `{ pages: [{ id, title, url, expiresAt, notes }] }`: published, unexpired pages, newest first. For an account: the pages of every owner it holds. |
| `POST /api/pages/:id/login` | `200 { code, ttlMs }`: a single-use sign-in code for the owner's own page in the browser (see [Owner sign-in](#owner-sign-in)). 410 when taken down; 404 when missing, another owner's or not yet published. |
| `GET /api/me` | `{ user: { id, email, name } \| null, pages }`: the account behind an access token; `null` for an owner token. |
| `POST /api/owners/claim` | Access token only (403 otherwise). Body `{ token }`: an anonymous owner token. The account takes it over with its pages (`{ pages }`); the token keeps working. Again: a no-op. Another account's: 409. Unknown: 404. |
| `GET /api/pages/:id/html` | The published page HTML, for `austere-axi clone`. Owner only (404 otherwise). |
| `GET /api/pages/:id/grants`, `POST` `{ email }`, `DELETE /api/pages/:id/grants/:email` | The page's grants: `{ grants: [{ email, role, createdAt }] }`; `POST` is 201 (200 when it was there), `DELETE` 204 (404 when it was not) and closes the account's sockets. Emails are trimmed and lowercased; at most 100 per page. Owner only. |

`PUT /api/pages/:id`, `DELETE /api/pages/:id`, the notes long-poll, `POST …/replies`, `POST /p/:id/send` and `GET /p/:id/conversation` do not exist: they are the `publish` and `delete` mutations and the change feed now.

## Sockets

- `GET /api/pages/:id/sync?cli=<version>` (owner) and `GET /p/:id/sync` (reviewer). The handshake checks, in order: a WebSocket upgrade offering `austere-sync.1` (else 426), for the owner the `cli` version against `MIN_CLI_VERSION` (426) and the owner credential (403): `Authorization: Bearer <access token>` (a JWT is no valid subprotocol), else the owner token from `austere-owner.<token>`; for the reviewer a same-origin `Origin` when one is sent (403); then the page in D1: taken down, tombstoned or a blocked owner's (410), missing, expired or another owner's (404; an account owns the pages of every owner it holds). Reviewers also need a published page whose `cliVersion` still meets `MIN_CLI_VERSION` (426). The answer is `Sec-WebSocket-Protocol: austere-sync.1`; a credential is never echoed.
- A refused handshake is `{ error: { code, message } }`. 404 and 410 have no code of their own in the closed `ErrorCode` set: 404 carries `invalid` and 410 `forbidden`; clients act on the status.
- The Worker passes the socket's identity (role, owner id, `ip_hash`, and for a reviewer the SHA-256 of the offered invite token and of the `austere_owner` session cookie, and the signed-in account when it is the page's owner or has a grant) to the page object in an internal header on a fresh request, so a client cannot set it. The raw invite and session tokens never leave the Worker.

## Access (invites)

- Invites live in the page object's `invites` table: name, base64url SHA-256 of the token, expiry, revoked. Reviewers see no `acl` rows. The token hash is never in a row; the row's `grant` is `grantId(tokenHash)` from `austere-axi/sync` (its first 16 characters), which names the current token so an owner peer can tell whether its own link is the live one.
- A reviewer socket or asset token is let in by a live invite (not revoked, unexpired) whose hash matches; otherwise, on an `unlisted` page, as the open link; otherwise 403 `forbidden`. A wrong token on an unlisted page is the open link. The owner token is not accepted on reviewer routes.
- `grant` creates an invite, or replaces its token and expiry (and un-revokes it). A new token closes the sockets that came in with the old one (`error` `forbidden`, 1008); the same token only moves the expiry. The `acl` row's `grantedAt` is when the current token was first granted: re-granting the same token keeps it, a new token sets it. A past `expiresAt`, or a `tokenHash` another name holds, is `invalid`.
- `revoke` marks the invite revoked, writes its `acl` row with `revoked: true` and closes its sockets (`error` `forbidden`, 1008). An unknown name is `invalid`; revoking twice changes nothing.
- Expiry: the object's alarm is set to the earliest live invite expiry; it closes the expired invite's sockets and re-arms. A frame on a socket whose invite has expired also closes it.
- `POST /p/:id/asset-token` (same origin; a signed-in account, else the owner session in the `austere_owner` cookie, else the invite in `X-Austere-Invite`): `200 { token, expiresAt, name, title, owner }`. `name` is the account's name (`Owner` for the owner's account), the invite name, null on the open link, or `Owner` for the owner's session (`owner: true` for the owner; `false` otherwise). `title` is the page title: the shell does not carry it, so it reaches the chrome only once access is granted. The token is 32 random bytes, stored as its SHA-256 in `asset_tokens` for 10 minutes, for that page only. `GET /p/:id/a/<assetToken>/` serves the artifact while the token is unexpired and what it was issued on still holds (the account still owns the page or has its grant, the owner session or invite is live, or the page is still unlisted); otherwise 403. 404 and 410 follow the page.
- Notes on an invited socket count 60 per hour per invite, an account's per account; the open link counts per `ip_hash`. A name the open link declares is `Reviewer` when it is reserved (`Owner`, `You`, `Agent`, `Me`, `Render check`, any case), as on the local server.

## Accounts (WorkOS AuthKit)

Decided on RLM-405, built in RLM-414. An account is a WorkOS user; its id is the access token's `sub`. Accounts are on when `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` and `WORKOS_COOKIE_PASSWORD` (32+ characters) are set as Worker secrets; without them `/auth/*` answers 503 and only owner tokens and invites work. `WORKOS_API_BASE` (default `https://api.workos.com`) and `WORKOS_ISSUER` are optional vars.

- **D1** (`migrations/0002_accounts.sql`): `users` (WorkOS id, lowercased email, name), `owners.user_id` (the account an owner belongs to; NULL for an unclaimed anonymous token) and `grants` (page, lowercased email, role `collaborator`). A user may hold several owners: the one made for the account on first use (its token hash is of random bytes nobody keeps), plus every anonymous token it claimed. It owns every page of all of them; new pages go to its oldest owner.
- **Access tokens** (`src/jwt.ts`): RS256, signed by a key of `<api>/sso/jwks/<client id>`. The key set is cached per isolate for an hour, so a verify makes no network call; an unknown `kid` refetches it at most once per 5 minutes, and a failed refetch keeps the old set. Checked: the signature, `iss` (`WORKOS_ISSUER`, comma-separated, else `<api>` or `<api>/user_management/<client id>`), the audience (`client_id`, as WorkOS sets it, or `aud`, must be `WORKOS_CLIENT_ID`), `exp`, `nbf` and `iat`, each with 30 s of skew. A user seen for the first time is looked up once at `GET <api>/user_management/users/:id` (with the API key) and kept in `users`.
- **The CLI** (`austere-axi cloud login`) runs WorkOS CLI Auth (the device flow) against WorkOS itself with the client id only; `GET /auth/config` gives it `{ clientId, apiBase }`. It sends the access token as `Authorization: Bearer` on `/api/*` and on the owner socket's upgrade request, and refreshes it at WorkOS. On its first login it claims the machine's anonymous owner token (`POST /api/owners/claim`), so pages published before are the account's.
- **The browser**: `GET /auth/login?return_to=<path>` redirects (302) to `<api>/user_management/authorize` (`provider=authkit`) with a random `state`, kept with `return_to` in a sealed `austere_auth` cookie (`Path=/auth`, 10 minutes). `return_to` must be a same-origin path, else `/`. `GET /auth/callback` checks the state, exchanges the code (`POST <api>/user_management/authenticate`, `authorization_code`, with the API key), verifies the access token, writes the user, and answers 303 to `return_to` with `Set-Cookie: austere_session=<sealed>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` (plus `Secure` over https). The cookie holds the user id, the WorkOS session id and the access and refresh tokens, sealed with AES-256-GCM under a key derived from `WORKOS_COOKIE_PASSWORD`. `GET|POST /auth/logout` clears it and redirects to `<api>/user_management/sessions/logout` for the session.
- **Each request** with the cookie verifies its access token against the JWKS. An expired one is refreshed once (`refresh_token` grant, with the API key) and the response carries a new cookie with the rotated refresh token, the WebSocket handshake's 101 included. A refresh WorkOS refuses (the refresh token was used or the session ended), a cookie that does not unseal, or a token for another user clears the cookie; a failure that may pass (WorkOS unreachable) is signed out for that request and keeps the cookie. Two requests that refresh the same cookie at once race: the loser is signed out until the next page load.
- **On a page**: the account is the owner when it holds the page's owner, and a collaborator when its email has a grant. Either is let in on `POST /p/:id/asset-token` and `GET /p/:id/sync`, ahead of the owner's page sign-in and of any invite; anyone else falls through to them, so an account without a grant gets the same 403 as a visitor without an invite. The owner is named `Owner`; a collaborator by the account's name, or its email when the name is empty or reserved. Removing a grant closes the account's sockets on the page (`error` `forbidden`, 1008) and its asset tokens stop working. Deleting the page deletes its grants.
- **The dashboard** `GET /`: signed out, a sign-in link; signed in, the account's pages (title, notes, expiry) with their grants, a form to grant an email and one to remove each grant (`POST /dash/pages/:id/grants[/remove]`, same-origin `Origin` required, 303 back), and the pages shared with the account. Its CSP is `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' <api origin>` (sign-out redirects to WorkOS).
- **The shell** tells the chrome where a viewer without access signs in (`hosted.signIn`: `/auth/login?return_to=/p/<id>`, when accounts are on). It is a top-level navigation, so the shell's CSP needs nothing for it; the sandboxed frame stays `connect-src 'none'`.
- Not here: orgs, roles beyond owner and collaborator (RLM-249); removing anonymous owner tokens and invite links (a later decision).

## Owner sign-in

With accounts on, the owner's signed-in account does this on every page at once (see [Accounts](#accounts-workos-authkit)); the per-page sign-in stays for owners without an account.

The owner opens their own page in the browser without an invite (`austere-axi publish login <file>`):

- `POST /api/pages/:id/login` (owner bearer token) answers `{ code, ttlMs }`: 32 random bytes, base64url, single-use, live for 60 s (`OWNER_LOGIN_MS`). Only its SHA-256 is stored, in the page object's `owner_logins`.
- `GET /p/:id?login=<code>` consumes a live code, starts an owner session (32 random bytes; only its SHA-256 in `owner_sessions`, for 30 days) and answers `303` to `/p/:id` with `Set-Cookie: austere_owner=<token>; Path=/p/<id>; HttpOnly; SameSite=Lax; Max-Age=2592000` (plus `Secure` over https), `no-store`, `no-referrer`, `noindex`. A used, expired, unknown or malformed code is a plain-text 403; a gone page 410, a missing or unpublished one 404. Without `login` it is the shell.
- The cookie is scoped to the page by its path, and the session to the page's object, so a session of one page is nothing on another. On `POST /p/:id/asset-token` a live session wins over any invite (`name: "Owner"`, `owner: true`); its asset tokens die with it. On `GET /p/:id/sync` it lets the socket in as a reviewer named `Owner` (presence and note author), over any offered invite; it is closed (`error` `forbidden`, 1008) when the session expires, by the alarm or on its next frame. A cookie that is not a live session is ignored. Deleting the page ends its sessions.

## Page object

SQLite tables, all private to the object:

| Table | Holds |
|---|---|
| `meta` | The page id. |
| `ops` | The op log: every applied mutation as sent, with its key, role, time and `ip_hash`. Never sent to a client. |
| `rows` | The current state of each row by `(type, id)`, with the `seq` of its last change. The page's counter is the highest `seq`. |
| `acks` | The answer given to each `(clientId, n)`; `rate_limited` is not stored. |
| `invites` | Invite name, token SHA-256 (base64url), expiry, revoked. |
| `asset_tokens` | Asset token SHA-256, the invite hash it was issued on (NULL: open link), the owner session hash (`session_hash`), the account it was issued to (`account`, JSON: user, email, name, owner), expiry. `session_hash` and `account` are added by guarded `ALTER TABLE`s on older objects. |
| `owner_logins` | Owner sign-in code SHA-256, expiry (60 s). Pruned on write. |
| `owner_sessions` | Owner session token SHA-256, expiry (30 days). Pruned on write. |

- Mutations run one at a time, including their awaits on D1 and R2, so a duplicate key can't slip in between. The rows, the op and the ack commit in one transaction; then the ack goes to the sender and the rows to every socket that has finished a pull. An unexpected failure closes the socket with 1011, so the client re-sends.
- `publish` checks that the HTML object (type `text/html`) and every pack (type `text/javascript`, at most 16) were uploaded, runs the `<script src>` check below, then counts toward the publish limits (20 per owner and 100 per IP per day; `rate_limited` with `retryAfter`). It writes the D1 `pages` row and `page_objects` before it commits the `page` row, so a crash in between repeats on re-send. Objects the page no longer names are deleted once no page names them. The title is trimmed, capped at 200 characters, and `Untitled` when empty.
- `addNote` needs a published page and counts 60 per hour per invite (owner session: one count; open link: per `ip_hash`) per page. `author` is the invite name, or `Owner` on the owner's session; on the open link it is `name`, trimmed and cut to 40 characters (`LIMITS.nameChars`), or `Reviewer`. The note is `released` on an `auto` page, else `held`. It also bumps `pages.notes` in D1.
- `releaseNote` / `discardNote` change a `held` note and leave a settled one alone; an unknown note is `invalid`. `addReply` adds a `reply` row.
- `delete` removes the D1 row and the page's object references (deleting unreferenced objects), sends the `page` row with `deleted: true` to every socket, closes them with 1000 and deletes the object's storage.
- `grant` and `revoke`: see [Access](#access-invites). Presence: see [Presence](#presence).
- `pull` sends rows after the cursor in frames of 500 (`more: true` on all but the last; `reset: true` when the cursor is ahead of the counter). Reviewers never get `acl` rows; their live frames still carry the page's counter.
- Socket identity and the "has pulled" flag live in the socket attachment, so they survive hibernation.

## Presence

`src/presence.ts` holds the rules; the page object holds the roster. Nothing about presence touches SQLite: each viewer lives in its socket's attachment (`viewer: { id, name, colour, role, status, focus, last }`), so it survives hibernation and goes with the socket.

- Runs while the `page` row has `presence: true` and is not deleted. Otherwise every presence frame is dropped, including on an owner socket before the first `publish`. A `publish` with `presence: false` sends every viewer a `bye` for every viewer and clears the roster.
- `hello` makes the socket a viewer. A second `hello` keeps the id, updates `status` and the name (the chrome sends one when its name prompt is answered), and re-sends the roster. The joiner gets a `hello` for each other viewer, then its own with `self: true`; the others get its `hello`. `id` is 8 random bytes, base64url, per socket.
- Names: the owner is `Owner`, on the owner socket or a reviewer socket let in by the owner's account or page session; a collaborator's account goes by its account name (its email when that is empty or reserved); a reviewer is `hello.name`, trimmed, cut to 40 characters, `Reviewer` when empty or reserved (`viewerName`). An invited socket's name is its invite name (`viewerName`), whatever `hello.name` says.
- Colour: FNV-1a of the name into a 10-colour palette, moved on to the next colour no viewer present has. Another socket under a name already present gets that name's colour. Alone, a name always gets the same colour.
- `status` and `focus` are sent to the others only when they change; a repeated `status` is just the heartbeat. A socket gets no presence frames before its own `hello`, and none of its own changes back.
- Any frame from a viewer (presence, `pull`, mutation) counts as its heartbeat. The object's one alarm serves presence, invite expiry and owner-session expiry (`scheduleAlarm`: the earliest of the next invite expiry, the next session expiry of an open socket, and the next viewer that would go silent); a viewer silent for 60 s is marked gone and the others get its `bye`. Its next frame brings it back under the same id with a `hello` to the others. A gone viewer still receives presence, so its roster stays current.
- `bye`, a closed or errored socket, and every server-side close (1008, 1011) send `bye` to the others. `delete` closes everyone, so it sends none.
- More than 10 presence frames in one second from one socket are dropped.

## Publish rules

The `<script src>` check is the one from the first slice, applied to the HTML object at `publish`: every `src` must be `/rt/<cliVersion>/<allow-listed asset>` or `/pk/<sha256>.js` for a pack the same `publish` names. It is strict on purpose: no query strings, whitespace or entities. `cliVersion` must be a plain `x.y.z` release at or above `MIN_CLI_VERSION`. Both failures are `invalid`.

## Serving

- `GET /p/:id` is the chrome shell (public: it holds no content, not even the title: `<title>Shared page · austere</title>`, boot `title` and `name` `Shared page`), `GET /p/:id/a/<assetToken>/` the page HTML object (403 without a valid asset token), both 404 until the first publish. The shell's CSP allows its inline boot script by SHA-256; the artifact is served with `sandbox allow-scripts` and `connect-src 'none'`. Both send `Referrer-Policy: no-referrer`. The boot object's `artifactUrl` (`/p/:id/a/`) is the prefix the chrome appends `<assetToken>/` to.
- `GET /pk/<sha>.js` serves a `text/javascript` object that some page names (`immutable`, `nosniff`). An object nobody has named yet, or an HTML object, is 404.
- `GET /rt/<version>/<asset>` proxies `https://cdn.jsdelivr.net/npm/austere-axi@<version>/dist/<asset>` for versions at or above `MIN_CLI_VERSION` and the assets `austere.js`, `chrome/chrome.js`, `chrome/chrome.css` and `packs/<name>.js` (mapped to `dist/packs/<name>/pack.js`). Only 200s are cached; a missing version is 404, any other upstream failure 502.

## Not here yet

| What | Ticket |
|---|---|
| Presence relay to the local review page (SSE) | RLM-270 |
| Retention cron, unnamed-object cleanup, report, takedown (and closing open sockets on takedown) | RLM-269 |
| `MIN_CLI_VERSION` confirmed, deploy, `austere-axi/sync` from npm | RLM-271 |
