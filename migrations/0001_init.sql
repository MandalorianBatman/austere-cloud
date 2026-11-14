-- Every D1 table the service needs, in one migration, so later tickets that add
-- reports and expiry don't collide on migration numbers. Notes, replies and invites
-- live in each page's Durable Object (PageObject), not here.
-- All timestamps are Unix milliseconds.

CREATE TABLE owners (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the bearer token
  created_at  INTEGER NOT NULL,
  blocked     INTEGER NOT NULL DEFAULT 0
);

-- The owner's index of pages. The page object writes it on `publish` and `delete`.
CREATE TABLE pages (
  id            TEXT PRIMARY KEY,     -- 16 random bytes, base64url (22 chars)
  owner_id      TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  cli_version   TEXT NOT NULL DEFAULT '',
  html          TEXT,                 -- hex SHA-256 of the page HTML object; NULL until the first publish
  auto          INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0, -- size of the objects the last publish named
  notes         INTEGER NOT NULL DEFAULT 0, -- notes added, for `GET /api/pages`
  created_at    INTEGER NOT NULL,
  published_at  INTEGER,              -- NULL until the first publish
  expires_at    INTEGER NOT NULL,     -- created_at + 24 h until the first publish, then published_at + 30 days
  taken_down    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pages_owner ON pages (owner_id);
CREATE INDEX pages_expires ON pages (expires_at);

-- Objects (R2 `objects/<sha>`) each page's last publish names: the page HTML and its packs.
-- An object is deleted once no row references its sha.
CREATE TABLE page_objects (
  page_id  TEXT NOT NULL,
  sha      TEXT NOT NULL,
  PRIMARY KEY (page_id, sha)
);
CREATE INDEX page_objects_sha ON page_objects (sha);

CREATE TABLE reports (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  TEXT NOT NULL,
  reason   TEXT NOT NULL,
  ip_hash  TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX reports_page ON reports (page_id);

-- Fixed-window rate limits: one row per key.
CREATE TABLE limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);

-- Takedown tombstones: a taken-down page id never serves again.
CREATE TABLE blocked_ids (
  page_id  TEXT PRIMARY KEY
);
