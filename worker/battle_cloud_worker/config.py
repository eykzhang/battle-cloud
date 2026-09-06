"""Worker configuration, from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional


class ConfigError(ValueError):
    """A configuration value that would produce a broken worker, rejected at startup
    rather than at the first job."""


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc


@dataclass(frozen=True)
class WorkerConfig:
    """`engine_data_dir` is the directory that must contain `data/usage_stats/`.

    It exists because `battle_engine.usage_stats.DEFAULT_STATS_DIR` is
    `Path("data/usage_stats")`, relative to the process working directory, and
    `analyze_replay` exposes no `stats_dir` override. A caller therefore cannot inject the
    path through the public API and has to control the working directory instead.
    """

    database_url: str
    engine_data_dir: Path
    concurrency: int
    threads: int
    lease_seconds: int
    max_attempts: int

    @staticmethod
    def from_env(env: Optional[Mapping[str, str]] = None, cpu_count: Optional[int] = None) -> "WorkerConfig":
        env = os.environ if env is None else env
        cores = cpu_count if cpu_count is not None else (os.cpu_count() or 1)

        database_url = env.get("DATABASE_URL", "")
        if not database_url:
            raise ConfigError("DATABASE_URL is required")

        concurrency = _int(env, "WORKER_CONCURRENCY", 1)
        if concurrency < 1:
            raise ConfigError(f"WORKER_CONCURRENCY must be at least 1, got {concurrency}")

        threads = _int(env, "ENGINE_THREADS", 4)
        if threads < 1:
            raise ConfigError(f"ENGINE_THREADS must be at least 1, got {threads}")
        # One search in flight per process, with `threads` native Rust threads inside it.
        # Asking for more total threads than the host has cores does not make the search
        # faster; it makes every concurrent search shallower within the same wall-clock
        # budget, which shows up as a worse analysis rather than a slower one.
        if concurrency * threads > cores:
            raise ConfigError(
                f"WORKER_CONCURRENCY ({concurrency}) x ENGINE_THREADS ({threads}) = "
                f"{concurrency * threads} exceeds {cores} available cores; a time-budgeted "
                f"search degrades in quality rather than in speed when oversubscribed"
            )

        lease_seconds = _int(env, "JOB_LEASE_SECONDS", 900)
        if lease_seconds < 1:
            raise ConfigError(f"JOB_LEASE_SECONDS must be at least 1, got {lease_seconds}")

        max_attempts = _int(env, "JOB_MAX_ATTEMPTS", 3)
        if max_attempts < 1:
            raise ConfigError(f"JOB_MAX_ATTEMPTS must be at least 1, got {max_attempts}")

        return WorkerConfig(
            database_url=database_url,
            engine_data_dir=Path(env.get("ENGINE_DATA_DIR", ".")),
            concurrency=concurrency,
            threads=threads,
            lease_seconds=lease_seconds,
            max_attempts=max_attempts,
        )
