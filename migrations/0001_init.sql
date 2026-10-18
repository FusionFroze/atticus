-- Epoch seconds on every *_at column. modified_at and reply_modified_at come from
-- Play. The others are written by Atticus. No AUTOINCREMENT: INTEGER PRIMARY KEY
-- is SQLite's rowid, and a deleted id may be reused.

CREATE TABLE reviews (
  id                INTEGER PRIMARY KEY,
  store             TEXT    NOT NULL,
  app_id            TEXT    NOT NULL,
  review_id         TEXT    NOT NULL,
  rating            INTEGER NOT NULL,
  previous_rating   INTEGER,                    -- the rating before the latest edit
  title             TEXT,
  body              TEXT    NOT NULL,
  original_body     TEXT,
  language          TEXT,
  author            TEXT,
  app_version_name  TEXT,
  app_version_code  INTEGER,
  os_version        TEXT,
  device            TEXT,
  thumbs_up         INTEGER NOT NULL DEFAULT 0,
  modified_at       INTEGER NOT NULL,           -- epoch s, the user's lastModified
  first_seen_at     INTEGER NOT NULL,           -- epoch s
  reply_text        TEXT,
  reply_modified_at INTEGER,                    -- epoch s, from Play
  replied_via       TEXT,                       -- 'bot' | 'external' | NULL
  replied_by        TEXT,                       -- Discord user id when via bot
  replied_at        INTEGER,                    -- epoch s, when Atticus published it
  UNIQUE (store, app_id, review_id)
);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  review_pk   INTEGER NOT NULL REFERENCES reviews(id),
  version     INTEGER NOT NULL,                 -- the review modified_at it shows
  channel_id  TEXT    NOT NULL,
  message_id  TEXT    NOT NULL,
  is_latest   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL                  -- epoch s
);
CREATE INDEX messages_review ON messages (review_pk, is_latest);

CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY,
  kind            TEXT    NOT NULL,             -- review_new | review_edited | message_update | connected | warning | recovered | digest
  review_pk       INTEGER REFERENCES reviews(id),
  payload         TEXT    NOT NULL DEFAULT '{}',-- JSON for non-review kinds; never secrets
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending | sent | failed
  sort_key        INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,   -- epoch s
  last_error      TEXT,                         -- a status and kind, never content
  created_at      INTEGER NOT NULL,             -- epoch s
  sent_at         INTEGER                       -- epoch s
);
CREATE INDEX outbox_pending ON outbox (status, next_attempt_at, sort_key);

CREATE TABLE state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL                   -- epoch s
);
