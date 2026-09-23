-- Level histogram position (GAME_DESIGN.md §7.7 「面のヒストグラム」). Owner: O9.
-- plays.t120: on level boards, the time (1/120 s) this player is counted with in boards.hist; NULL = not counted.
-- Daily rows are always NULL. Only ever made faster (submit.ts SQL_UPSERT_PLAY). Additive: the Worker before this
-- change never reads it and its INSERT OR IGNORE leaves it NULL. No data is written here (the seed is a separate step).
ALTER TABLE plays ADD COLUMN t120 INTEGER;
