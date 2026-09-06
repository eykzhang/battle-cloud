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

#: How far measured per-turn wall time may exceed the requested budget before a run is
#: called degraded. Search time is the dominant term but not the only one - parsing,
#: state translation, and opponent sampling all sit outside the budget - so a modest
#: overshoot is normal and only a large one indicates contention.
DEGRADATION_MARGIN = 1.5


@dataclass(frozen=True)
class RunTelemetry:
    wall_ms: int
    total_turns: int
    budget_ms_per_turn: int
    samples_used: Mapping[int, int] = field(default_factory=dict)
    null_win_probability_turns: int = 0

    @property
    def measured_ms_per_turn(self) -> float:
        if self.total_turns <= 0:
            return 0.0
        return self.wall_ms / self.total_turns

    @property
    def degraded(self) -> bool:
        """True when this run took materially longer per turn than it asked for, which
        is the signal that the host was oversubscribed and the analysis is weaker than
        its configuration claims."""
        if self.total_turns <= 0 or self.budget_ms_per_turn <= 0:
            return False
        return self.measured_ms_per_turn > self.budget_ms_per_turn * DEGRADATION_MARGIN


def summarize(document: Dict[str, Any], wall_ms: int, budget_ms_per_turn: int) -> RunTelemetry:
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
        samples_used=samples_used,
        null_win_probability_turns=nulls,
    )
