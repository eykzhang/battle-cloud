"""Constraints that stop a wrong row from ever existing."""

from __future__ import annotations

import psycopg
import pytest

REPLAY = "gen9ou-2672899958"

ANALYSIS = """
INSERT INTO analyses (replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
    threads, usage_stats_cutoff, poke_engine_tag, seed, document, total_turns,
    gradable_turns, wall_ms)
VALUES (%(replay_id)s, %(perspective)s, %(budget)s, %(samples)s, %(threads)s,
        %(cutoff)s, %(tag)s, %(seed)s, '{}'::jsonb, 93, 79, 93000)
"""

BASE = dict(replay_id=REPLAY, perspective="p2", budget=1000, samples=8, threads=4,
            cutoff=1500, tag="v0.0.48", seed=0)


@pytest.fixture
def seeded(db):
    db.execute("INSERT INTO replays (id, format, log, payload_bytes) VALUES (%s,'gen9ou','|turn|1',8)", (REPLAY,))
    return db


def test_the_identity_constraint_rejects_an_exact_duplicate(seeded):
    seeded.execute(ANALYSIS, BASE)
    with pytest.raises(psycopg.errors.UniqueViolation):
        seeded.execute(ANALYSIS, BASE)


@pytest.mark.parametrize("field, value", [
    ("seed", 1), ("perspective", "p1"), ("budget", 200), ("samples", 2),
    ("threads", 2), ("cutoff", 1825), ("tag", "v0.0.49"),
])
def test_every_identity_field_separates_two_analyses(seeded, field, value):
    """Seed included. Without it in the constraint, two analyses at different seeds
    would collide here and one would be lost."""
    seeded.execute(ANALYSIS, BASE)
    seeded.execute(ANALYSIS, {**BASE, field: value})
    with seeded.cursor() as cur:
        cur.execute("SELECT count(*) FROM analyses")
        assert cur.fetchone()[0] == 2


def test_a_job_cannot_be_half_claimed(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            """INSERT INTO jobs (replay_id, perspective, profile, search_budget_ms_per_turn,
                   opponent_samples, threads, usage_stats_cutoff, poke_engine_tag, seed, claimed_by)
               VALUES (%s,'p2','ladder-parity',1000,8,4,1500,'v0.0.48',0,'worker-1')""",
            (REPLAY,),
        )


def test_a_succeeded_job_must_carry_an_analysis(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            """INSERT INTO jobs (replay_id, perspective, profile, search_budget_ms_per_turn,
                   opponent_samples, threads, usage_stats_cutoff, poke_engine_tag, seed, status)
               VALUES (%s,'p2','ladder-parity',1000,8,4,1500,'v0.0.48',0,'succeeded')""",
            (REPLAY,),
        )


def test_a_failed_job_must_carry_an_error_kind(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(
            """INSERT INTO jobs (replay_id, perspective, profile, search_budget_ms_per_turn,
                   opponent_samples, threads, usage_stats_cutoff, poke_engine_tag, seed, status)
               VALUES (%s,'p2','ladder-parity',1000,8,4,1500,'v0.0.48',0,'failed')""",
            (REPLAY,),
        )


def test_an_analysis_requires_a_stored_replay(db):
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        db.execute(ANALYSIS, BASE)


def test_every_migration_has_a_reverse():
    from pathlib import Path
    migrations = Path(__file__).resolve().parents[1] / "migrations"
    ups = sorted(migrations.glob("*.up.sql"))
    assert ups, "expected at least one migration"
    for up in ups:
        assert up.with_name(up.name.replace(".up.sql", ".down.sql")).exists(), up.name


def test_no_query_file_interpolates_a_value():
    """replayId and perspective arrive from untrusted submissions. Every parameter must
    be a placeholder the driver binds, never a formatted string."""
    from pathlib import Path
    import re
    for path in (Path(__file__).resolve().parents[1] / "queries").glob("*.sql"):
        body = "\n".join(l for l in path.read_text().splitlines() if not l.strip().startswith("--"))
        assert "%(" in body, f"{path.name} has no bound parameters at all"
        assert not re.search(r"\{[a-z_]+\}|\+\s*['\"]|f['\"]", body), f"{path.name} looks interpolated"
