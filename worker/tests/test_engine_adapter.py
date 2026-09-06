"""Worker-core tests. None of these need the compiled gen9 extension."""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from battle_cloud_worker.contract import AnalysisIdentity
from battle_cloud_worker.engine import EngineAdapter, _classify
from battle_cloud_worker.errors import EngineFailure, ErrorKind
from battle_cloud_worker.profiles import PROFILES
from battle_cloud_worker.telemetry import DEGRADATION_MARGIN, PER_SAMPLE_OVERHEAD_MS, summarize

LADDER = AnalysisIdentity(
    replay_id="gen9ou-2672899958",
    perspective="p2",
    search_budget_ms_per_turn=1000,
    opponent_samples=8,
    threads=4,
    usage_stats_cutoff=1500,
    usage_stats_dataset="2026-07",
    poke_engine_tag="v0.0.48",
    seed=0,
)

DOC = {"schemaVersion": 1, "turns": [{"turn": 1, "samplesUsed": 8, "winProbability": 0.5}]}


def adapter(tmp_path: Path, analyze):
    return EngineAdapter(tmp_path, analyze=analyze)


def test_module_imports_without_the_engine_installed():
    """DW-4.2. If this file imported at module scope, the whole package would be
    untestable outside the worker image."""
    import importlib

    for name in ("battle_engine", "poke_engine"):
        with pytest.raises(ImportError):
            importlib.import_module(name)
    import battle_cloud_worker.engine  # noqa: F401


def test_analyze_passes_all_seven_keyword_arguments(tmp_path):
    """DW-4.1. Seven, not six: `replay_id` is the engine's fallback when a payload
    carries no id of its own."""
    seen = {}

    def fake(payload, **kwargs):
        seen.update(kwargs)
        seen["payload"] = payload
        return DOC

    adapter(tmp_path, fake).analyze({"log": "|turn|1"}, LADDER)
    assert seen == {
        "payload": {"log": "|turn|1"},
        "perspective": "p2",
        "replay_id": "gen9ou-2672899958",
        "search_time_ms": 1000,
        "n_opponent_samples": 8,
        "threads": 4,
        "usage_stats_cutoff": 1500,
        "seed": 0,
    }


def test_every_profile_expands_to_the_declared_engine_kwargs():
    for name, params in PROFILES.items():
        kwargs = params.as_analyze_kwargs()
        assert set(kwargs) == {
            "search_time_ms",
            "n_opponent_samples",
            "threads",
            "usage_stats_cutoff",
            "seed",
        }, name
        assert kwargs["search_time_ms"] > 0
        assert kwargs["n_opponent_samples"] >= 1


def test_missing_usage_stats_surfaces_the_engines_remediation_command(tmp_path):
    """DW-4.3. The engine's FileNotFoundError already carries the fix; rewording it
    would throw the useful half away."""
    message = (
        "no cached usage stats for gen9ou-1500 in data/usage_stats. "
        "Run: .venv/bin/python scripts/fetch_usage_stats.py --format gen9ou --cutoff 1500"
    )

    def fake(payload, **kwargs):
        raise FileNotFoundError(message)

    with pytest.raises(EngineFailure) as caught:
        adapter(tmp_path, fake).analyze({}, LADDER)
    assert caught.value.kind is ErrorKind.ENGINE_DATA_MISSING
    assert "scripts/fetch_usage_stats.py" in caught.value.detail


@pytest.mark.parametrize(
    "exc, expected",
    [
        (type("ReplayAnalysisError", (ValueError,), {})("bad payload"), ErrorKind.ANALYSIS_REJECTED),
        (type("ReplayParseError", (Exception,), {})("no log"), ErrorKind.ANALYSIS_PARSE_FAILED),
        (RuntimeError("boom"), ErrorKind.ENGINE_INTERNAL_ERROR),
        (ValueError("plain"), ErrorKind.ENGINE_INTERNAL_ERROR),
    ],
)
def test_engine_exceptions_map_to_distinct_kinds(exc, expected):
    """DW-4.4. ReplayAnalysisError subclasses ValueError, so a handler testing
    ValueError first would silently misclassify it."""
    assert _classify(exc).kind is expected


def test_a_bare_base_exception_is_classified_as_a_crash():
    class Panic(BaseException):
        pass

    assert _classify(Panic("pyo3 panic")).kind is ErrorKind.ENGINE_CRASHED


def test_keyboard_interrupt_is_never_swallowed(tmp_path):
    def fake(payload, **kwargs):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        adapter(tmp_path, fake).analyze({}, LADDER)


def test_a_moved_working_directory_is_refused_rather_than_silently_wrong(tmp_path):
    """The usage-stats cache is @lru_cache'd on a RELATIVE stats_dir, so the same cache
    key means different files under two working directories. A moved CWD must fail
    loudly instead of returning stats parsed somewhere else."""
    other = tmp_path / "elsewhere"
    other.mkdir()
    a = adapter(tmp_path, lambda payload, **kwargs: DOC)
    os.chdir(other)
    with pytest.raises(EngineFailure) as caught:
        a.analyze({}, LADDER)
    assert caught.value.kind is ErrorKind.ENGINE_INTERNAL_ERROR
    assert "usage-stats cache" in caught.value.detail


def test_a_non_dict_return_is_rejected(tmp_path):
    with pytest.raises(EngineFailure) as caught:
        adapter(tmp_path, lambda payload, **kwargs: ["not", "a", "document"]).analyze({}, LADDER)
    assert caught.value.kind is ErrorKind.ENGINE_INTERNAL_ERROR


def test_telemetry_records_samples_and_null_win_probabilities():
    """DW-4.5. No real fixture has a null winProbability - 0 of 6 - so this case only
    exists synthetically."""
    doc = {
        "turns": [
            {"turn": 1, "samplesUsed": 8, "winProbability": 0.5},
            {"turn": 2, "samplesUsed": 8, "winProbability": None},
            {"turn": 3, "samplesUsed": 3, "winProbability": 0.4},
        ]
    }
    t = summarize(doc, wall_ms=3000, budget_ms_per_turn=1000, opponent_samples=8)
    assert t.total_turns == 3
    assert t.samples_used == {8: 2, 3: 1}
    assert t.null_win_probability_turns == 1
    assert t.measured_ms_per_turn == 1000
    assert t.degraded is False


def test_a_healthy_measured_run_is_not_flagged_as_degraded():
    """The regression this exists to prevent: a flat 1.5x-of-budget threshold put the
    line exactly on the engine's own baseline, so every successful run reported itself
    degraded. These are the real numbers measured in the container on 2026-09-06."""
    for budget, samples, ms_per_turn in ((200, 2, 318.3), (500, 4, 745.8), (1000, 8, 1482.0)):
        doc = {"turns": [{"turn": i, "samplesUsed": samples, "winProbability": 0.5} for i in range(24)]}
        t = summarize(doc, wall_ms=int(ms_per_turn * 24), budget_ms_per_turn=budget, opponent_samples=samples)
        assert t.degraded is False, f"healthy run at budget={budget} was flagged degraded"


def test_a_run_over_the_margin_is_flagged_as_degraded():
    doc = {"turns": [{"turn": i, "samplesUsed": 8, "winProbability": 0.5} for i in range(10)]}
    expected = 1000 + 8 * PER_SAMPLE_OVERHEAD_MS
    under = summarize(doc, wall_ms=int(10 * expected * DEGRADATION_MARGIN) - 10, budget_ms_per_turn=1000, opponent_samples=8)
    over = summarize(doc, wall_ms=int(10 * expected * DEGRADATION_MARGIN) + 1000, budget_ms_per_turn=1000, opponent_samples=8)
    assert under.degraded is False
    assert over.degraded is True


def test_expected_cost_scales_with_samples_not_with_the_budget_alone():
    doc = {"turns": [{"turn": 1, "samplesUsed": 2, "winProbability": 0.5}]}
    few = summarize(doc, wall_ms=1, budget_ms_per_turn=1000, opponent_samples=2)
    many = summarize(doc, wall_ms=1, budget_ms_per_turn=1000, opponent_samples=8)
    assert many.expected_ms_per_turn > few.expected_ms_per_turn


def test_telemetry_survives_a_document_with_no_turns():
    t = summarize({"turns": []}, wall_ms=10, budget_ms_per_turn=1000, opponent_samples=8)
    assert t.total_turns == 0
    assert t.measured_ms_per_turn == 0.0
    assert t.degraded is False
    assert summarize({}, wall_ms=10, budget_ms_per_turn=1000).total_turns == 0
