-- Claim one queued job for a worker.
--
-- The inner SELECT takes a row lock with SKIP LOCKED, which is the whole point: two
-- workers running this concurrently skip past each other's locked rows and each get a
-- different job, with no advisory locking and no retry loop. Without SKIP LOCKED the
-- second worker would block on the first's lock and then find the row no longer queued.
--
-- ORDER BY is deterministic (created_at, then id as a tiebreak) so the queue is FIFO
-- rather than arbitrary, and LIMIT 1 keeps a worker to one search at a time, which the
-- GIL finding requires.
--
-- attempts increments on claim, not on failure. A worker that dies without reporting
-- anything still consumed an attempt, and that is exactly the case the cap exists for.
UPDATE jobs
SET status           = 'running',
    attempts         = attempts + 1,
    claimed_by       = %(worker_id)s,
    claimed_at       = now(),
    lease_expires_at = now() + make_interval(secs => %(lease_seconds)s),
    updated_at       = now()
WHERE id = (
    SELECT id
    FROM jobs
    WHERE status = 'queued'
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING id, replay_id, perspective, profile, search_budget_ms_per_turn,
          opponent_samples, threads, usage_stats_cutoff, poke_engine_tag, seed,
          attempts, estimated_turns, lease_expires_at;
