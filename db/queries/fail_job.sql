-- Record a reported failure.
--
-- Distinct from reclaim_expired: this is a worker that survived and classified what went
-- wrong, so the error kind is real rather than inferred from silence. Retryable failures
-- under the cap return to the queue; everything else is terminal.
--
-- Whether a kind is retryable is the caller's judgement, not this query's. A malformed
-- replay will fail identically on every worker and retrying it wastes a core-minute,
-- while a transport failure fetching usage stats might not.
UPDATE jobs
SET status = CASE
        WHEN %(retryable)s AND attempts < %(max_attempts)s THEN 'queued'::job_status
        ELSE 'failed'::job_status
    END,
    error_kind       = %(error_kind)s,
    error_detail     = %(error_detail)s,
    claimed_by       = NULL,
    claimed_at       = NULL,
    lease_expires_at = NULL,
    updated_at       = now()
WHERE id         = %(job_id)s
  AND status     = 'running'
  AND claimed_by = %(worker_id)s
RETURNING id, status, attempts, error_kind;
