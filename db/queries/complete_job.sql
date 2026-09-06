-- Mark a job succeeded and attach its analysis.
--
-- Scoped to the claiming worker for the same reason heartbeat is: a worker whose lease
-- expired mid-analysis has had its job handed to someone else, and its late result must
-- not overwrite whatever the new owner is doing. Zero rows updated means the result is
-- stale and should be dropped.
--
-- The claim columns are cleared together because jobs_claim_is_all_or_nothing requires
-- it.
UPDATE jobs
SET status           = 'succeeded',
    analysis_id      = %(analysis_id)s,
    error_kind       = NULL,
    error_detail     = NULL,
    claimed_by       = NULL,
    claimed_at       = NULL,
    lease_expires_at = NULL,
    updated_at       = now()
WHERE id         = %(job_id)s
  AND status     = 'running'
  AND claimed_by = %(worker_id)s
RETURNING id, status, analysis_id;
