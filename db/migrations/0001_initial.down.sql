DROP INDEX IF EXISTS jobs_lease_idx;
DROP INDEX IF EXISTS jobs_claimable_idx;
DROP INDEX IF EXISTS jobs_active_identity_key;
DROP TABLE IF EXISTS jobs;
DROP TYPE IF EXISTS job_status;
DROP INDEX IF EXISTS analyses_replay_idx;
DROP TABLE IF EXISTS analyses;
DROP TABLE IF EXISTS replays;
