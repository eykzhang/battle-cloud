-- An index for the public list of recent analyses.
--
-- The web client's landing page is a list of what has been analyzed, because a visitor
-- arriving with no replay id of their own has nothing else to look at. That page reads
-- analyses newest-first with keyset pagination on (created_at, id), which is a sort the
-- table had no index for: analyses_replay_idx covers lookups by replay and nothing else.
--
-- Descending on both columns to match the query's ORDER BY exactly. Postgres can read a
-- btree backwards, so an ascending index would also work, but the matching direction is
-- what keeps the plan a plain forward scan of the index.
--
-- The id is in the index for the tiebreak rather than for filtering: two analyses of the
-- same replay at different profiles are written within milliseconds of each other, and a
-- cursor on created_at alone would either skip or repeat one at a page boundary.

CREATE INDEX analyses_recent_idx ON analyses (created_at DESC, id DESC);
