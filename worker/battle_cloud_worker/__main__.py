"""Entry point. `python -m battle_cloud_worker`."""

from __future__ import annotations

import logging
import sys

from .config import ConfigError, WorkerConfig
from .engine import installed_datasets
from .queue import Worker


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    try:
        config = WorkerConfig.from_env()
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    # Checked here rather than trusted, because the two can disagree silently. The engine
    # picks its stats file by format and cutoff, so a worker carrying a different month
    # than USAGE_STATS_DATASET names would analyze happily and store the result under an
    # identity asserting a prior it never used.
    present = installed_datasets(config.engine_data_dir)
    if config.usage_stats_dataset not in present:
        print(
            f"configuration error: USAGE_STATS_DATASET={config.usage_stats_dataset!r} but "
            f"{config.engine_data_dir}/data/usage_stats carries "
            f"{sorted(present) if present else 'no usage-stats files'}",
            file=sys.stderr,
        )
        return 2

    worker = Worker(config)
    if config.mode == "drain":
        worker.run_until_empty()
    else:
        worker.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
