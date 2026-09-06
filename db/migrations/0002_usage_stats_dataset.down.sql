-- Reverses 0002. Dropping the column loses which stats dataset produced each analysis,
-- and the identity constraints go back to eight columns, so two analyses that differ
-- only by dataset would collide. Only safe on a database that holds one dataset.

DROP INDEX jobs_active_identity_key;
ALTER TABLE analyses DROP CONSTRAINT analyses_identity_key;

ALTER TABLE jobs DROP COLUMN usage_stats_dataset;
ALTER TABLE analyses DROP COLUMN usage_stats_dataset;

ALTER TABLE analyses ADD CONSTRAINT analyses_identity_key UNIQUE (
    replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
    threads, usage_stats_cutoff, poke_engine_tag, seed
);

CREATE UNIQUE INDEX jobs_active_identity_key ON jobs (
    replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
    threads, usage_stats_cutoff, poke_engine_tag, seed
) WHERE status IN ('queued', 'running');
