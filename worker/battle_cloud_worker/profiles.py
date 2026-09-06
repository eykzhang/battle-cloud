"""Profiles, mirroring `api/src/contract/profiles.ts`.

The API's camelCase field names and `analyze_replay`'s snake_case keyword arguments meet
here and nowhere else, which is why the mapping is written out explicitly rather than
derived by transforming names.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping


@dataclass(frozen=True)
class EngineParams:
    """One profile's expansion.

    `search_budget_ms_per_turn` is the whole per-turn budget. The engine divides it across
    samples itself (`per_sample_ms = max(1, search_time_ms // n_opponent_samples)`), so it
    must be passed through as-is rather than pre-divided here.
    """

    search_budget_ms_per_turn: int
    opponent_samples: int
    threads: int
    usage_stats_cutoff: int
    seed: int

    def as_analyze_kwargs(self) -> Dict[str, Any]:
        """The exact keyword arguments `battle_engine.replay_analysis.analyze_replay`
        declares. Names are pinned to that signature; changing one silently passes an
        unexpected keyword and raises a `TypeError` at call time."""
        return {
            "search_time_ms": self.search_budget_ms_per_turn,
            "n_opponent_samples": self.opponent_samples,
            "threads": self.threads,
            "usage_stats_cutoff": self.usage_stats_cutoff,
            "seed": self.seed,
        }


PROFILES: Mapping[str, EngineParams] = {
    "ladder-parity": EngineParams(1000, 8, 4, 1500, 0),
    "quick": EngineParams(200, 2, 4, 1500, 0),
}
