-- Submit a job, or join the one already running for this identity.
--
-- ON CONFLICT against the partial unique index jobs_active_identity_key. A resubmission
-- while a job is queued or running returns the existing row instead of starting a second
-- core-minute of identical search. DO UPDATE rather than DO NOTHING because DO NOTHING
-- returns no row, and the caller needs the existing job's id to hand back a handle.
--
-- The no-op assignment is deliberate: it is the cheapest way to make the conflicting row
-- visible to RETURNING.
INSERT INTO jobs (
    replay_id, perspective, profile, search_budget_ms_per_turn, opponent_samples,
    threads, usage_stats_cutoff, usage_stats_dataset, poke_engine_tag, seed,
    estimated_turns, estimated_search_ms
)
VALUES (
    %(replay_id)s, %(perspective)s, %(profile)s, %(search_budget_ms_per_turn)s,
    %(opponent_samples)s, %(threads)s, %(usage_stats_cutoff)s, %(usage_stats_dataset)s,
    %(poke_engine_tag)s, %(seed)s, %(estimated_turns)s, %(estimated_search_ms)s
)
ON CONFLICT (replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
             threads, usage_stats_cutoff, usage_stats_dataset, poke_engine_tag, seed)
WHERE status IN ('queued', 'running')
DO UPDATE SET updated_at = jobs.updated_at
RETURNING id, status, attempts, (xmax = 0) AS created;
