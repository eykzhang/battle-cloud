-- The usage-stats dataset joins the analysis identity.
--
-- Usage stats drive opponent-team sampling, so the month of the stats file is an input
-- to the analysis in exactly the way `poke_engine_tag` is. `usage_stats_cutoff` does not
-- stand in for it: the cutoff selects a file within a month, and every month publishes a
-- 1500 file. Without this column, bumping the stats file in a worker image would serve
-- analyses computed against one prior under cache keys created for another, with nothing
-- recording the difference.
--
-- The backfill value is the dataset every image built so far has carried
-- (`2026-07_gen9ou-1500.json`), so existing rows are labelled with what actually produced
-- them. Check that before applying this to any database whose rows predate a stats bump.

ALTER TABLE analyses
    ADD COLUMN usage_stats_dataset text NOT NULL DEFAULT '2026-07'
        CHECK (usage_stats_dataset <> '');
ALTER TABLE analyses ALTER COLUMN usage_stats_dataset DROP DEFAULT;

ALTER TABLE jobs
    ADD COLUMN usage_stats_dataset text NOT NULL DEFAULT '2026-07'
        CHECK (usage_stats_dataset <> '');
ALTER TABLE jobs ALTER COLUMN usage_stats_dataset DROP DEFAULT;

ALTER TABLE analyses DROP CONSTRAINT analyses_identity_key;
ALTER TABLE analyses ADD CONSTRAINT analyses_identity_key UNIQUE (
    replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
    threads, usage_stats_cutoff, usage_stats_dataset, poke_engine_tag, seed
);

DROP INDEX jobs_active_identity_key;
CREATE UNIQUE INDEX jobs_active_identity_key ON jobs (
    replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
    threads, usage_stats_cutoff, usage_stats_dataset, poke_engine_tag, seed
) WHERE status IN ('queued', 'running');
