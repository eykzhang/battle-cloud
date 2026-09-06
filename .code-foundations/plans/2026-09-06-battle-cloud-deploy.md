# Plan: deploy battle-cloud to AWS with a scale-to-zero worker

**Status:** in progress. Stage 1 complete and verified; Stage 2 next.

Follows `2026-09-06-battle-cloud-foundation.md`, which closed the submit-analyze-serve loop
locally. This plan takes it to a public URL.

## Decision

The worker runs as a Fargate task started when work is enqueued, drains the queue until it is
empty, and exits. The API is a small always-on service. Postgres is managed.

Three facts decided this:

- **Idle cost.** A 4 vCPU, 8 GB Fargate task is about $0.198/hour, so an always-on worker is
  roughly $145/month to wait for a submission this service does not yet receive. A 40-second
  analysis at the same size costs about $0.002.
- **Cold start is not a barrier.** Measured 2026-09-06 in the worker image: 0.13 s to import
  `battle_engine.usage_stats`, 0.35 s to parse the 13.7 MB file, 0 s cached. The scoping
  document's argument for long-lived warm workers rested on an unmeasured assumption about that
  parse. See `notes/gotcha-usage-stats-cold-start-is-cheap.md`.
- **The queue is already the source of truth.** `FOR UPDATE SKIP LOCKED` over a table means a
  trigger is an optimization and never a correctness dependency. A lost `RunTask` call delays a
  job until the next execution; it cannot lose one. A scheduled sweep is the safety net.

**AWS rather than another provider is a resume-coverage choice, and this project's `CLAUDE.md`
requires saying so.** The system is indifferent. The application corpus is not: 24 mentions of
AWS across the job descriptions, against 13 for GCP and Google Cloud combined and 11 for Azure.

Kubernetes was rejected on cost against benefit. EKS is $73/month for the control plane before
any compute, for a workload that is one worker and one small HTTP service.

## Constraints the existing code imposes

1. **No shared or burstable vCPU for the worker.** The search is budgeted in wall-clock
   milliseconds, so a throttled core returns a shallower analysis rather than a slower one, and
   the document records only normalized `visitShare`. This is the failure `WorkerConfig.from_env`
   exists to prevent, and a burstable instance reintroduces it below the level that check can
   see. Fargate vCPU is not burstable, which is part of why it is the target.
2. **Four real cores, or a second cache namespace.** `ladder-parity` fixes `threads: 4` and
   `threads` is an identity field. Running the worker with `ENGINE_THREADS=2` is legal and
   produces analyses under a different identity, not comparable with `battle-brain`'s bundled
   fixtures.
3. **The full worker image is not buildable from public sources.** `battle-engine`'s `.gitignore`
   excludes `data/`, so CI builds only the `engine-verified` target today. A deploy needs the
   `runtime` target, which needs the 13.7 MB usage-stats file.
4. **The rate limiter is in-memory and therefore per-instance.** App Runner can run more than one
   instance, at which point the limit silently multiplies.
5. **The usage-stats dataset is not in the analysis identity.** `usageStatsCutoff` is,
   `pokeEngineTag` is, the month of the stats file is not. Two workers built from different
   months produce different analyses under the same cache key, with nothing recording the
   difference. This is the one live correctness defect in the current schema and Stage 1 fixes it
   before there is any deployed data to migrate.

## Stage 1: contract and data-model changes, while the only database is local

**1.1 The engine build becomes part of the identity, and workers claim only what they can
reproduce.**

- `usageStatsDataset` joins the identity, making it nine fields: `docs/contract.md`,
  `api/src/contract/identity.ts`, `worker/battle_cloud_worker/contract.py`, a `0002` migration
  adding the column to `analyses` and `jobs` and rebuilding both identity constraints.
- The API reads it from `USAGE_STATS_DATASET`, mirroring how `POKE_ENGINE_TAG` is already
  handled: a value that must match what the worker image was built from.
- `claim_job.sql` filters on `poke_engine_tag` and `usage_stats_dataset` matching the claiming
  worker's own build. Today a worker claims any queued job and analyzes it with whatever engine
  and stats it happens to carry, storing the result under an identity it did not actually
  produce. That is invisible in a single-version fleet and wrong during any rolling deploy, which
  scale-to-zero makes routine: a burst can start tasks from two image versions.
- Worker config gains `poke_engine_tag` and `usage_stats_dataset`, both set in the Dockerfile
  runtime stage from the build args that already exist.

**Done when:** a worker whose tag or dataset differs from a queued job's leaves that job queued;
two analyses of one replay under different datasets coexist as separate rows; the contract
document, both contract modules, and `test_contract_agreement.py` agree on nine fields.

**1.2 The rate limiter moves to Postgres.** In-memory per-instance limiting is wrong as soon as
the API scales past one instance, and the module already says so. A table keyed by address and
hour window, with the same limit semantics.

**Done when:** two API instances against one database share a window, covered by a test that
constructs two `RateLimiter`s.

**1.3 Worker drain mode.** `run_until_empty`, alongside the existing `run_forever`, exiting 0
when a claim returns nothing. Selected by `WORKER_MODE`, defaulting to `forever` so compose is
unchanged.

**Done when:** a drain-mode worker started against an empty queue exits 0 without claiming; one
started against three queued jobs finishes all three and exits; a claim failure mid-drain still
exits non-zero.

**1.4 A slim migrate image.** Migrations currently run through the 474 MB worker image because it
is the only one with psycopg. A python-slim image with psycopg and `db/` is seconds to pull and
removes the deploy's dependency on the heavyweight image being present.

**Done when:** `docker compose --profile migrate run --rm migrate` still applies migrations, from
an image under 150 MB.

## Stage 2: artifacts CI can build and publish

**2.1** CI fetches usage stats with `battle-engine`'s `scripts/fetch_usage_stats.py` and builds
the `runtime` target, so the image that gets deployed is the image CI proved.

**2.2** Both images push to ECR by digest on `main`, through GitHub OIDC with no long-lived keys.
Deploys reference digests rather than tags, so a rollback is a digest change.

**Done when:** a push to `main` leaves an ECR digest that `docker run` can analyze a replay from.

## Stage 3: infrastructure

**3.1 Terraform** for ECR, the App Runner service, the Fargate task definition and its execution
and task roles, the OIDC provider and CI role, and networking. Managed Postgres: Neon's free tier
to start, with RDS as the option if the free tier's limits bite.

**3.2 Trigger and sweep.** The API calls `RunTask` after a successful enqueue, subject to a cap
on concurrent tasks. An EventBridge schedule runs the same task every few minutes so a dropped
trigger costs latency and nothing else.

**3.3 Measure.** Cold-pull time for the 474 MB image, task scheduling latency, and end-to-end
wall time from `POST` to a served analysis over the public URL. These are the numbers that decide
whether per-burst draining stays the right shape, and none of them is known yet.

**Done when:** a `POST` to the public URL returns an analysis with no machine of mine involved,
and the three numbers are recorded in a note.

## Stage 4: the web client

React and TypeScript, built as a static bundle, against the deployed API. Deployment is
CloudFront and S3 or Cloudflare Pages, independent of the decisions above.

## Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| Image pull time dominates a short analysis | 3.3 | Smaller than assumed: the worker image is 103 MB pulled, not the 474 MB of disk usage quoted everywhere. Drain per burst amortizes what remains. Registry pull latency on Fargate is still unmeasured |
| Neon free tier storage (0.5 GB) against 100-220 KB documents | 3.1 | About 2,500 analyses; move to RDS when it matters, the schema does not change |
| `RunTask` throttling or task-start failures under a burst | 3.2 | The sweep already covers it; the queue is durable |
| arm64 locally, amd64 in CI | 2.1 | Pick amd64 for the deployed image and build it in CI; keep local arm64 for development only |
| `request.ip` is the proxy's address behind App Runner | 3.1 | `trustProxy` is off deliberately today. It has to go on together with a proxy whose forwarded headers can be trusted, or every client shares one rate-limit bucket |


## Execution log

### 2026-09-06 — Stage 1 complete

**1.1 The engine build joined the identity.** `usageStatsDataset` is the ninth field, and
`claim_job.sql` filters on `poke_engine_tag` and `usage_stats_dataset` matching the claiming
worker's own build. Recorded in `notes/decision-engine-build-is-part-of-the-identity.md`.
Verified in the real image: a `2026-07` worker succeeded its matching job in 7,503 ms and left
a `2026-08` job queued with `attempts` at 0. Both startup guards exit 2 with the offending
value named. The identity list now exists in five places; three are checked against each other
in `test_contract_agreement.py`, and the two SQL constraints are read back out of
`pg_constraint` and `pg_index` in `test_schema.py`.

**1.2 The rate limiter moved to Postgres.** `rate_limit_windows` (migration 0003), counted with
one `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit`, so the read and the increment
are one statement and two instances cannot both win the race. Windows are aligned to the wall
clock rather than starting at a client's first request, because two instances have to agree on
where a window begins without coordinating. `retryAfterSeconds` is arithmetic on that boundary
and costs no query. Six tests, including two limiters against one database sharing a window,
which is the property the in-memory version could not have.

**1.3 Drain mode.** `run_until_empty` alongside `run_forever`, selected by `WORKER_MODE`, which
rejects an unknown value rather than falling back. Its exit condition is "nothing claimable by
this build" rather than "the queue is empty", so a job for another image version cannot hold the
task open. It reclaims expired leases before each claim, because in this mode there may be no
long-lived worker to notice a task that died mid-analysis. Verified end to end:
`docker compose run --rm -e WORKER_MODE=drain worker` claimed a queued job, analyzed it in
7,550 ms, and exited 0 after 8,664 ms of total wall time.

**1.4 A migrate image without the engine.** `docker/migrate.Dockerfile`, 56 MB pulled against the
worker's 103 MB, and buildable with no `battle-engine` checkout at all. Migrations gate every
deploy, so they should not wait on the image that carries a compiled Rust extension.

**Measurements worth carrying into Stage 3.** Per-execution overhead on an already-pulled image
is about 1.1 s, from the 8,664 ms drain against a 7,550 ms analysis. Image sizes quoted before
today were disk usage; the pull is 103 MB for the worker, 82 MB for the API, 56 MB for migrate.
See `notes/gotcha-docker-images-size-is-disk-usage-not-pull-size.md`.

**Tests: 134.** 50 API (17 contract, 13 replay, 14 routes, 6 rate limiter) and 84 Python
(48 worker, 36 database), up from 106.
