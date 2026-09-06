"""Entry point. `python -m battle_cloud_worker`."""

from __future__ import annotations

import logging
import sys

from .config import ConfigError, WorkerConfig
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
    Worker(config).run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
