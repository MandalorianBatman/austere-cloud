-- Every table the service needs, in one migration, so tickets that add notes,
-- replies, reports and expiry don't collide on migration numbers.
-- All timestamps are Unix milliseconds.

CREATE TABLE owners (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the bearer token
  created_at  INTEGER NOT NULL,
  blocked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pages (
  id            TEXT PRIMARY KEY,     -- 16 random bytes, base64url (22 chars)
  owner_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  cli_version   TEXT NOT NULL,
  auto          INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL,     -- size of the gzip upload body
  packs         TEXT NOT NULL DEFAULT '[]', -- JSON [{ sha256, name, version }] of uploaded third-party packs
  created_at    INTEGER NOT NULL,
  published_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  taken_down    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pages_owner ON pages (owner_id);
CREATE INDEX pages_expires ON pages (expires_at);

CREATE TABLE notes (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  TEXT NOT NULL,
  author   TEXT NOT NULL,
  items    TEXT NOT NULL,             -- JSON
  ip_hash  TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX notes_page ON notes (page_id, seq);

CREATE TABLE replies (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  TEXT NOT NULL,
  text     TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX replies_page ON replies (page_id, seq);

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
