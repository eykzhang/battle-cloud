"""What a run is worth recording.

The scoping doc's original plan was to record total MCTS visits per turn as the
degradation signal. That is not available: `analyze_replay` normalizes `aggregate()`'s
`(action, visits, score)` triples into `visitShare` before returning, and hands back only
the document, so a caller never sees a raw visit count.

What is observable is recorded here instead. It matters because the search is budgeted in
wall-clock milliseconds rather than node counts: an oversubscribed worker does not run
slower, it explores less and returns a worse analysis in the same time. That degradation
is invisible in the document, so if this tier does not measure it, nothing does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping

#: Per-turn cost that sits OUTSIDE the search budget, per opponent sample, in
#: milliseconds. Every sample pays for translating the poke-env battle into a
#: poke_engine state and for filling an opponent team from usage stats before its search
#: starts, and `search_time_ms` covers only the search.
#:
#: Measured 2026-09-06 inside battle-cloud-worker:dev on Colima (4 CPU, arm64), one
#: process, replay gen9ou-2672927429 at 24 turns:
#:
#:     budget  samples  ms/turn  excess  excess/sample
#:        200        2    318.3   118.3           59.2
#:        500        4    745.8   245.8           61.5
#:       1000        8   1482.0   482.0           60.3
#:
#: The excess tracks sample count, not turn count and not the budget: three points
#: within 3% of each other. An earlier version of this module modelled it as a flat 1.5x
#: multiplier on the budget, which happened to fit only because these profiles scale
#: samples with budget - and which put the threshold exactly on the healthy baseline, so
#: every successful run reported itself degraded.
#:
#: The absolute number is machine-specific. The shape (per sample, not per turn) is not.
PER_SAMPLE_OVERHEAD_MS = 60.0

#: How far past the expected cost a run may go before it is called degraded. Applied to
#: budget plus modelled overhead rather than to the budget alone.
DEGRADATION_MARGIN = 1.25


@dataclass(frozen=True)
class RunTelemetry:
    wall_ms: int
    total_turns: int
    budget_ms_per_turn: int
    opponent_samples: int = 1
    samples_used: Mapping[int, int] = field(default_factory=dict)
    null_win_probability_turns: int = 0

    @property
    def measured_ms_per_turn(self) -> float:
        if self.total_turns <= 0:
            return 0.0
        return self.wall_ms / self.total_turns

    @property
    def expected_ms_per_turn(self) -> float:
        """Budget plus the modelled per-sample overhead. What a healthy run costs."""
        return self.budget_ms_per_turn + self.opponent_samples * PER_SAMPLE_OVERHEAD_MS

    @property
    def degraded(self) -> bool:
        """True when this run cost materially more per turn than a healthy one does.

        The search is budgeted in wall-clock time, so a starved worker returns a weaker
        analysis rather than a slower one, and the document records only normalized visit
        shares. Wall time against the expected cost is the only place that shows up.
        """
        if self.total_turns <= 0 or self.budget_ms_per_turn <= 0:
            return False
        return self.measured_ms_per_turn > self.expected_ms_per_turn * DEGRADATION_MARGIN


def summarize(
    document: Dict[str, Any],
    wall_ms: int,
    budget_ms_per_turn: int,
    opponent_samples: int = 1,
) -> RunTelemetry:
    """Telemetry for a completed document.

    `turns` is read defensively rather than trusted: the document is the engine's output,
    but this function also runs against documents replayed from storage, and a malformed
    row should produce degraded telemetry instead of an exception in the queue loop.
    """
    turns: List[Any] = document.get("turns") or []
    samples_used: Dict[int, int] = {}
    nulls = 0
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        used = turn.get("samplesUsed")
        if isinstance(used, int):
            samples_used[used] = samples_used.get(used, 0) + 1
        if turn.get("winProbability") is None:
            nulls += 1
    return RunTelemetry(
        wall_ms=wall_ms,
        total_turns=len(turns),
        budget_ms_per_turn=budget_ms_per_turn,
        opponent_samples=opponent_samples,
        samples_used=samples_used,
        null_win_probability_turns=nulls,
    )
