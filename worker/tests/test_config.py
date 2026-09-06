from __future__ import annotations

import pytest

from battle_cloud_worker.config import ConfigError, WorkerConfig

BASE = {"DATABASE_URL": "postgres://x/y"}


def test_defaults_are_accepted_on_a_machine_with_enough_cores():
    cfg = WorkerConfig.from_env(BASE, cpu_count=8)
    assert cfg.concurrency == 1
    assert cfg.threads == 4
    assert cfg.lease_seconds == 900
    assert cfg.max_attempts == 3


def test_a_missing_database_url_is_rejected():
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        WorkerConfig.from_env({}, cpu_count=8)


@pytest.mark.parametrize("value", ["0", "-1"])
def test_non_positive_concurrency_is_rejected(value):
    with pytest.raises(ConfigError, match="WORKER_CONCURRENCY"):
        WorkerConfig.from_env({**BASE, "WORKER_CONCURRENCY": value}, cpu_count=8)


def test_oversubscribing_the_host_is_rejected():
    """A time-budgeted search degrades in quality rather than in speed when it is starved
    of cores, and that degradation is invisible in the emitted document. Refusing the
    configuration is the only place it can be caught."""
    with pytest.raises(ConfigError, match="exceeds 4 available cores"):
        WorkerConfig.from_env({**BASE, "WORKER_CONCURRENCY": "2", "ENGINE_THREADS": "4"}, cpu_count=4)


def test_exactly_saturating_the_host_is_allowed():
    cfg = WorkerConfig.from_env({**BASE, "WORKER_CONCURRENCY": "2", "ENGINE_THREADS": "2"}, cpu_count=4)
    assert cfg.concurrency == 2


def test_a_non_integer_value_is_rejected_with_the_key_named():
    with pytest.raises(ConfigError, match="JOB_LEASE_SECONDS"):
        WorkerConfig.from_env({**BASE, "JOB_LEASE_SECONDS": "soon"}, cpu_count=8)
