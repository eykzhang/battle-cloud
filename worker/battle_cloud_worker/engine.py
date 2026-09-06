"""The adapter between a job and `battle_engine.replay_analysis.analyze_replay`."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .contract import AnalysisIdentity
from .errors import EngineFailure, ErrorKind
from .profiles import PROFILES
from .telemetry import RunTelemetry, summarize

#: Where `battle_engine.usage_stats.DEFAULT_STATS_DIR` looks, relative to CWD.
STATS_SUBPATH = Path("data") / "usage_stats"


@dataclass(frozen=True)
class AnalysisRun:
    document: Dict[str, Any]
    telemetry: RunTelemetry


def _load_analyze_replay() -> Callable[..., Dict[str, Any]]:
    """Import the engine at call time, never at module import.

    Two reasons. The compiled gen9 `poke_engine` extension only exists inside the worker
    image, so a module-level import would make this package untestable anywhere else. And
    an import failure is a classifiable job outcome rather than a crash on startup.
    """
    try:
        from battle_engine.replay_analysis import analyze_replay
    except Exception as exc:  # noqa: BLE001 - a missing native extension raises broadly
        raise EngineFailure(
            ErrorKind.ENGINE_UNAVAILABLE,
            f"battle_engine is not importable in this process: {exc}",
        ) from exc
    return analyze_replay


class EngineAdapter:
    """Runs one analysis at a time, in this process.

    One search in flight per process is a requirement rather than a default.
    `poke_engine.monte_carlo_tree_search` holds Python's GIL for its entire call - checked
    against the pinned Rust source, where `allow_threads` appears nowhere - so two
    concurrent searches in one process serialize completely (measured: two 600 ms searches
    took 1306 ms, 2.00x). Parallelism inside one analysis comes from `threads`, which are
    native Rust threads doing no Python work. Concurrency across analyses comes from
    running more processes.
    """

    def __init__(self, data_dir: Path, analyze: Optional[Callable[..., Dict[str, Any]]] = None) -> None:
        self._data_dir = Path(data_dir).resolve()
        self._analyze = analyze
        # Set once, here, and asserted before every call rather than set per call.
        #
        # `default_usage_stats` is `@lru_cache`d on `(format_id, cutoff, stats_dir)`, and
        # `stats_dir` defaults to the RELATIVE `Path("data/usage_stats")`. So the cache key
        # is identical across two different working directories, and a process that
        # chdir'd between analyses would be handed stats parsed under the previous
        # directory with no error and no warning. Chdir-per-call does not fix that; it
        # causes it. Pinning the directory for the process lifetime does.
        os.chdir(self._data_dir)

    @property
    def data_dir(self) -> Path:
        return self._data_dir

    def _assert_cwd(self) -> None:
        current = Path.cwd().resolve()
        if current != self._data_dir:
            raise EngineFailure(
                ErrorKind.ENGINE_INTERNAL_ERROR,
                f"working directory moved from {self._data_dir} to {current}; the engine's "
                f"usage-stats cache is keyed on a relative path and would return stale stats",
            )

    def analyze(self, payload: Dict[str, Any], identity: AnalysisIdentity) -> AnalysisRun:
        """Analyze `payload` under `identity`, or raise `EngineFailure`."""
        self._assert_cwd()
        analyze_replay = self._analyze if self._analyze is not None else _load_analyze_replay()

        # All seven keyword-only parameters `analyze_replay` declares. `replay_id` is a
        # fallback the engine uses only when the payload itself carries no "id"; omitting
        # it would let a payload with no id analyze as "unknown".
        kwargs = {
            "perspective": identity.perspective,
            "replay_id": identity.replay_id,
            "search_time_ms": identity.search_budget_ms_per_turn,
            "n_opponent_samples": identity.opponent_samples,
            "threads": identity.threads,
            "usage_stats_cutoff": identity.usage_stats_cutoff,
            "seed": identity.seed,
        }

        started = time.monotonic()
        try:
            document = analyze_replay(payload, **kwargs)
        except FileNotFoundError as exc:
            # The engine raises this with its own remediation command when no cached
            # usage-stats file matches the requested cutoff. Passed through verbatim
            # rather than reworded, so the fix is one copy-paste away.
            raise EngineFailure(ErrorKind.ENGINE_DATA_MISSING, str(exc)) from exc
        except BaseException as exc:  # noqa: BLE001 - see the per-branch reasoning below
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            raise _classify(exc) from exc
        wall_ms = int((time.monotonic() - started) * 1000)

        if not isinstance(document, dict):
            raise EngineFailure(
                ErrorKind.ENGINE_INTERNAL_ERROR,
                f"analyze_replay returned {type(document).__name__}, expected dict",
            )

        return AnalysisRun(
            document=document,
            telemetry=summarize(
                document, wall_ms, identity.search_budget_ms_per_turn, identity.opponent_samples
            ),
        )


def _classify(exc: BaseException) -> EngineFailure:
    """Map an engine exception onto the shared vocabulary.

    Order matters. `ReplayAnalysisError` subclasses `ValueError`, so a handler that tested
    `ValueError` first would swallow it into the generic bucket. `ReplayParseError` lives
    in `battle_engine.replay_log`, not in `replay_analysis`, which is why both are looked
    up by name here rather than imported at module scope: neither is importable when the
    engine is absent, and this function has to work in that case too.
    """
    name = type(exc).__name__
    if name == "ReplayAnalysisError":
        return EngineFailure(ErrorKind.ANALYSIS_REJECTED, str(exc))
    if name == "ReplayParseError":
        return EngineFailure(ErrorKind.ANALYSIS_PARSE_FAILED, str(exc))
    if not isinstance(exc, Exception):
        # A pyo3 panic escaping the Rust extension surfaces as a bare BaseException.
        # analyze_replay already catches these per sample, so one reaching here means it
        # escaped a path that has no such guard.
        return EngineFailure(ErrorKind.ENGINE_CRASHED, f"{name}: {exc}")
    return EngineFailure(ErrorKind.ENGINE_INTERNAL_ERROR, f"{name}: {exc}")


def params_for(profile: str) -> Dict[str, Any]:
    """The engine kwargs a profile expands to, for callers building an identity."""
    if profile not in PROFILES:
        raise EngineFailure(ErrorKind.UNKNOWN_PROFILE, f"unknown profile: {profile!r}")
    return PROFILES[profile].as_analyze_kwargs()
