-- Return abandoned jobs to the queue, or dead-letter them.
--
-- A worker that crashes, is OOM-killed, or loses its container never reports anything,
-- so the only evidence is a lease that stopped being renewed. One statement handles both
-- outcomes so a job cannot be observed in between them: under the attempt cap it goes
-- back to 'queued' for another worker, at the cap it becomes 'failed' with a
-- dead-letter reason rather than cycling forever.
--
-- attempts is already incremented by claim_job, so the comparison here is against work
-- already spent, not work about to be spent.
UPDATE jobs
SET status = CASE
        WHEN attempts < %(max_attempts)s THEN 'queued'::job_status
        ELSE 'failed'::job_status
    END,
    error_kind = CASE
        WHEN attempts < %(max_attempts)s THEN error_kind
        ELSE 'engine_internal_error'
    END,
    error_detail = CASE
        WHEN attempts < %(max_attempts)s THEN error_detail
        ELSE 'lease expired after ' || attempts || ' attempt(s); last worker: ' || coalesce(claimed_by, 'unknown')
    END,
    claimed_by       = NULL,
    claimed_at       = NULL,
    lease_expires_at = NULL,
    updated_at       = now()
WHERE status = 'running'
  AND lease_expires_at < now()
RETURNING id, status, attempts;
