"""The Python mirror of `docs/contract.md`, matching `api/src/contract/`.

This module exists because the worker cannot import TypeScript types. It is hand-written
rather than generated, and `tests/test_contract_agreement.py` asserts it agrees with the
document both tiers are written from.
"""

from __future__ import annotations

from dataclasses import dataclass

PERSPECTIVES = ("p1", "p2")


@dataclass(frozen=True)
class AnalysisIdentity:
    """The nine fields that identify an analysis.

    `profile` is deliberately absent: it is shorthand that expands into the parameters
    below, so two profiles that happened to expand identically should share one analysis
    rather than duplicate it.

    `usage_stats_dataset` is the month of the cached usage-stats file the worker loaded,
    taken from the file's own name. It is here for the same reason `poke_engine_tag` is:
    usage stats drive opponent-team sampling, so a different month is a different prior
    and a different analysis from identical parameters. `usage_stats_cutoff` does not
    stand in for it, because the cutoff selects a file within a month.

    `seed` is present even though schema v1 omits it. `EngineConfiguration` in
    battle-brain's `EngineService.swift` carries five fields and the seed is not one of
    them, so two analyses at different seeds are indistinguishable from the document
    alone.
    """

    replay_id: str
    perspective: str
    search_budget_ms_per_turn: int
    opponent_samples: int
    threads: int
    usage_stats_cutoff: int
    usage_stats_dataset: str
    poke_engine_tag: str
    seed: int
