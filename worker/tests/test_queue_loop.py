"""The claim-analyze-report loop, against real Postgres with a fake engine.

The engine is faked so these run in milliseconds and stay honest about what they test:
the queue transitions, not the search.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from battle_cloud_worker.config import WorkerConfig
from battle_cloud_worker.engine import AnalysisRun
from battle_cloud_worker.errors import EngineFailure, ErrorKind
from battle_cloud_worker.queue import Worker
from battle_cloud_worker.telemetry import summarize

DB_URL = (
    os.environ.get("TEST_DATABASE_URL")
    or os.environ.get("DATABASE_URL")
    or "postgres:///battlecloud"
)
REPLAY = "gen9ou-2672899958"
DOC = {"schemaVersion": 1, "totalTurns": 2, "gradableTurns": 1,
       "turns": [{"turn": 1, "samplesUsed": 8, "winProbability": 0.5},
                 {"turn": 2, "samplesUsed": 8, "winProbability": 0.6}]}


class FakeAdapter:
    """Stands in for EngineAdapter. `data_dir` exists because run_forever logs it."""

    def __init__(self, result=None, failure=None):
        self.data_dir = Path("/tmp")
        self._result = result
        self._failure = failure
        self.calls = []

    def analyze(self, payload, identity):
        self.calls.append((payload, identity))
        if self._failure is not None:
            raise self._failure
        return self._result or AnalysisRun(DOC, summarize(DOC, 1200, 1000, 8))


@pytest.fixture
def conn():
    with psycopg.connect(DB_URL, autocommit=True) as c:
        c.execute("TRUNCATE jobs, analyses, replays RESTART IDENTITY CASCADE")
        c.execute(
            "INSERT INTO replays (id, format, rating, players, log, payload_bytes) "
            "VALUES (%s,'gen9ou',1618,%s,'|turn|1\n|turn|2\n',24)",
            (REPLAY, json.dumps(["a", "b"])),
        )
        yield c


@pytest.fixture
def config():
    return WorkerConfig.from_env(
        {
            "DATABASE_URL": DB_URL,
            "WORKER_CONCURRENCY": "1",
            "ENGINE_THREADS": "4",
            "POKE_ENGINE_TAG": "v0.0.48",
            "USAGE_STATS_DATASET": "2026-07",
        },
        cpu_count=8,
    )


def enqueue(conn, **over):
    params = dict(replay_id=REPLAY, perspective="p2", profile="ladder-parity",
                  search_budget_ms_per_turn=1000, opponent_samples=8, threads=4,
                  usage_stats_cutoff=1500, usage_stats_dataset="2026-07",
                  poke_engine_tag="v0.0.48", seed=0,
                  estimated_turns=2, estimated_search_ms=2000)
    params.update(over)
    sql = (Path(__file__).resolve().parents[2] / "db" / "queries" / "enqueue_job.sql").read_text()
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()[0]


def job_row(conn, job_id):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT * FROM jobs WHERE id = %s", (job_id,))
        return cur.fetchone()


def test_an_empty_queue_reports_no_work(conn, config):
    assert Worker(config, FakeAdapter()).run_once(conn) is False


def test_a_job_runs_end_to_end_and_stores_its_analysis(conn, config):
    job_id = enqueue(conn)
    adapter = FakeAdapter()
    assert Worker(config, adapter).run_once(conn) is True

    row = job_row(conn, job_id)
    assert row["status"] == "succeeded"
    assert row["analysis_id"] is not None
    assert row["claimed_by"] is None, "claim columns must be cleared on completion"

    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT * FROM analyses WHERE id = %s", (row["analysis_id"],))
        analysis = cur.fetchone()
    assert analysis["document"] == DOC, "the document is stored byte-faithfully"
    assert (analysis["total_turns"], analysis["gradable_turns"]) == (2, 1)
    assert analysis["seed"] == 0


def test_the_payload_handed_to_the_engine_is_rebuilt_from_the_stored_replay(conn, config):
    enqueue(conn)
    adapter = FakeAdapter()
    Worker(config, adapter).run_once(conn)
    payload, identity = adapter.calls[0]
    assert payload["id"] == REPLAY
    assert payload["formatid"] == "gen9ou"
    assert payload["log"].startswith("|turn|1")
    assert identity.perspective == "p2"
    assert identity.opponent_samples == 8


def test_a_missing_replay_fails_the_job_without_calling_the_engine(conn, config):
    job_id = enqueue(conn, replay_id="gen9ou-nonexistent")
    adapter = FakeAdapter()
    Worker(config, adapter).run_once(conn)
    assert adapter.calls == []
    assert job_row(conn, job_id)["error_kind"] == "replay_not_found"


def test_a_non_retryable_engine_failure_is_terminal(conn, config):
    job_id = enqueue(conn)
    failure = EngineFailure(ErrorKind.ANALYSIS_REJECTED, "malformed replay log")
    Worker(config, FakeAdapter(failure=failure)).run_once(conn)
    row = job_row(conn, job_id)
    assert (row["status"], row["error_kind"]) == ("failed", "analysis_rejected")


def test_a_retryable_engine_failure_returns_the_job_to_the_queue(conn, config):
    """A missing data file is an environment problem another worker might not have. A
    malformed replay is not, which is why the two are classified differently."""
    job_id = enqueue(conn)
    failure = EngineFailure(ErrorKind.ENGINE_DATA_MISSING, "no cached usage stats")
    Worker(config, FakeAdapter(failure=failure)).run_once(conn)
    row = job_row(conn, job_id)
    assert row["status"] == "queued"
    assert row["attempts"] == 1


def test_a_degraded_run_is_recorded_on_the_analysis(conn, config):
    enqueue(conn)
    slow = AnalysisRun(DOC, summarize(DOC, 60_000, 1000, 8))
    assert slow.telemetry.degraded is True
    Worker(config, FakeAdapter(result=slow)).run_once(conn)
    with conn.cursor() as cur:
        cur.execute("SELECT degraded, wall_ms FROM analyses")
        assert cur.fetchone() == (True, 60_000)


def test_a_worker_leaves_a_job_built_for_another_engine_tag(conn, config):
    """The identity asserts which engine produced the analysis. A worker on a different
    tag cannot honor that, so it must leave the job rather than analyze it and store the
    result under an identity it did not produce."""
    job_id = enqueue(conn, poke_engine_tag="v0.0.49")
    adapter = FakeAdapter()
    assert Worker(config, adapter).run_once(conn) is False
    assert adapter.calls == []
    assert job_row(conn, job_id)["status"] == "queued"
    assert job_row(conn, job_id)["attempts"] == 0, "an unclaimed job must not burn an attempt"


def test_a_worker_leaves_a_job_built_for_another_usage_stats_dataset(conn, config):
    """Same rule for the stats month. This is the one a rolling deploy actually hits,
    since bumping the stats file changes the prior without changing any parameter."""
    job_id = enqueue(conn, usage_stats_dataset="2026-08")
    adapter = FakeAdapter()
    assert Worker(config, adapter).run_once(conn) is False
    assert adapter.calls == []
    assert job_row(conn, job_id)["status"] == "queued"


def test_the_stored_analysis_carries_the_dataset_it_was_produced_under(conn, config):
    job_id = enqueue(conn)
    Worker(config, FakeAdapter()).run_once(conn)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT usage_stats_dataset FROM analyses")
        assert cur.fetchone()["usage_stats_dataset"] == "2026-07"


def test_two_analyses_of_one_replay_under_different_datasets_coexist(conn, config):
    """Two rows, not a conflict. Before the dataset was part of the identity these two
    collided, and the second silently overwrote the first."""
    enqueue(conn)
    Worker(config, FakeAdapter()).run_once(conn)
    august = WorkerConfig.from_env(
        {
            "DATABASE_URL": DB_URL,
            "POKE_ENGINE_TAG": "v0.0.48",
            "USAGE_STATS_DATASET": "2026-08",
            "ENGINE_THREADS": "4",
        },
        cpu_count=8,
    )
    enqueue(conn, usage_stats_dataset="2026-08")
    Worker(august, FakeAdapter()).run_once(conn)
    with conn.cursor() as cur:
        cur.execute("SELECT usage_stats_dataset FROM analyses ORDER BY usage_stats_dataset")
        assert [row[0] for row in cur.fetchall()] == ["2026-07", "2026-08"]


def test_two_workers_do_not_process_the_same_job(conn, config):
    enqueue(conn)
    enqueue(conn, seed=1)
    a, b = FakeAdapter(), FakeAdapter()
    assert Worker(config, a).run_once(conn) is True
    assert Worker(config, b).run_once(conn) is True
    assert Worker(config, FakeAdapter()).run_once(conn) is False
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM analyses")
        assert cur.fetchone()[0] == 2


def test_draining_an_empty_queue_processes_nothing_and_returns(conn, config):
    adapter = FakeAdapter()
    assert Worker(config, adapter).run_until_empty(conn) == 0
    assert adapter.calls == []


def test_draining_processes_every_queued_job_then_stops(conn, config):
    for seed in (0, 1, 2):
        enqueue(conn, seed=seed)
    adapter = FakeAdapter()
    assert Worker(config, adapter).run_until_empty(conn) == 3
    assert len(adapter.calls) == 3
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM jobs WHERE status = 'succeeded'")
        assert cur.fetchone()[0] == 3


def test_draining_ignores_work_this_build_cannot_serve(conn, config):
    """The exit condition is "nothing claimable by me", not "the queue is empty". A job
    for another engine build would otherwise hold the task open forever."""
    enqueue(conn, usage_stats_dataset="2026-08")
    assert Worker(config, FakeAdapter()).run_until_empty(conn) == 0
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM jobs")
        assert cur.fetchone()[0] == "queued"


def test_draining_recovers_a_job_whose_worker_died(conn, config):
    """A task that dies mid-analysis leaves a running job with a lease nobody renews. In
    drain mode there may be no long-lived worker to notice, so the next task reclaims
    before it decides the queue is empty."""
    job_id = enqueue(conn)
    Worker(config, FakeAdapter(failure=EngineFailure(ErrorKind.ENGINE_DATA_MISSING, "gone"))).run_once(conn)
    conn.execute(
        "UPDATE jobs SET status = 'running', claimed_by = 'dead', claimed_at = now(), "
        "lease_expires_at = now() - interval '1 second' WHERE id = %s",
        (job_id,),
    )
    assert Worker(config, FakeAdapter()).run_until_empty(conn) == 1
    assert job_row(conn, job_id)["status"] == "succeeded"
