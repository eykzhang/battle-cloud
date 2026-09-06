"""Queue behavior, against a real Postgres.

These are not schema-review notes. Every claim here is executed: SKIP LOCKED's
concurrency property in particular cannot be verified by reading SQL.
"""

from __future__ import annotations

import pytest

from conftest import IDENTITY, claim, enqueue, sql, status_of


def test_enqueue_returns_a_new_job(db):
    row = enqueue(db)
    assert row[1] == "queued"
    assert row[3] is True, "xmax = 0 means the row was inserted rather than conflicted"


def test_resubmitting_a_live_identity_joins_the_existing_job(db):
    first = enqueue(db)
    second = enqueue(db)
    assert second[0] == first[0], "a resubmit must join, not start a second core-minute of search"
    assert second[3] is False, "the second call conflicted rather than inserting"
    with db.cursor() as cur:
        cur.execute("SELECT count(*) FROM jobs")
        assert cur.fetchone()[0] == 1


def test_an_identity_differing_only_in_seed_is_a_different_job(db):
    first = enqueue(db)
    second = enqueue(db, seed=1)
    assert second[0] != first[0]


def test_an_identity_differing_only_in_perspective_is_a_different_job(db):
    assert enqueue(db)[0] != enqueue(db, perspective="p1")[0]


def test_a_finished_job_does_not_block_re_analysis(db):
    """The active-identity index is partial. A succeeded job must not prevent asking
    the same question again later."""
    first = enqueue(db)
    db.execute("UPDATE jobs SET status = 'cancelled' WHERE id = %s", (first[0],))
    second = enqueue(db)
    assert second[0] != first[0]


def test_two_concurrent_claims_get_different_jobs(db, second_db):
    """The whole reason for SKIP LOCKED. Without it the second claimer blocks on the
    first's row lock and then finds nothing queued."""
    a = enqueue(db)
    b = enqueue(db, seed=1)
    assert a[0] != b[0]

    db.execute("BEGIN")
    second_db.execute("BEGIN")
    with db.cursor() as c1, second_db.cursor() as c2:
        c1.execute(sql("claim_job"), {"worker_id": "worker-1", "lease_seconds": 900})
        first = c1.fetchone()
        # Runs while worker-1's transaction still holds its row lock.
        c2.execute(sql("claim_job"), {"worker_id": "worker-2", "lease_seconds": 900})
        second = c2.fetchone()
    db.execute("COMMIT")
    second_db.execute("COMMIT")

    assert first is not None and second is not None, "both workers must get a job"
    assert first[0] != second[0], "two workers must never claim the same job"


def test_claiming_an_empty_queue_returns_nothing(db):
    assert claim(db) is None


def test_a_claim_increments_attempts_and_sets_the_whole_lease(db):
    enqueue(db)
    row = claim(db, worker_id="worker-7")
    assert row[10] == 1, "attempts increments on claim, since a worker that dies silently still spent one"
    with db.cursor() as cur:
        cur.execute("SELECT claimed_by, claimed_at, lease_expires_at FROM jobs WHERE id = %s", (row[0],))
        claimed_by, claimed_at, lease = cur.fetchone()
    assert claimed_by == "worker-7"
    assert claimed_at is not None and lease is not None


def test_claims_are_fifo(db):
    first = enqueue(db)
    second = enqueue(db, seed=1)
    db.execute("UPDATE jobs SET created_at = now() - interval '1 hour' WHERE id = %s", (first[0],))
    assert claim(db)[0] == first[0]


def test_heartbeat_extends_only_the_owners_lease(db):
    enqueue(db)
    job = claim(db, worker_id="worker-1", lease_seconds=60)
    with db.cursor() as cur:
        cur.execute(sql("heartbeat"), {"job_id": job[0], "worker_id": "worker-2", "lease_seconds": 900})
        assert cur.fetchone() is None, "a non-owner must not be able to extend a lease"
        cur.execute(sql("heartbeat"), {"job_id": job[0], "worker_id": "worker-1", "lease_seconds": 900})
        assert cur.fetchone() is not None


def test_an_expired_lease_under_the_cap_returns_the_job_to_the_queue(db):
    enqueue(db)
    job = claim(db)
    db.execute("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = %s", (job[0],))
    with db.cursor() as cur:
        cur.execute(sql("reclaim_expired"), {"max_attempts": 3})
        assert cur.fetchall() == [(job[0], "queued", 1)]
    assert status_of(db, job[0])[3] is None, "the claim columns must be cleared on reclaim"


def test_an_expired_lease_at_the_cap_is_dead_lettered(db):
    enqueue(db)
    job = claim(db)
    db.execute(
        "UPDATE jobs SET attempts = 3, lease_expires_at = now() - interval '1 second' WHERE id = %s",
        (job[0],),
    )
    with db.cursor() as cur:
        cur.execute(sql("reclaim_expired"), {"max_attempts": 3})
        assert cur.fetchone()[1] == "failed"
    status, attempts, error_kind, _ = status_of(db, job[0])
    assert (status, error_kind) == ("failed", "engine_internal_error")


def test_a_live_lease_is_not_reclaimed(db):
    enqueue(db)
    claim(db, lease_seconds=900)
    with db.cursor() as cur:
        cur.execute(sql("reclaim_expired"), {"max_attempts": 3})
        assert cur.fetchall() == []


def test_completing_a_job_requires_owning_it(db):
    db.execute(
        "INSERT INTO replays (id, format, log, payload_bytes) VALUES (%s, 'gen9ou', '|turn|1', 8)",
        (IDENTITY["replay_id"],),
    )
    with db.cursor() as cur:
        cur.execute(
            """INSERT INTO analyses (replay_id, perspective, search_budget_ms_per_turn,
                   opponent_samples, threads, usage_stats_cutoff, poke_engine_tag, seed,
                   document, total_turns, gradable_turns, wall_ms)
               VALUES (%s,'p2',1000,8,4,1500,'v0.0.48',0,'{}'::jsonb,93,79,93000) RETURNING id""",
            (IDENTITY["replay_id"],),
        )
        analysis_id = cur.fetchone()[0]

    enqueue(db)
    job = claim(db, worker_id="worker-1")
    with db.cursor() as cur:
        cur.execute(sql("complete_job"), {"job_id": job[0], "worker_id": "worker-2", "analysis_id": analysis_id})
        assert cur.fetchone() is None, "a stale worker's late result must not land"
        cur.execute(sql("complete_job"), {"job_id": job[0], "worker_id": "worker-1", "analysis_id": analysis_id})
        assert cur.fetchone()[1] == "succeeded"


@pytest.mark.parametrize(
    "retryable, attempts, expected",
    [(True, 0, "queued"), (True, 5, "failed"), (False, 0, "failed")],
)
def test_a_reported_failure_retries_only_when_the_caller_says_it_should(db, retryable, attempts, expected):
    enqueue(db)
    job = claim(db)
    if attempts:
        db.execute("UPDATE jobs SET attempts = %s WHERE id = %s", (attempts, job[0]))
    with db.cursor() as cur:
        cur.execute(
            sql("fail_job"),
            {
                "job_id": job[0],
                "worker_id": "worker-1",
                "retryable": retryable,
                "max_attempts": 3,
                "error_kind": "analysis_rejected",
                "error_detail": "malformed replay log",
            },
        )
        assert cur.fetchone()[1] == expected
