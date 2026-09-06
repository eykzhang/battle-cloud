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
    """The eight fields that identify an analysis.

    `profile` is deliberately absent: it is shorthand that expands into the parameters
    below, so two profiles that happened to expand identically should share one analysis
    rather than duplicate it.

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
    poke_engine_tag: str
    seed: int
