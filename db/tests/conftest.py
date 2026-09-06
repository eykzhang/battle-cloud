from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

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
    "usage_stats_dataset": "2026-07",
    "poke_engine_tag": "v0.0.48",
    "seed": 0,
    "estimated_turns": 93,
    "estimated_search_ms": 93000,
}


#: The engine build a claiming worker declares. A worker claims only jobs whose identity
#: names its own build, so these are part of every claim.
CLAIM_BUILD = {
    "poke_engine_tag": IDENTITY["poke_engine_tag"],
    "usage_stats_dataset": IDENTITY["usage_stats_dataset"],
}


def enqueue(conn, **overrides):
    params = {**IDENTITY, **overrides}
    with conn.cursor() as cur:
        cur.execute(sql("enqueue_job"), params)
        return cur.fetchone()


def claim(conn, worker_id="worker-1", lease_seconds=900, **build):
    """`build` overrides the claiming worker's engine build. A worker claims only jobs
    whose identity names its own build, so these two values are part of the claim."""
    params = {"worker_id": worker_id, "lease_seconds": lease_seconds, **CLAIM_BUILD, **build}
    # dict rows rather than tuples: the claim's RETURNING list is the identity plus
    # bookkeeping, so adding an identity field shifts every positional index in every
    # test that reads one.
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql("claim_job"), params)
        return cur.fetchone()


def status_of(conn, job_id):
    with conn.cursor() as cur:
        cur.execute("SELECT status, attempts, error_kind, claimed_by FROM jobs WHERE id = %s", (job_id,))
        return cur.fetchone()
