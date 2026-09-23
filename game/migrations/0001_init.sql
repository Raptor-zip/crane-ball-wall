-- D1 schema (GAME_DESIGN.md §7.7). Owner: O9.
-- No secondary indexes: one written row = one row write.

CREATE TABLE runs (
  board     TEXT    NOT NULL,
  pidh      TEXT    NOT NULL,
  name_seed INTEGER NOT NULL,
  t120      INTEGER,              -- time (1/120 s); NULL for a daily participation without success
  gap_um    INTEGER,              -- minimum clearance [um] (computed by the server)
  peak_cn   INTEGER,              -- peak |F| [cN] (computed by the server)
  device    INTEGER NOT NULL DEFAULT 0,
  tries     INTEGER NOT NULL DEFAULT 1,   -- daily: balls used (self-reported)
  balls     TEXT,                 -- daily: e.g. "XXOC-" (X fail, O ok, G gold, C crown, - unused)
  replay    BLOB,                 -- kept only while in the top 100; NULL for AI-beaten-only rows and daily rows without success
  created   INTEGER NOT NULL,     -- ms epoch
  PRIMARY KEY (board, pidh)
) WITHOUT ROWID;

CREATE TABLE boards (
  board     TEXT PRIMARY KEY,
  ver       INTEGER NOT NULL DEFAULT 0,   -- optimistic lock
  top       TEXT    NOT NULL DEFAULT '[]',-- JSON [[pidh,nameSeed,t120,gapUm,device,created], ...] max 100, ascending
  n         INTEGER NOT NULL DEFAULT 0,   -- people with a runs row (level: top-100 or AI-beaten; daily: submitters), counted once each
  cleared   INTEGER NOT NULL DEFAULT 0,   -- daily: people who succeeded
  ai_beaten INTEGER NOT NULL DEFAULT 0,   -- people accepted below par (first time only)
  par       INTEGER NOT NULL,             -- parSub of the level
  hist      TEXT,                          -- daily only: JSON of 150 bins (0.2 s, 0-30 s, last bin >= 29.8 s)
  wr        BLOB,                          -- replay of rank 1
  tok       TEXT,                          -- random token of the last updating request (§7.8 step 7)
  updated   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE counters (
  k TEXT PRIMARY KEY,    -- 'req:<JST date>' / 'wr:<JST date>'
  n INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
