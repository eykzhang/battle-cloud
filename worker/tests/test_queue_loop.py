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
        {"DATABASE_URL": DB_URL, "WORKER_CONCURRENCY": "1", "ENGINE_THREADS": "4"}, cpu_count=8
    )


def enqueue(conn, **over):
    params = dict(replay_id=REPLAY, perspective="p2", profile="ladder-parity",
                  search_budget_ms_per_turn=1000, opponent_samples=8, threads=4,
                  usage_stats_cutoff=1500, poke_engine_tag="v0.0.48", seed=0,
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
