from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

# TEST_DATABASE_URL first so a scratch database can be used without touching
# DATABASE_URL, then DATABASE_URL, then a local default. CI sets only the second.
DB_URL = (
    os.environ.get("TEST_DATABASE_URL")
    or os.environ.get("DATABASE_URL")
    or "postgres:///battlecloud"
)
QUERIES = Path(__file__).resolve().parents[1] / "queries"


def sql(name: str) -> str:
    return (QUERIES / f"{name}.sql").read_text()


@pytest.fixture
def db():
    """A clean database per test.

    TRUNCATE rather than a wrapping transaction: the SKIP LOCKED tests need two real
    concurrent connections, and two connections cannot share one uncommitted
    transaction's rows.
    """
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute("TRUNCATE jobs, analyses, replays RESTART IDENTITY CASCADE")
        yield conn


@pytest.fixture
def second_db():
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        yield conn


IDENTITY = {
    "replay_id": "gen9ou-2672899958",
    "perspective": "p2",
    "profile": "ladder-parity",
    "search_budget_ms_per_turn": 1000,
    "opponent_samples": 8,
    "threads": 4,
    "usage_stats_cutoff": 1500,
    "poke_engine_tag": "v0.0.48",
    "seed": 0,
    "estimated_turns": 93,
    "estimated_search_ms": 93000,
}


def enqueue(conn, **overrides):
    params = {**IDENTITY, **overrides}
    with conn.cursor() as cur:
        cur.execute(sql("enqueue_job"), params)
        return cur.fetchone()


def claim(conn, worker_id="worker-1", lease_seconds=900):
    with conn.cursor() as cur:
        cur.execute(sql("claim_job"), {"worker_id": worker_id, "lease_seconds": lease_seconds})
        return cur.fetchone()


def status_of(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT status, attempts, error_kind, claimed_by FROM jobs WHERE id = %s", (job_id,))
        return cur.fetchone()
