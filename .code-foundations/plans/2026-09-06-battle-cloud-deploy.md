# Plan: deploy battle-cloud to AWS with a scale-to-zero worker

**Status:** Stages 1 through 3 complete and verified end to end on a public URL, 2026-09-10. Stage 4, the web client, is all that remains.

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

**2.1** CI fetches usage stats with `battle-engine`'s `scripts/fetch_usage_stats.py`, pinned to a
month, and builds the `runtime` target, so the image that gets deployed is the image CI proved.
The pin is load-bearing: with no `--month` the script resolves whatever Smogon published most
recently, which would move the image's dataset on Smogon's schedule and, since workers claim only
jobs naming their own dataset, leave every submission queued while both tiers looked healthy.

**2.2** All three images publish by digest on `main`.

**Registry: GHCR now, ECR at Stage 3.** ECR is the better target for the deployed worker, since an
in-region pull is the difference that matters for a task started per burst, and it is IAM-native
rather than needing a pull secret. It also needs an AWS account that does not exist yet. GHCR needs
nothing but the workflow's own token, so it is what can be built and verified today. Stage 3 adds
the ECR mirror and deploys from ECR digests; nothing about the images changes when it does.

**Done when:** a push to `main` leaves a digest for each of the three images, and the worker digest
analyzes a replay.

## Stage 3: infrastructure

**3.1 Terraform** for ECR, the App Runner service, the Fargate task definition and its execution
and task roles, the OIDC provider and CI role, and networking.

**Postgres is Neon, decided 2026-09-06.** Not for the database's sake: RDS lives in a VPC, App
Runner reaching a VPC needs a connector, and a connector routes the service's outbound traffic
through that VPC, so its calls to Showdown would then need a $32/month NAT gateway. Avoiding that
by moving the API to Fargate in a public subnet costs a $16/month ALB instead, because a task's
public IP changes on every restart. The free database is the cheapest line item in a configuration
whose other line items it raises. See `notes/decision-neon-over-rds-to-keep-the-api-out-of-a-vpc.md`,
including the part of the argument that is documentation rather than measurement.

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

### 2026-09-06 — Stage 2 built, not yet observed running

`.github/workflows/ci.yml` gained `migrate-image` and `worker-image`, and `api-image` now
publishes. All three push to GHCR by digest on `main` only; a pull request still builds every
image and claims no tag.

`worker-image` is separate from `gen9-guard` and depends on it, for one reason: it is the only job
that needs smogon.com. The guard has to keep running on every pull request whatever Smogon is
doing, because the failure it catches is a gen4 wheel simulating gen9 with no error. They share a
buildx cache scope, so the Rust extension compiles once per push rather than twice.

Verified locally, since a workflow cannot be run here:

- `fetch_usage_stats.py --month 2026-07 --format gen9ou --cutoff 1500` fetched in 1.0 s: 13.7 MB,
  399 species, 654,262 battles.
- That file's SHA-256 is identical to the one in the local `battle-engine` checkout and to the one
  baked into `battle-cloud-worker:latest`, so a CI-built image carries the same bytes as the image
  every measurement so far was taken against.
- Two new agreement tests assert the dataset pin is one value across the Dockerfile's ARG default,
  `.env.example`, compose, and the workflow, and the same for the poke-engine tag. 86 Python tests.

Still unobserved: the workflow itself. It has never run, so job wiring, the GHCR login, and the
`build-contexts` path in Actions are unproven until the next push to `main`.

### 2026-09-06 — the registry and CI's identity, ahead of the account

`infra/` holds Terraform for the two things that do not depend on any compute decision: three ECR
repositories with immutable tags and a ten-image lifecycle window, and a GitHub OIDC provider with
one IAM role that can push to exactly those repositories from exactly `main` of this repository.
No access key exists anywhere.

Two choices worth keeping. Tags are immutable, so the workflow pushes only a commit sha and a
deploy pins a digest: a moving `main` tag in the registry a service deploys from is how a rollback
stops being possible, and GHCR keeps the moving tag for humans instead. And the trust policy uses
`StringEquals` on the exact `sub` rather than the usual `StringLike` on `repo:owner/repo:*`, which
would hand the role to every branch and every pull-request workflow in the repository.

`mirror-to-ecr` copies each image from GHCR into ECR by digest with `crane copy`, so what a deploy
pins is the manifest CI built rather than a rebuild from the same commit. It is skipped while the
`AWS_ROLE_ARN` repository variable is unset, which is to say until the account exists.

Verified: `terraform fmt`, `init`, and `validate` pass, run in a `hashicorp/terraform:1.9`
container rather than by installing Terraform. The lock file carries hashes for `darwin_arm64`,
`linux_amd64`, and `linux_arm64`, so an apply from the laptop and a later apply from CI both work
against it. Not verified, and unverifiable until there is an account: the plan, the apply, the role
assumption, and the mirror job.

Still open before Stage 3 can finish: the AWS account itself, a Neon project and its connection
string, then the App Runner service, the Fargate task definition, the `RunTask` trigger, and the
EventBridge sweep.
### 2026-09-07 — Stage 3 applied, except App Runner

The account exists, Neon holds the schema, and the analysis path runs on deployed
infrastructure. `infra/` grew `network.tf`, `secrets.tf`, `ecs.tf`, `apprunner.tf`, and
`scheduler.tf`: a VPC with two public subnets and no NAT, the ECS cluster and the worker
task definition at 4 vCPU and 8 GB, the App Runner service and its two roles, the
EventBridge sweep, and two SSM parameters holding the connection string.

**Everything applied except the two App Runner resources.** They fail at create with
`SubscriptionRequiredException` while reads against App Runner succeed from the same admin
credentials in the same region, and every other service accepted writes. The account was
created today and the remaining hypothesis is that activation is still completing, which is
unconfirmed. See `notes/2026-09-07-first-deploy-and-fargate-measurements.md`.

**3.3, two of three numbers.** Measured against `gen9ou-2672899958`, 93 turns:
`run-task` to first container log line is 16.8 s, covering ENI attachment, a 101 MB
in-region ECR pull, and Python start. In-container overhead is 0.58 s, against 1.1 s
measured locally in compose, because Fargate's process is already running when the first
log line lands. The analysis itself took 118,923 ms. End-to-end wall time over a public URL
is still unknown, because there is no public URL yet.

Draining per burst survives the measurement: 16.8 s is 14% overhead on the first job and
zero on every job after it.

**Two decisions that changed during the build.**

The sweep runs hourly rather than "every few minutes" as this plan said. Fargate bills a
one-minute minimum and the worker task is about $0.198 an hour, so every execution costs
about $0.0033 whether or not it finds work. Every five minutes is roughly $28 a month to
poll an empty queue, more than the API and the database together. The arithmetic is in
`scheduler.tf` and the interval is `var.sweep_interval_minutes`. The trigger is the real
path; this is the floor under it. The sweep fired once on its own during testing, drained 0
jobs, and exited, which is the behavior the design wanted.

The connection string is two SSM parameters rather than one, because the tiers disagree
about what `sslmode=require` means. The API's says `verify-full` and the worker's says
`require`, per `notes/gotcha-sslmode-require-means-different-things-per-driver.md`.

**Not built, and next.** The API's `RunTask` call after enqueue: the IAM policy, the
task-definition family, the subnets, the security group, and the concurrency cap are all
set as environment variables on the App Runner service, and no code reads them yet. Until
that exists the sweep is the only trigger, which means up to an hour of latency.

Also unresolved and now live rather than theoretical: `trustProxy` is off, so behind App
Runner every client will share one rate-limit bucket. It has to go on together with a proxy
whose forwarded headers can be trusted.

### 2026-09-07 — 3.2, the RunTask trigger

`api/src/worker.ts`. The API counts in-flight worker tasks and starts one when a submission
leaves a job `queued`, which closes the gap where the hourly sweep was the only trigger and
a submission could wait an hour.

Four things are worth keeping.

**The trigger fires only for a job that is actually waiting.** A resubmit that joins a job
already `running` starts nothing, because a worker is on it and a second task would pay a
four-vCPU minute to find nothing claimable.

**Pending tasks count against the cap.** `ListTasks` is called with `desiredStatus: RUNNING`,
which includes tasks that are still PENDING, because pending describes where a task is
rather than where it is going. Counting only what is already running would start a second
worker during the 16.8 seconds the first spends attaching an ENI and pulling its image,
which is exactly the window a burst arrives in.

**A launch failure cannot fail a submission, and that is enforced twice.** The launcher
swallows and logs everything, and the route also catches. The second one is not redundant:
the job is durably enqueued before the launcher is called, so the submission has already
succeeded, and depending on a collaborator to never throw is a contract no type enforces.
A test asserted the route's behavior directly and caught that it did not hold, since the
route had been awaiting the call bare.

**A partially-configured trigger is refused at startup.** All four of `WORKER_CLUSTER`,
`WORKER_TASK_DEFINITION`, `WORKER_SUBNET_IDS`, and `WORKER_SECURITY_GROUP` or none. One
missing variable would otherwise produce a trigger that quietly does nothing while every
submission waited for the sweep and both tiers reported healthy, which is the same silent
failure shape the identity fields exist to prevent.

There is also a two-second ceiling on how long a submission waits for ECS, so an unreachable
control plane costs latency rather than a hung request.

**Tests: 147.** 61 API, up from 50: nine for the launcher and its configuration, two for the
route's firing condition and its independence from a failing launcher. 86 Python, unchanged.
Both suites now run against Neon rather than compose.

Not verified, and cannot be until App Runner exists: that the instance role's `ecs:RunTask`
and `iam:PassRole` grants are sufficient in practice. The policy is written and unexercised.


### 2026-09-10 — Stage 3 done, on Lambda rather than App Runner

**Done when: "a `POST` to the public URL returns an analysis with no machine of mine involved,
and the three numbers are recorded in a note."** Both halves hold.
`https://m6tky2d13e.execute-api.us-east-2.amazonaws.com`, and
`notes/2026-09-10-the-api-goes-public-on-lambda.md`.

**App Runner was abandoned rather than waited on.** Three days after the account was created it
still returned `SubscriptionRequiredException` in every region, from an IAM user holding
AdministratorAccess, with a payment method verified as root, while ECS, ECR, SSM, EventBridge,
Lightsail, and Amplify all accepted writes from the same credentials. One detail moved the wrong
way: on 09-07 the read succeeded and returned an empty list; on 09-10 the read itself failed.
It has no explanation, and waiting on one had no schedule attached to it.

The replacement is a Lambda function behind an API Gateway HTTP API, and the plan's cost
argument survives the substitution intact. The API tier is about $0.07 per thousand analyses
served against roughly $0.0066 for the Fargate minute each analysis costs, so the front door is
about 1% of the system at every level of traffic. That was true of App Runner too; what changed
is that the floor went from a few dollars a month to zero.

**The three numbers, plus two the plan did not ask for:**

| | |
|---|---:|
| RunTask to container running | 17.4 s |
| Of which ENI attachment | 11.5 s |
| Of which image pull, 103 MB in-region | 4.7 s |
| Analysis, 24 turns at `quick` | 8.6 s |
| Submit to served analysis, end to end | 26.7 s |
| API cold start / warm | 1.0 s / 0.15 s |

**11.5 of the 17.4 seconds is networking, not bytes.** That retires image-size work for the
worker as a latency lever, which is the second time this project has found the image size not
to be the thing that mattered.

**Three things verified for the first time**, all of them previously written and unexercised:
the instance role's `ecs:RunTask` and `iam:PassRole` grants (the Lambda logged `worker task
started` 0.7 s after the submission, and that task did the analysis); the cold-start SSM read
that hands the function its connection string; and `sslmode=verify-full` to Neon from inside
AWS.

**Two limits found:** this account's Lambda concurrency limit is 10, the new-account default,
and AWS refuses any reserved-concurrency setting that leaves under 100 unreserved, so the spend
ceiling became an API Gateway stage throttle at 20 rps and 40 burst. And Lambda's runtime client
will not load a `.ts` handler, so the artifact is an esbuild bundle rather than the container
image the Dockerfile builds. Both are written up as gotchas.

**The plan's `trustProxy` risk closed without the fix it assumed.** Fastify's hop-count trust
does nothing as of 5.12 -- it fails closed by design -- and the Lambda adapter injects API
Gateway's `sourceIp` as the request's remote address, so `request.ip` is already the address AWS
observed and no caller can forge it. Three tests pin that, because the property now lives in a
dependency.

**CI deploys now**, which the earlier log listed as missing: a `deploy-api` job builds the
bundle and calls `update-function-code`, holding `lambda:UpdateFunctionCode` on one function
and nothing else. Terraform owns the function's configuration; CI owns its code.

**Tests: 154.** 68 API, up from 61: three pinning the adapter's client-address behavior and four
on the cold-start parameter read. 86 Python, unchanged.

**Still open:** Stage 4, the web client. Terraform state is still a file on one laptop. Nothing
watches the bill.
