"""The claim-analyze-report loop.

One job at a time, in this process, for the reason in
notes/decision-process-isolation-one-search-per-worker.md: the engine's search holds the
GIL for its whole call, so a second concurrent analysis in this process would serialize
behind the first rather than overlap with it.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import psycopg
from psycopg.rows import dict_row

from .config import WorkerConfig
from .contract import AnalysisIdentity
from .engine import AnalysisRun, EngineAdapter
from .errors import EngineFailure, ErrorKind

log = logging.getLogger("battle_cloud_worker")

#: Where the .sql files live. The repo layout works for a developer checkout, but the
#: worker is pip-installed into site-packages inside the image, where `parents[2]` is not
#: the repo root. QUERIES_DIR is what the image sets; the repo path is the fallback.
QUERIES = Path(os.environ.get("QUERIES_DIR") or (Path(__file__).resolve().parents[2] / "db" / "queries"))

#: Failures worth another worker's time. A malformed replay fails identically everywhere,
#: so retrying it burns a core-minute to reach the same answer. A missing data file or an
#: unimportable engine is an environment problem that a differently-configured worker
#: might not have.
RETRYABLE = frozenset({ErrorKind.ENGINE_DATA_MISSING, ErrorKind.ENGINE_UNAVAILABLE})

#: Fraction of the lease at which a heartbeat renews it. Well under 1 so a slow renewal
#: still lands before the reclaimer would take the job away.
HEARTBEAT_FRACTION = 0.3


def _sql(name: str) -> str:
    return (QUERIES / f"{name}.sql").read_text()


class Heartbeat:
    """Renews a job's lease on a background thread while an analysis runs.

    A thread is appropriate here despite the GIL: it sleeps almost all the time and its
    work is a database round trip, which releases the GIL. It is not doing search.
    """

    def __init__(self, conn_str: str, job_id: uuid.UUID, worker_id: str, lease_seconds: int) -> None:
        self._conn_str = conn_str
        self._job_id = job_id
        self._worker_id = worker_id
        self._lease_seconds = lease_seconds
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.lost = threading.Event()

    def __enter__(self) -> "Heartbeat":
        self._thread = threading.Thread(target=self._run, daemon=True, name="heartbeat")
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        interval = max(1.0, self._lease_seconds * HEARTBEAT_FRACTION)
        # Its own connection: the main thread's connection is busy, and psycopg
        # connections are not safe to share across threads.
        with psycopg.connect(self._conn_str, autocommit=True) as conn:
            while not self._stop.wait(interval):
                with conn.cursor() as cur:
                    cur.execute(
                        _sql("heartbeat"),
                        {"job_id": self._job_id, "worker_id": self._worker_id, "lease_seconds": self._lease_seconds},
                    )
                    if cur.fetchone() is None:
                        # The lease expired and the job was reclaimed. Whatever this
                        # process produces is stale and will be refused by complete_job.
                        log.warning("lost lease on job %s", self._job_id)
                        self.lost.set()
                        return


class Worker:
    def __init__(self, config: WorkerConfig, adapter: Optional[EngineAdapter] = None) -> None:
        self.config = config
        self.worker_id = f"{socket.gethostname()}/{os.getpid()}"
        self.adapter = adapter if adapter is not None else EngineAdapter(config.engine_data_dir)

    def run_once(self, conn: psycopg.Connection) -> bool:
        """Claim and process one job. False when the queue was empty."""
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                _sql("claim_job"),
                {
                    "worker_id": self.worker_id,
                    "lease_seconds": self.config.lease_seconds,
                    # Not a filter for efficiency. A job's identity asserts which engine
                    # build produced its analysis, so a worker on a different build must
                    # leave it for one that can honor that.
                    "poke_engine_tag": self.config.poke_engine_tag,
                    "usage_stats_dataset": self.config.usage_stats_dataset,
                },
            )
            job = cur.fetchone()
        if job is None:
            return False

        log.info("claimed job %s (%s %s, attempt %s)", job["id"], job["replay_id"], job["perspective"], job["attempts"])
        try:
            payload = self._load_replay(conn, job["replay_id"])
            identity = AnalysisIdentity(
                replay_id=job["replay_id"],
                perspective=job["perspective"],
                search_budget_ms_per_turn=job["search_budget_ms_per_turn"],
                opponent_samples=job["opponent_samples"],
                threads=job["threads"],
                usage_stats_cutoff=job["usage_stats_cutoff"],
                usage_stats_dataset=job["usage_stats_dataset"],
                poke_engine_tag=job["poke_engine_tag"],
                seed=job["seed"],
            )
            with Heartbeat(self.config.database_url, job["id"], self.worker_id, self.config.lease_seconds) as hb:
                run = self.adapter.analyze(payload, identity)
                if hb.lost.is_set():
                    log.warning("discarding result for %s: lease was lost mid-analysis", job["id"])
                    return True
        except EngineFailure as failure:
            self._report_failure(conn, job["id"], failure)
            return True

        self._report_success(conn, job, run)
        return True

    def _load_replay(self, conn: psycopg.Connection, replay_id: str) -> Dict[str, Any]:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT id, format, rating, players, log FROM replays WHERE id = %s", (replay_id,))
            row = cur.fetchone()
        if row is None:
            raise EngineFailure(ErrorKind.REPLAY_NOT_FOUND, f"no stored replay {replay_id}")
        # Rebuilt into the shape analyze_replay expects of a Showdown replay-API payload.
        return {
            "id": row["id"],
            "formatid": row["format"],
            "rating": row["rating"],
            "players": row["players"],
            "log": row["log"],
        }

    def _report_success(self, conn: psycopg.Connection, job: Dict[str, Any], run: AnalysisRun) -> None:
        doc = run.document
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO analyses (replay_id, perspective, search_budget_ms_per_turn,
                           opponent_samples, threads, usage_stats_cutoff, usage_stats_dataset,
                           poke_engine_tag, seed, document, total_turns, gradable_turns,
                           wall_ms, degraded)
                       VALUES (%(replay_id)s, %(perspective)s, %(budget)s, %(samples)s, %(threads)s,
                               %(cutoff)s, %(dataset)s, %(tag)s, %(seed)s, %(document)s, %(total)s,
                               %(gradable)s, %(wall)s, %(degraded)s)
                       ON CONFLICT ON CONSTRAINT analyses_identity_key DO UPDATE
                           SET document = EXCLUDED.document, wall_ms = EXCLUDED.wall_ms,
                               degraded = EXCLUDED.degraded
                       RETURNING id""",
                    {
                        "replay_id": job["replay_id"],
                        "perspective": job["perspective"],
                        "budget": job["search_budget_ms_per_turn"],
                        "samples": job["opponent_samples"],
                        "threads": job["threads"],
                        "cutoff": job["usage_stats_cutoff"],
                        "dataset": job["usage_stats_dataset"],
                        "tag": job["poke_engine_tag"],
                        "seed": job["seed"],
                        "document": json.dumps(doc),
                        "total": doc.get("totalTurns", 0),
                        "gradable": doc.get("gradableTurns", 0),
                        "wall": run.telemetry.wall_ms,
                        "degraded": run.telemetry.degraded,
                    },
                )
                analysis_id = cur.fetchone()[0]
                cur.execute(
                    _sql("complete_job"),
                    {"job_id": job["id"], "worker_id": self.worker_id, "analysis_id": analysis_id},
                )
                if cur.fetchone() is None:
                    # The lease expired between the heartbeat's last check and now. Roll
                    # back rather than leaving an analysis attached to nothing.
                    raise psycopg.Rollback
        if run.telemetry.degraded:
            log.warning(
                "job %s completed but was DEGRADED: %.0f ms/turn against %.0f expected",
                job["id"], run.telemetry.measured_ms_per_turn, run.telemetry.expected_ms_per_turn,
            )
        log.info("job %s succeeded in %s ms", job["id"], run.telemetry.wall_ms)

    def _report_failure(self, conn: psycopg.Connection, job_id: uuid.UUID, failure: EngineFailure) -> None:
        log.warning("job %s failed: %s", job_id, failure)
        with conn.cursor() as cur:
            cur.execute(
                _sql("fail_job"),
                {
                    "job_id": job_id,
                    "worker_id": self.worker_id,
                    "retryable": failure.kind in RETRYABLE,
                    "max_attempts": self.config.max_attempts,
                    "error_kind": failure.kind.value,
                    "error_detail": failure.detail[:2000],
                },
            )

    def _reclaim(self, conn: psycopg.Connection) -> None:
        """Return jobs whose lease expired, or dead-letter them at the attempt cap.

        Done by whichever worker is between jobs rather than by a separate reaper, which
        keeps the deployment to two processes. In drain mode it also means a task that
        died mid-analysis is recovered by the next task rather than waiting for a
        long-lived worker that may not exist.
        """
        with conn.cursor() as cur:
            cur.execute(_sql("reclaim_expired"), {"max_attempts": self.config.max_attempts})
            for row in cur.fetchall():
                log.info("reclaimed job %s -> %s (attempt %s)", *row)

    def run_until_empty(self, conn: Optional[psycopg.Connection] = None) -> int:
        """Claim and process until nothing is left for this build, then return the count.

        The exit condition is deliberately "nothing claimable by me" rather than "the
        queue is empty": a job for another engine build is not this process's work, and
        waiting for one that no running worker can serve would never end.
        """
        if conn is None:
            with psycopg.connect(self.config.database_url, autocommit=True) as owned:
                return self.run_until_empty(owned)
        log.info("worker %s draining, data dir %s", self.worker_id, self.adapter.data_dir)
        processed = 0
        while True:
            self._reclaim(conn)
            if not self.run_once(conn):
                log.info("worker %s drained %s job(s)", self.worker_id, processed)
                return processed
            processed += 1

    def run_forever(self, poll_seconds: float = 2.0) -> None:
        log.info("worker %s starting, data dir %s", self.worker_id, self.adapter.data_dir)
        with psycopg.connect(self.config.database_url, autocommit=True) as conn:
            while True:
                try:
                    if not self.run_once(conn):
                        self._reclaim(conn)
                        time.sleep(poll_seconds)
                except KeyboardInterrupt:
                    log.info("worker %s stopping", self.worker_id)
                    return
