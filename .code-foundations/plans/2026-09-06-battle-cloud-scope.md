# battle-cloud scoping plan

Date: 2026-09-06. Status: scoped, nothing built.

This is the dedicated scoping session `CLAUDE.md` asked for. It fixes the architecture, the API contract, the phase order, and the open risks. Every measurement quoted here was taken from the sibling repos during this session and is attributed inline.

## 1. What battle-cloud is, stated as a function

battle-cloud is the intermediary that turns a synchronous, CPU-bound, laptop-local Python function into a network resource two clients can share.

The function is `battle_engine.replay_analysis.analyze_replay`:

```python
analyze_replay(
    payload,                        # a Showdown replay-API JSON dict
    *,
    perspective,                    # "p1" | "p2"
    replay_id=None,
    search_time_ms=1000,            # TOTAL per-turn budget, split across samples
    n_opponent_samples=8,
    threads=4,
    usage_stats_cutoff=1500,
    seed=0,
) -> dict                           # schema-v1 analysis document
```

It takes no network, needs no Showdown server, and reads one cached usage-stats file off disk. `scripts/analyze_replay.py` is a thin CLI wrapper and is not the integration point. battle-cloud calls the library function directly.

The resource is the schema-v1 document, already consumed by `battle-brain` through `EngineService`.

Everything else in this project exists to bridge the gap between those two facts: the function runs for minutes, the clients want an answer now, and the process running it cannot be shared.

## 2. The intermediary role, in detail

This section is the core of the scoping work. It records what battle-cloud has to reconcile between its two neighbors.

### 2.1 The `EngineService` seam has no vocabulary for a pending job

`battle-brain/BattleBrain/Core/EngineService.swift` declares one method:

```swift
protocol EngineService: Sendable {
    func analysis(forReplayId replayId: String) async throws -> ReplayAnalysis?
}
```

The doc comment fixes the semantics: `nil` means no analysis is available for this id and is explicitly not an error; a throw means a document was found and could not be decoded.

That is a two-outcome contract, designed against `BundledEngineService`, which decodes a file that either exists in the bundle or does not. A hosted implementation has a third outcome the protocol cannot express: the analysis does not exist yet and will in a few minutes. `nil` cannot carry that meaning without misleading every call site that reads it as absence.

`battle-brain/notes/decision-engine-integration-bundled-fixtures.md` claims a future HTTP implementation "can replace `BundledEngineService` without touching a single view." The seam does survive. The zero-view-change part does not, and pretending otherwise would ship a multi-minute spinner with no progress and no cancel.

**Resolution.** Keep the protocol signature exactly as written. `HostedEngineService.analysis(forReplayId:)` submits the job, polls until terminal, and returns the decoded document, so the existing contract is honored literally. Return `nil` only when the replay genuinely has no analysis and cannot get one, which in practice means Showdown itself returns 404 for the id. Throw on server failure, on a malformed document, and on exceeding a client-side deadline.

Then add progress as a separate, additive protocol that the ViewModel may consult and the existing views may ignore:

```swift
enum AnalysisProgress: Sendable {
    case queued(position: Int?)
    case running(turnsTotal: Int?, elapsed: Duration, estimated: Duration?)
    case ready
}

protocol EngineProgressReporting: Sendable {
    func progress(forReplayId replayId: String) -> AsyncStream<AnalysisProgress>
}
```

`BundledEngineService` does not conform, and nothing breaks. `HostedEngineService` conforms, and `ReplayAnalysisViewModel` can show a real progress state. The view change is real, it is confined to one feature, and it is worth making deliberately instead of discovering it during integration.

### 2.2 Search is time-budgeted, so contention degrades quality instead of latency

Read directly from `battle_engine/replay_analysis.py`:

```python
per_sample_ms = max(1, search_time_ms // n_opponent_samples)
```

`search_time_ms` is the whole per-turn budget and gets divided across opponent samples. At ladder-parity defaults that is 1000 ms per turn, 125 ms per sample, eight samples. A 93-turn replay is therefore about 93 seconds of search plus parse and translation overhead, which matches the CLI docstring's "a few minutes for a real 50-100 turn replay."

The consequence for a scheduler is unusual and it drives the whole worker design. MCTS here is given a wall-clock budget, not a node count. Two jobs sharing one core do not each take twice as long. They each explore roughly half as many nodes in the same wall time and return a worse analysis that looks identical in shape. The emitted document records `visitShare`, which is normalized, and never records total visits, so the degradation is invisible in the output and invisible to both clients.

**Consequences.**

- Worker concurrency is bounded by physical cores, and it is a hard bound rather than a tuning knob. Oversubscribing silently lowers analysis quality.
- One search in flight per worker process. `threads` is sized to the cores that process owns.
- battle-cloud records what it can actually observe. Correcting an earlier draft of this section: total visits are **not** recoverable by a caller. `analyze_replay` normalizes `aggregate()`'s `(action, visits, score)` triples into `visitShare` before returning, and returns only the document, so a consumer never sees a raw visit count. The observable degradation proxies are wall-clock time per turn measured against the requested `search_time_ms` budget, the `samplesUsed` distribution across turns, and the count of turns with a null `winProbability`. A worker whose measured per-turn wall time materially exceeds its budget is oversubscribed, and that is the signal to record. Exposing real visit counts would need an additive change in `battle-engine`, alongside the `progress_callback` proposal in 2.8.
- Golden-file tests against engine output are invalid. `seed` reproduces opponent sampling, and the search is budgeted in milliseconds, so results vary across machines and across load. Test the contract's shape and invariants, and never diff a document against a stored copy.

### 2.3 Process isolation follows from the GIL finding, and internal threading still works

`battle-engine/notes/gotcha-poke-engine-mcts-holds-the-gil.md` confirmed against pinned poke-engine source that `monte_carlo_tree_search` holds the GIL for its entire call: no `py.allow_threads` anywhere in the crate. Measured, two concurrent 600 ms searches took 1306 ms, a clean 2.00x with zero overlap.

The note is careful about what still parallelizes. The Rust-internal `threads=4` speedup is genuine, because those are native threads doing pure Rust work with no Python calls in the inner loop. Only the outer Python-level call serializes.

So the shape is settled: concurrency comes from process count, parallelism inside one analysis comes from `threads`, and a thread pool inside one Python process buys nothing.

### 2.4 The cache key is not the replay id

The document carries its own search configuration precisely so a consumer can tell a ladder-parity analysis from a cheap one. Analysis identity is:

```
(replayId, perspective, searchBudgetMsPerTurn, opponentSamples, threads, usageStatsCutoff, pokeEngineTag, seed)
```

`EngineConfiguration` carries five of those fields and `pokeEngineTag` gives version-based invalidation for free. **`seed` is absent from the emitted document.** Two analyses of the same replay at different seeds are indistinguishable from the JSON alone.

battle-cloud stores `seed` in its own row and includes it in the cache key. Without that, a re-analysis at a different seed either collides with an existing row or creates a duplicate nothing can tell apart.

`threads` belongs in the key because the aggregation across a time-budgeted multi-threaded search is not thread-count invariant. Keeping it in the key costs nothing and avoids asserting an invariance nobody has measured.

### 2.5 Who fetches the replay

Confirmed decision: the server fetches by id from `https://replay.pokemonshowdown.com/{id}.json`, the same endpoint `battle-engine/scripts/fetch_showdown_replays.py` uses.

This makes analyses cache-keyed and shareable by id, and it means no client can hand the service a large blob to spend minutes of CPU on. The cost is a double fetch for the iOS app, which already downloads the payload itself for on-device timeline parsing in `ReplaySource.fetch`. That duplication is acceptable at this scale and it keeps the trust boundary on the server side of the wire.

The fetched payload is third-party input on the server too. The engine already validates it: `_validate_payload_fields` rejects malformed `players`/`id`/`formatid`, an unsafe-charset replay id is refused by `_SAFE_ID_PATTERN`, CRLF is normalized before the driver sees it, and `RecursionError` from pathologically nested JSON is caught. battle-cloud adds a response size cap and a timeout at fetch time and otherwise lets the engine's own validation do its job rather than duplicating it.

### 2.6 The document's own edges

Measured from `battle-brain/BattleBrain/Resources/analysis/`, six real gen9ou fixtures:

- 100 KB to 220 KB per document. `gen9ou-2672899958.json` is 219,804 bytes for 93 turns.
- Dominated by `topActions`, around 50 ranked entries per turn.
- The fixtures include `rating` and `players` at the top level. The Swift `ReplayAnalysis` decodes neither. Extra keys decode fine, so this is not a bug, but the API contract should keep emitting them since the web client will want both.
- `schemaVersion` is checked strictly on the Swift side. Any change to the number breaks every existing client, so the API version and the schema version are separate things and must stay separate.

**Response size decision.** Serve the complete document with gzip enabled and do not truncate `topActions`. JSON of this shape compresses roughly an order of magnitude, which puts a large document in the tens of kilobytes on the wire. Truncating the array would make `visitShare` stop summing to approximately 1, which quietly breaks any consumer that treats it as a distribution. Revisit only with a measurement showing it matters.

### 2.7 Why a job is not sharded across workers in v1

A replay's turns look embarrassingly parallel, since every `(turn, sample)` search is independent. Two things block it:

1. `ReplayDriver` is a sequential stateful iterator over the protocol log. Reaching turn 60 means driving turns 1 through 59 first. A shard covering turns 60-93 has to re-drive the prefix. Parsing is cheap next to search, so this is probably fine, and it has not been measured.
2. `analyze_replay` exposes no turn range. Sharding would mean reimplementing its driver loop and its grading logic inside battle-cloud, duplicating the exact code that took three rounds of security review to harden in `battle-engine`.

So v1 is one job, one worker process, one `analyze_replay` call. Throughput comes from running several jobs at once, which is the real workload anyway.

If sharding is ever wanted, the honest path is an additive change upstream in `battle-engine` (a turn-range argument, or a `progress_callback`), proposed and measured there. Reimplementing the loop here is the option to avoid.

### 2.8 Progress reporting without modifying the engine

`analyze_replay` is one blocking call with no callback, so per-turn progress is not observable from outside.

What is available cheaply: the API fetches the replay payload before enqueueing and counts `|turn|` lines in the log. That gives a turn count up front, and turn count times the per-turn budget gives an estimate good enough for a progress bar. Report elapsed against that estimate, and label it an estimate in the API field name so no client mistakes it for measured progress.

A `progress_callback` kwarg in `battle-engine` is the one upstream change worth proposing later. It is additive, it breaks nothing, and it would make this honest instead of estimated.

## 3. Packaging and the gen9 trap

`battle-brain`'s bundled-fixtures decision cited "a manylinux build of poke-engine's Rust extension" as a reason to reject a hosted backend. That framing overstates the work. A manylinux wheel is for redistribution on PyPI. This project needs one Linux container image that it builds itself.

The analysis import graph was traced this session: `replay_analysis` pulls `poke_engine`, `poke_env`, and stdlib, through `fidelity`, `poke_engine_state`, `replay_log`, `set_prediction`, `set_search`, and `usage_stats`. No torch, no numpy, no requests. The worker image does not need the ML extras.

The image is a multi-stage build:

1. **Builder stage.** Rust toolchain and maturin. Clone poke-engine pinned at `v0.0.48`. Build with `--no-default-features --features "poke-engine/gen9,poke-engine/terastallization"`, exactly as `battle-engine/scripts/build_poke_engine.sh` does.
2. **Guard step, mandatory.** Run `tests/test_poke_engine_is_gen9.py` during the image build. `battle-engine/notes/gotcha-poke-engine-pypi-wheel-is-gen4-not-gen9.md` documents that the published wheel is gen4, and that a gen4 build accepts a gen9ou state and simulates it under gen4 mechanics with no error and no warning. A build that fails loudly is strictly better than a service that is quietly gen4 for months. Terastallization is a separate feature and gen9 alone does not imply it.
3. **Runtime stage.** Slim Python base, the built extension copied in, `battle-engine` installed from a pinned git ref, and the usage-stats file.

Two constraints read out of the engine's code:

- `usage_stats.py` line 100: `DEFAULT_STATS_DIR = Path("data/usage_stats")`. It is relative to the process working directory, and `analyze_replay` does not expose a `stats_dir` override, so battle-cloud cannot inject a path through the public API. The worker sets its working directory, or the image places the file at that exact relative path. Setting `WORKDIR` and copying the file to `data/usage_stats/` is the simplest answer.
- `default_usage_stats` is `@lru_cache(maxsize=4)`d because parsing about 14 MB of JSON per call is too expensive to repeat. `2026-07_gen9ou-1500.json` is 13,724,217 bytes. This argues for long-lived warm worker processes over fork-per-job, and the cold-start cost should be measured in Phase 1 rather than assumed.

`battle-engine` is not on PyPI. Install it in the image from a pinned git SHA. Its `pyproject.toml` already declares `[tool.setuptools.packages.find] include = ["battle_engine*"]`, so a git install resolves correctly. Pinning a SHA also means a `pokeEngineTag` or engine-code change is a deliberate image rebuild with a cache invalidation, rather than a silent drift.

## 4. Architecture

Four services, three of them containers you write.

```
web (React + TS, Vite)
        |  HTTPS/JSON
   api (TypeScript, Fastify + zod)  --- fetches replay from Showdown by id
        |                            \
        |  Postgres                   \  writes job row
        v                              v
   postgres  <-- FOR UPDATE SKIP LOCKED --  worker (Python, N processes)
                                                |
                                                v
                                    analyze_replay(...) -> schema-v1 doc
```

**Queue: Postgres with `FOR UPDATE SKIP LOCKED`, not Redis.** At this scale a jobs table with skip-locked claiming is correct, it removes an entire service from the compose file and the deploy, and it survives restarts without extra work. Stating the tension openly, as `CLAUDE.md` requires: Redis appears in five scorecards under the data-infrastructure gap, so there is a resume argument for adding it. That argument is not a systems argument, and adding a broker this workload does not need would be exactly the distortion `CLAUDE.md` warns about. If Redis gets added later it should be for a reason the system has, such as pub/sub for live job updates to the web client.

**API in TypeScript, worker in Python.** Already settled in `CLAUDE.md` and it holds up. The split is honest: the worker has to be Python because the engine is, and a typed gateway in front of it is an ordinary polyglot boundary.

**Postgres schema, first cut.**

- `replays` — `id` (Showdown replay id, PK), `format`, `rating`, `players` (jsonb), `log_hash`, `fetched_at`, `payload_bytes`. The raw payload is stored in object storage or a column depending on size; a real log is tens of kilobytes, so a `text` column is fine to start.
- `analyses` — `id` (uuid), the full identity tuple from 2.4 as a unique constraint, `document` (jsonb), `total_turns`, `gradable_turns`, `created_at`, and telemetry columns for total visits and wall time per run.
- `jobs` — `id` (uuid), `replay_id`, requested parameters, `status` (`queued` | `running` | `succeeded` | `failed` | `cancelled`), `attempts`, `claimed_at`, `claimed_by`, `estimated_turns`, `error_kind`, `error_detail`, `analysis_id` on success.

**API contract, first cut.** Versioned under `/v1`. The API version is independent of `schemaVersion` inside the document.

- `POST /v1/analyses` with `{ replayId, perspective, profile? }`. Returns `200` with the analysis when the identity already exists, or `202` with a job handle. Idempotent on the identity tuple, so a resubmit joins the existing job rather than starting a second one.
- `GET /v1/analyses/{analysisId}` returns the schema-v1 document verbatim inside a thin envelope carrying the identity fields the document omits, `seed` above all.
- `GET /v1/analyses?replayId=&perspective=&profile=` resolves an identity to an analysis or a 404.
- `GET /v1/jobs/{jobId}` returns status, `estimatedTurns`, elapsed, and the estimated total.
- `GET /healthz`, `GET /readyz`.

`profile` is a named bundle of search parameters (`ladder-parity`, `quick`) rather than raw milliseconds on the wire. Clients should not be choosing a CPU budget for your server, and a named profile keeps the identity tuple small and the rate limiting meaningful.

Rate limiting is by IP, confirmed as the v1 answer on auth. The thing being limited is job creation, since a cached read costs nothing and a search costs a core-minute.

## 5. Phases

Each phase has a done-when that can be checked by running something.

**Phase 0. Repo skeleton.** `git init`, `.git/info/exclude` for the vault artifacts per `../CLAUDE.md`, directory layout, `README.md`, this plan committed. Done when the tree exists and the exclusion is verified with `git status` showing no vault files.

**Phase 1. Worker image, and it goes first because it is the only phase that can fail for reasons outside your control.** A Dockerfile that builds gen9 poke-engine from pinned source, runs the gen9 guard test as a build step, installs `battle-engine` from a pinned ref, and ships the usage-stats file. A one-shot entry point that analyzes a bundled replay and prints the document. Done when `docker run` produces a schema-v1 document whose `engine.pokeEngineTag` is `v0.0.48`, and when three numbers are recorded in a note: image size, cold-start time including the usage-stats parse, and wall-clock time for one real 90-turn replay at ladder parity.

**Phase 2. Postgres and the queue.** Schema, migrations, the skip-locked claim query, the worker loop with heartbeats, retry with a cap, and a dead-letter state. Done when two workers against one Postgres process a queue of ten jobs with no double-claim, and when killing a worker mid-job returns that job to `queued` after its lease expires.

**Phase 3. The API.** Fastify, zod schemas at the boundary, the endpoints above, Showdown fetch with size cap and timeout, the turn-count estimate, idempotent submission, IP rate limiting. Done when the full submit-poll-fetch cycle works against a live worker and an OpenAPI document is generated from the zod schemas.

**Phase 4. Compose.** One `docker-compose.yml` bringing up postgres, api, and N workers. All configuration through environment variables with no hardcoded hosts. Done when `docker compose up` from a clean checkout gets you a working API on localhost.

**Phase 5. Web client.** React, TypeScript, Vite. Submit a replay id, watch job status, read the eval curve, browse past analyses. Types generated from the OpenAPI document so the contract is enforced at compile time on the client. Done when a replay id typed into a browser produces a rendered eval curve.

**Phase 6. CI.** GitHub Actions: build both images, run the API test suite, run the worker test suite, run the gen9 guard. Done when a pull request gets a green check and a broken gen9 build fails it.

**Phase 7. Deploy.** Fly.io, one app per service, managed Postgres, secrets as env vars, infrastructure declared in files that live in the repo. Done when a public URL serves a real analysis and the deploy is reproducible from a clean clone. This phase is not optional; an undeployed service does not close the DevOps gap.

**Phase 8. iOS `HostedEngineService`.** Conform to `EngineService` with the submit-and-poll implementation from 2.1, add `EngineProgressReporting`, and give `ReplayAnalysisViewModel` a progress state. Done when the app renders an eval curve for a replay that was never bundled.

Phases 1 through 4 are the spine. Phase 5 is the frontend gap. Phase 7 is the DevOps gap. Phase 8 is the payoff on a seam designed a year earlier for exactly this.

## 5a. Local toolchain reality, measured 2026-09-06

Checked on this machine during scoping: `docker`, `podman`, `colima`, and `psql` are all absent, and no container runtime is installed. Node 26.0.0 and Python 3.13.2 are present.

This does not change the architecture. It changes what any given session can verify, and the phase order has to respect that:

- Phase 1 and Phase 4 cannot be verified without a container runtime. Docker Desktop or Colima has to be installed first, and that is a deliberate choice for the user to make rather than something a session installs on its own.
- Phase 2 cannot be verified without a Postgres to run against, which in practice arrives with the container runtime.
- Everything that is pure logic can be built and tested today with no new system dependencies: the API's contract schemas, the profile registry, the analysis identity, the Showdown fetch client and its size cap, the turn-count estimator, and the worker's configuration, parameter validation, and error classification.

So the build order inverts relative to section 5 for practical reasons. The pure layers of the API and worker land first with real tests, the SQL and the container definitions land as reviewed-but-unverified artifacts, and a single `brew install` unblocks the verification of both.

## 6. Open risks

- **Phase 1 is the real risk and everything after it is ordinary work.** Building poke-engine's Rust extension for Linux in a container has not been attempted. Everything downstream assumes it works.
- **Cost of a core-minute.** One analysis is roughly a minute of a dedicated core at ladder parity. A scale-to-zero worker on a small host handles a personal-scale workload. Public submission without limits does not survive contact with anyone who wants to be annoying, which is why rate limiting is in Phase 3 rather than deferred.
- **Quality degradation is invisible without the visit telemetry from 2.2.** If that telemetry is skipped, an overloaded deploy returns worse analyses and nothing reports it.
- **Showdown replays expire and can be private.** `ReplaySource.FetchError` already enumerates the failure shapes the app sees. The API needs the same vocabulary, and a 404 from Showdown has to be distinguishable from a 404 for an unknown analysis id.
- **The `EngineConfiguration` seed gap from 2.4** is a schema-v1 limitation battle-cloud works around locally. If schema v2 ever happens, adding `seed` there is the fix.

## 7. Decisions to record as notes once building starts

Per this project's `CLAUDE.md`, these become individual `notes/decision-*.md` files rather than living only in this plan:

- Process isolation and one search per worker, with the GIL measurement as its grounding.
- Postgres skip-locked over Redis, with the resume tension stated.
- Server-side replay fetch over client upload.
- `EngineService` preserved and progress added additively.
- No turn-level sharding in v1, with the `ReplayDriver` prefix cost as the reason.
- Full documents over truncated `topActions`.
