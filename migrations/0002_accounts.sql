-- Accounts (RLM-414): WorkOS AuthKit users, the owners they hold, and per-page grants.
-- All timestamps are Unix milliseconds.

-- A signed-in person. `id` is the WorkOS user id (the access token's `sub`).
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,        -- lowercased
  name        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX users_email ON users (email);

-- The account an owner belongs to. NULL: an anonymous owner token nobody has claimed.
-- A user may hold several owners: the one made for the account, plus every anonymous token it claimed.
ALTER TABLE owners ADD COLUMN user_id TEXT;
CREATE INDEX owners_user ON owners (user_id);

-- Who besides the owner may open a page: an account, by email, so a grant can come before the sign-up.
CREATE TABLE grants (
  page_id     TEXT NOT NULL,
  email       TEXT NOT NULL,        -- lowercased
  role        TEXT NOT NULL DEFAULT 'collaborator',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (page_id, email)
);
CREATE INDEX grants_email ON grants (email);
