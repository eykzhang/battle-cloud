-- battle-cloud initial schema.
--
-- Three tables. `replays` is what Showdown gave us, `analyses` is what the engine
-- produced from it, and `jobs` is the queue that gets from one to the other.

-- A replay payload as fetched, stored so an analysis can be recomputed without
-- refetching and so an expired Showdown replay stays analyzable.
CREATE TABLE replays (
    id            text        PRIMARY KEY,
    format        text        NOT NULL,
    rating        integer,
    players       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    log           text        NOT NULL,
    payload_bytes integer     NOT NULL CHECK (payload_bytes >= 0),
    fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analyses (
    id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The eight identity fields. `profile` is deliberately not among them: it is
    -- shorthand that expands into the six engine parameters below, so two profiles
    -- that expanded identically should share one analysis rather than duplicate it.
    replay_id                 text        NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
    perspective               text        NOT NULL CHECK (perspective IN ('p1', 'p2')),
    search_budget_ms_per_turn integer     NOT NULL CHECK (search_budget_ms_per_turn > 0),
    opponent_samples          integer     NOT NULL CHECK (opponent_samples >= 1),
    threads                   integer     NOT NULL CHECK (threads >= 1),
    usage_stats_cutoff        integer     NOT NULL CHECK (usage_stats_cutoff >= 0),
    poke_engine_tag           text        NOT NULL,
    -- `seed` is in the identity even though schema v1 omits it from the document.
    -- EngineConfiguration in battle-brain's EngineService.swift carries five fields
    -- and the seed is not one of them, so without this column two analyses at
    -- different seeds would be indistinguishable and would collide here.
    seed                      integer     NOT NULL,

    document                  jsonb       NOT NULL,
    total_turns               integer     NOT NULL CHECK (total_turns >= 0),
    gradable_turns            integer     NOT NULL CHECK (gradable_turns >= 0),

    -- Degradation telemetry. The search is budgeted in wall-clock milliseconds, so an
    -- oversubscribed worker returns a weaker analysis rather than a slower one, and the
    -- document itself records only normalized visit shares. If it is not captured here
    -- it is not captured anywhere.
    wall_ms                   integer     NOT NULL CHECK (wall_ms >= 0),
    degraded                  boolean     NOT NULL DEFAULT false,

    created_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT analyses_identity_key UNIQUE (
        replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
        threads, usage_stats_cutoff, poke_engine_tag, seed
    )
);

CREATE INDEX analyses_replay_idx ON analyses (replay_id);

CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE jobs (
    id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The same eight identity fields, carried on the job so a claim needs no join and
    -- so a job remains meaningful before its analysis row exists.
    replay_id                 text        NOT NULL,
    perspective               text        NOT NULL CHECK (perspective IN ('p1', 'p2')),
    search_budget_ms_per_turn integer     NOT NULL CHECK (search_budget_ms_per_turn > 0),
    opponent_samples          integer     NOT NULL CHECK (opponent_samples >= 1),
    threads                   integer     NOT NULL CHECK (threads >= 1),
    usage_stats_cutoff        integer     NOT NULL CHECK (usage_stats_cutoff >= 0),
    poke_engine_tag           text        NOT NULL,
    seed                      integer     NOT NULL,

    -- Kept for display and for rate accounting. Not part of the identity.
    profile                   text        NOT NULL,

    status                    job_status  NOT NULL DEFAULT 'queued',
    attempts                  integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),

    claimed_by                text,
    claimed_at                timestamptz,
    lease_expires_at          timestamptz,

    -- Named estimates because that is what they are. analyze_replay is one blocking
    -- call with no progress callback, so these come from counting |turn| lines before
    -- any search runs. Nothing here is measured progress.
    estimated_turns           integer     CHECK (estimated_turns IS NULL OR estimated_turns >= 0),
    estimated_search_ms       integer     CHECK (estimated_search_ms IS NULL OR estimated_search_ms >= 0),

    analysis_id               uuid        REFERENCES analyses(id) ON DELETE SET NULL,
    error_kind                text,
    error_detail              text,

    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    -- A claimed job must carry the three claim columns together or none of them.
    CONSTRAINT jobs_claim_is_all_or_nothing CHECK (
        (claimed_by IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
        OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT jobs_succeeded_has_analysis CHECK (status <> 'succeeded' OR analysis_id IS NOT NULL),
    CONSTRAINT jobs_failed_has_kind CHECK (status <> 'failed' OR error_kind IS NOT NULL)
);

-- At most one live job per identity. This is what makes submission idempotent: a
-- resubmit of something already queued or running conflicts here, and the API turns
-- that conflict into "join the existing job" rather than into a second core-minute of
-- search. Partial, so completed jobs do not block a later re-analysis.
CREATE UNIQUE INDEX jobs_active_identity_key ON jobs (
    replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
    threads, usage_stats_cutoff, poke_engine_tag, seed
) WHERE status IN ('queued', 'running');

CREATE INDEX jobs_claimable_idx ON jobs (created_at, id) WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
