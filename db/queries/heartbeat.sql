-- Extend a running job's lease.
--
-- Scoped to the claiming worker: a worker whose lease already expired and whose job was
-- reclaimed by someone else must not be able to extend it back out from under the new
-- owner. Zero rows updated means "you no longer own this job", which is the signal to
-- abandon the work in progress.
UPDATE jobs
SET lease_expires_at = now() + make_interval(secs => %(lease_seconds)s),
    updated_at       = now()
WHERE id         = %(job_id)s
  AND status     = 'running'
  AND claimed_by = %(worker_id)s
RETURNING id, lease_expires_at;
