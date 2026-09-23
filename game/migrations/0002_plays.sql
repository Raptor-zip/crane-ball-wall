-- Play population (GAME_DESIGN.md §7.7). Owner: O9.
-- One row per board and player whose verified run reached the Worker, whatever its rank: runs only keeps the
-- top 100 / AI-beaten rows, so it undercounts. The client sends each level's first clear once (§7.9 playSent).
-- INSERT OR IGNORE: a known (board, pidh) writes nothing.

CREATE TABLE plays (
  board   TEXT    NOT NULL,
  pidh    TEXT    NOT NULL,
  created INTEGER NOT NULL,     -- ms epoch of the first verified run
  PRIMARY KEY (board, pidh)
) WITHOUT ROWID;
