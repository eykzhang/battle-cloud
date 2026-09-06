# Plan: battle-cloud foundation (worker core, API core, schema, containers)
**Created:** 2026-09-06
**Status:** in progress -- Phases 1-6 built and verified; API server, web client, and deploy remain
**Complexity:** complex
**Review cadence:** 3
---
## Context

**Problem.** `battle-engine` exposes `analyze_replay(...)`, a synchronous CPU-bound Python function that turns a Showdown replay into a schema-v1 analysis document in a few minutes. `battle-brain` consumes that document through a one-method `EngineService` seam that today reads six bundled fixtures. Nothing connects them over a network, so analysis is limited to replays someone pre-computed by hand on a laptop, and there is no web client at all.

battle-cloud is the intermediary: a job-queued service that runs the engine in isolated worker processes, stores the results, and serves them over HTTP to a React web client and to a future iOS `HostedEngineService`. The full scoping analysis, including the six findings that shape the design, is `.code-foundations/plans/2026-09-06-battle-cloud-scope.md` and is the normative reference for anything this plan does not restate.

**Constraints** are listed below. **Success criteria:** the pure logic layers of both tiers exist with real passing tests; the database schema and the container definitions exist as reviewed artifacts; and the single system dependency blocking end-to-end verification is named rather than silently installed.

## Constraints

- **No container runtime and no Postgres on this machine** (verified 2026-09-06: `docker`, `podman`, `colima`, `psql` all absent). Node 26.0.0 and Python 3.13.2 are present. Nothing in this plan may install a system-level dependency; phases that need one produce reviewed-but-unverified artifacts and say so.
- **`battle-engine` is read-only.** This project calls it and does not modify it. Any capability that would need an engine change is recorded as a proposal, never implemented here.
- **No git operations.** The parent `CLAUDE.md` says the user handles git tracking locally, and `battle-cloud` is not yet its own repository (the enclosing git root is `/Users/edward/Projects`). Build does not init, add, or commit. The user runs `git init` when ready.
- **`poke_engine` is not importable in this environment.** The worker's engine adapter imports it lazily so the worker's own logic stays testable without the compiled gen9 extension.
- **Schema v1 is frozen.** `battle-brain`'s Swift decoder rejects any `schemaVersion` other than `1`. The document is passed through byte-faithfully; battle-cloud adds context in an envelope around it, never inside it.
- **The analysis identity is the cache key**, and it includes `seed`, which the document itself does not carry: `(replayId, perspective, searchBudgetMsPerTurn, opponentSamples, threads, usageStatsCutoff, pokeEngineTag, seed)`.
- **Clients choose a named profile, not raw milliseconds.** A client must not be able to pick your server's CPU budget.
- **Vault artifacts** (`notes/`, `overview.md`, `CLAUDE.md`) are never added to this repo's git tracking.

---
## Chosen Approach

**Pure-core-first, infrastructure-last.** Build the logic that needs no running infrastructure (contract schemas, identity derivation, replay fetching, turn estimation, worker configuration, error classification) with full test coverage now, and land the SQL and container definitions as reviewed artifacts whose verification is gated on one `brew install`. **Rationale:** it is the only ordering that produces genuinely verified work in an environment with no Docker and no Postgres, and it front-loads the parts a later infrastructure phase depends on. **Fallback:** if the user installs a container runtime, the unverified phases get a verification pass appended rather than a rewrite, because nothing in them was designed around the absence.

## Rejected Approaches

- **Infrastructure-first (Dockerfile and compose before any logic):** matches the scoping doc's risk ordering and is right in principle, since the gen9 image build is the one step that can fail for external reasons. Rejected only because it cannot execute here: with no container runtime, the phase produces an unverified file either way, and doing it first would leave the session with nothing tested.
- **Monolithic Python service (FastAPI, no TypeScript tier):** simpler and one language. Rejected because the TypeScript gateway is a stated project goal, and because a typed boundary in front of an untrusted-input path is worth having on its own merits.
- **Redis or a dedicated broker for the queue:** more conventional. Rejected in favor of Postgres `FOR UPDATE SKIP LOCKED`, which removes a service from the deploy and is sufficient at this scale. The resume argument for Redis is real and is deliberately not the deciding factor.
- **Reimplementing the per-turn driver loop in battle-cloud to shard a job across workers:** would duplicate grading logic that took three rounds of security review to harden upstream. Rejected; a turn-range argument in `battle-engine` is the honest path if sharding is ever needed.

---
## Implementation Phases

### Phase 1: Repo skeleton and shared vocabulary
**Model:** sonnet
**Skills:** code-foundations:code-standards -- establishes the conventions later phases are checked against
**Gate:** Minimal
**Depends on:** none
**Unlocks:** Phase 2, Phase 4, Phase 5, Phase 6
**File scope:** `README.md`, `docs/**`, `api/package.json`, `api/tsconfig.json`, `worker/pyproject.toml`, `.gitignore`, `.env.example`

**Goal:** Create the two-tier directory layout, the package manifests, and the written record of the vocabulary every later phase shares (profiles, analysis identity, job states, error kinds).

**Scope:**
- IN: directory layout; `api/` npm manifest and strict `tsconfig`; `worker/` pyproject; `README.md` stating what is built and what is not; `docs/contract.md` fixing profile names, the identity tuple, job states, and the error taxonomy; `.env.example`; `.gitignore`.
- OUT: any executable code; any git operation; CI configuration.

**Constraints:** `.gitignore` covers build outputs only. The vault-artifact exclusion belongs in `.git/info/exclude` and is the user's to add after `git init`, so `README.md` says so rather than the repo carrying it.

**Produces:** `docs/contract.md` defining: `Profile = "ladder-parity" | "quick"` with their exact engine parameters; `AnalysisIdentity = {replayId, perspective, searchBudgetMsPerTurn, opponentSamples, threads, usageStatsCutoff, pokeEngineTag, seed}` (eight fields; `profile` is deliberately absent, being shorthand that expands into the parameters, so two profiles expanding identically correctly share one analysis); `JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"`; and the closed error-kind vocabulary shared by both tiers.

**File hints:** `../battle-brain/docs/code-standards.md` -- the sibling's conventions doc, for shape.

**Done when:**
- [ ] DW-1.1: `api/` and `worker/` exist with valid manifests; `npm --prefix api install` and a `python -m compileall worker` both succeed.
- [ ] DW-1.2: `docs/contract.md` names both profiles with their exact `search_time_ms`, `n_opponent_samples`, `threads`, `usage_stats_cutoff`, and `seed` values.
- [ ] DW-1.3: `docs/contract.md` lists the eight-field analysis identity and states explicitly that `seed` is absent from schema v1 and must be stored separately.
- [ ] DW-1.4: `README.md` states that Docker and Postgres are required for end-to-end operation and are not installed, and that `git init` plus `.git/info/exclude` are the user's steps.

**Difficulty:** LOW
**Uncertainty:** None.

### Phase 2: API contract layer
**Model:** sonnet
**Skills:** code-foundations:aposd-designing-deep-modules -- the contract module is the seam every other API module depends on; code-foundations:code-clarity-and-docs
**Gate:** Standard
**Depends on:** Phase 1
**Unlocks:** Phase 3
**File scope:** `api/src/contract/**`, `api/test/contract/**`

**Goal:** Implement the typed contract in TypeScript: zod schemas for every request and response, the profile registry, and the analysis-identity derivation and its stable cache key.

**Scope:**
- IN: zod schemas for `POST /v1/analyses` request, job handle, job status, and the analysis envelope; a schema for the schema-v1 document that validates the fields `battle-brain` decodes and passes unknown keys through untouched; the profile registry; `deriveIdentity(request, engineVersion)` and `identityKey(identity)` producing a stable, order-independent string.
- OUT: HTTP routing, server wiring, database access, the Showdown client.

**Edge cases:** an unknown profile name is rejected at the boundary rather than defaulted; `perspective` accepts only `"p1"` and `"p2"`; a replay id must match the engine's own safe-character rule before it can reach a URL; `identityKey` must produce identical output regardless of object key order; a document whose `schemaVersion` is not `1` fails validation with a typed error naming the version found.

**Produces:** `api/src/contract/index.ts` exporting `Profile`, `PROFILES: Record<Profile, EngineParams>`, `AnalysisIdentity`, `deriveIdentity(req: SubmitRequest, engineVersion: string): AnalysisIdentity`, `identityKey(id: AnalysisIdentity): string`, `SubmitRequestSchema`, `JobSchema`, `AnalysisEnvelopeSchema`, `SchemaV1DocumentSchema`, and `ErrorKind`.

**Approach notes:** Profiles exist so a client cannot choose the server's CPU budget -- a scoping decision, not discoverable from code.

**File hints:** `../battle-brain/BattleBrain/Core/EngineService.swift` -- the authoritative field list and nullability the schema must match.

**Done when:**
- [ ] DW-2.1: `SchemaV1DocumentSchema` validates all six real fixtures in `../battle-brain/BattleBrain/Resources/analysis/` without error.
- [ ] DW-2.2: `SchemaV1DocumentSchema` rejects a document whose `schemaVersion` is `2`, with an error naming the version.
- [ ] DW-2.3: `identityKey` returns the same string for two identity objects built with different key insertion order, and different strings when only `seed` differs.
- [ ] DW-2.4: `SubmitRequestSchema` rejects an unknown profile, an invalid perspective, and a replay id containing `/` or `..`.
- [ ] DW-2.5: `npm --prefix api test` passes with every DW above covered by a named test.

**Difficulty:** MEDIUM
**Uncertainty:** Whether the fixtures contain any field not present in all six; DW-2.1 settles it empirically.

### Phase 3: Showdown replay client and turn estimator
**Model:** fable
**Skills:** code-foundations:cc-defensive-programming -- trust-boundary hardening for third-party network input; code-foundations:aposd-verifying-correctness
**Gate:** Full
**Security-sensitive:** yes
**Depends on:** Phase 2
**Unlocks:** none
**File scope:** `api/src/replay/**`, `api/test/replay/**`

**Goal:** Fetch a replay payload from Showdown by id behind a size cap and a timeout, classify every failure into the shared error vocabulary, and estimate a replay's turn count so a job can report an ETA before any search runs.

**Scope:**
- IN: `fetchReplay(replayId, deps)` against `https://replay.pokemonshowdown.com/{id}.json` with an injected fetch seam; a byte cap enforced while streaming rather than after buffering; a request timeout; error classification; `estimateTurns(log)` counting `|turn|` protocol lines; `estimateDuration(turns, profile)`.
- OUT: caching, persistence, retries against Showdown, the job queue.

**Constraints:** the fetch seam is injected so every test is hermetic and touches no network. The cap must bound what is buffered, which is the gap `battle-brain`'s own `ReplaySource` documents as unfixed on its side; here it is enforceable because the streaming API is available.

**Edge cases:** HTTP 404 for a nonexistent or expired replay; a 200 response with an empty `log`, which is the shape a private replay returns; a body exceeding the cap, rejected before it is fully read; a response that is valid JSON but not an object; a body that is not JSON at all; a connection failure below the HTTP layer; a timeout; a replay id that fails the safe-character rule, rejected before any URL is constructed; a log with zero `|turn|` lines; a log using CRLF line endings.

**Produces:** `api/src/replay/index.ts` exporting `fetchReplay(replayId: string, deps: ReplayDeps): Promise<ReplayPayload>`, `ReplayFetchError` carrying an `ErrorKind` from Phase 2, `estimateTurns(log: string): number`, and `estimateDuration(turns: number, profile: Profile): number`.

**Approach notes:** The server fetches by id rather than accepting a client-uploaded payload -- a confirmed scoping decision that keeps analyses cache-keyed by id and stops a client from handing the service a large blob to spend CPU on.

**File hints:** `../battle-brain/BattleBrain/Features/ReplayAnalysis/ReplaySource.swift` -- the error taxonomy to mirror and its documented 5MB cap rationale; `../battle-engine/scripts/fetch_showdown_replays.py` -- the authoritative URL shape.

**Done when:**
- [ ] DW-3.1: `estimateTurns` returns the exact `totalTurns` recorded in each of the six analysis fixtures when run against that replay's raw payload in `../battle-brain/BattleBrain/Resources/replays/`.
- [ ] DW-3.2: A body exceeding the cap raises `ErrorKind.responseTooLarge` without the full body ever being accumulated, asserted by a test whose fake stream would exhaust memory if fully read.
- [ ] DW-3.3: 404, empty-log, non-object JSON, non-JSON, transport failure, and timeout each map to a distinct `ErrorKind`, one test per case.
- [ ] DW-3.4: A replay id containing a path separator is rejected before any fetch call is made, asserted by a fetch seam that fails the test if invoked.
- [ ] DW-3.5: `estimateTurns` returns the same value for a CRLF log and its LF equivalent.
- [ ] DW-3.6: `npm --prefix api test` passes; no test performs real network I/O.

**Difficulty:** HIGH
**Uncertainty:** Whether Node 26's fetch streaming lets the cap be enforced mid-stream as cleanly as intended; if not, the fallback is a documented buffer-then-check with the limitation stated, matching the iOS side's honesty about the same gap.

### Phase 4: Worker core
**Model:** sonnet
**Skills:** code-foundations:cc-defensive-programming -- the worker is where third-party payloads meet the engine; code-foundations:cc-routine-and-class-design
**Gate:** Standard
**Depends on:** Phase 1
**Unlocks:** none
**File scope:** `worker/**`

**Goal:** Implement the worker's engine-independent logic: configuration, the engine adapter's parameter mapping and lazy import, run telemetry, and failure classification, all testable without the compiled gen9 extension.

**Scope:**
- IN: environment-driven config with validation; `EngineAdapter` wrapping `analyze_replay` with the profile's parameters, importing `battle_engine` lazily inside the call; working-directory handling for the CWD-relative usage-stats path; a `RunTelemetry` record capturing wall time, per-turn wall time against the requested budget, the `samplesUsed` distribution, and the count of null-`winProbability` turns; classification of engine exceptions into the shared error vocabulary.
- OUT: the queue loop and database access (Phase 5); the Dockerfile (Phase 6); any change to `battle-engine`.

**Constraints:** `battle_engine.usage_stats.DEFAULT_STATS_DIR` is `Path("data/usage_stats")`, relative to the process working directory, and `analyze_replay` exposes no override, so the adapter must set or assert the working directory and fail with a clear message when the stats file is absent. The adapter must not import `poke_engine` at module import time.

**Edge cases:** `battle_engine` not importable at all; the usage-stats file missing, which surfaces as `FileNotFoundError` with the engine's own remediation message; `ReplayAnalysisError` and `ReplayParseError` distinguished from unexpected exceptions; a `BaseException` from the Rust extension, which the engine's own notes record as a real panic mode; a returned document whose turn count is zero; measured per-turn wall time exceeding the budget, recorded as degradation rather than raised as an error.

**Produces:** `worker/battle_cloud_worker/engine.py` exporting `EngineAdapter.analyze(payload: dict, identity: AnalysisIdentity) -> AnalysisRun`, where `AnalysisRun` carries `document: dict`, `telemetry: RunTelemetry`, and errors are raised as `EngineFailure(kind: ErrorKind, detail: str)`; `worker/battle_cloud_worker/config.py` exporting `WorkerConfig.from_env()`.

**Approach notes:** One search in flight per worker process, with `threads` sized to the cores that process owns -- required by the measured GIL behavior, and the reason concurrency comes from process count rather than a thread pool.

**File hints:** `../battle-engine/battle_engine/replay_analysis.py` -- the real signature, the `per_sample_ms` division, and the exception types; `../battle-engine/notes/gotcha-poke-engine-mcts-holds-the-gil.md` -- the concurrency rationale.

**Done when:**
- [ ] DW-4.1: `EngineAdapter.analyze` maps each profile to the exact keyword arguments `analyze_replay` declares, asserted against a fake injected in place of the real function.
- [ ] DW-4.2: Importing `worker/battle_cloud_worker/engine.py` succeeds in an environment with no `poke_engine` and no `battle_engine` installed.
- [ ] DW-4.3: A missing usage-stats file produces an `EngineFailure` whose detail includes the engine's own remediation command.
- [ ] DW-4.4: `ReplayAnalysisError`, `ReplayParseError`, a bare `BaseException`, and an unexpected `RuntimeError` each map to a distinct `ErrorKind`.
- [ ] DW-4.5: `RunTelemetry` records measured per-turn wall time and flags a run whose per-turn time exceeds its budget by more than a stated margin.
- [ ] DW-4.6: `WorkerConfig.from_env()` rejects a non-positive worker concurrency and a `threads` value exceeding the detected core count.
- [ ] DW-4.7: `python -m pytest worker/` passes with every DW above covered.

**Difficulty:** MEDIUM
**Uncertainty:** None; every constraint here was read directly from the engine's source this session.

### Phase 5: Database schema and job queue
**Model:** fable
**Skills:** code-foundations:ca-architecture-boundaries -- the schema is the seam both tiers depend on; code-foundations:cc-defensive-programming
**Gate:** Full
**Depends on:** Phase 1
**Unlocks:** none
**File scope:** `db/**`
**Rollback:** No destructive action; migrations are forward-only additions to an empty database, and every migration ships with its own `down` script.

**Goal:** Define the `replays`, `analyses`, and `jobs` tables, the unique constraint enforcing the analysis identity, and the `FOR UPDATE SKIP LOCKED` claim and lease-expiry queries, as reviewed SQL with a migration runner.

**Scope:**
- IN: numbered forward and reverse migration files; the three tables with their indexes; the unique constraint over the eight-field identity; the claim query, the heartbeat query, the lease-reclaim query, and the terminal-transition queries; a `README` in `db/` recording that none of it has been executed.
- OUT: executing any of it, which needs a Postgres this machine does not have; ORM or query-builder wiring in either tier.

**Constraints:** the identity unique constraint must include `seed` even though schema v1 omits it, or two analyses at different seeds become indistinguishable. Job claiming must be safe against two workers racing, and a worker that dies mid-job must have its job reclaimed by lease expiry rather than left running forever.

**Edge cases:** two workers claiming concurrently, where `SKIP LOCKED` must hand each a different row; a claimed job whose worker died, reclaimed only after its lease expires; a resubmission of an identity already `queued` or `running`, which must join the existing job instead of creating a second; an analysis row for an identity that already exists, which must be a conflict rather than a duplicate; `attempts` exceeding the cap, which moves the job to `failed` with a dead-letter reason.

**Produces:** `db/migrations/0001_initial.up.sql` and `.down.sql` defining the three tables; `db/queries/claim_job.sql`, `heartbeat.sql`, `reclaim_expired.sql`, `complete_job.sql`, `fail_job.sql`; `db/README.md` stating verification status.

**Approach notes:** Postgres `FOR UPDATE SKIP LOCKED` rather than Redis or a dedicated broker -- one fewer service to deploy, sufficient at this scale, and the resume argument for Redis was explicitly not the deciding factor.

**Done when:**
- [ ] DW-5.1: The unique constraint on `analyses` covers all eight identity fields including `seed`.
- [ ] DW-5.2: `claim_job.sql` uses `FOR UPDATE SKIP LOCKED`, orders deterministically, limits to one row, and sets `claimed_at`, `claimed_by`, and a lease expiry in the same statement.
- [ ] DW-5.3: `reclaim_expired.sql` returns a `running` job to `queued` only when its lease has expired and its `attempts` are under the cap, and moves it to `failed` with a dead-letter reason otherwise.
- [ ] DW-5.4: Every `.up.sql` has a matching `.down.sql` that drops exactly what it created.
- [ ] DW-5.5: `db/README.md` states plainly that no migration has been executed and names Postgres as the missing dependency.
- [ ] DW-5.6: Every SQL file parses under a syntax check that needs no live server.

**Difficulty:** HIGH
**Uncertainty:** The queries cannot be executed here, so correctness rests on review rather than on a passing test. This is the phase most likely to need a fix once a database exists, and `db/README.md` says so.

### Phase 6: Container definitions
**Model:** sonnet
**Skills:** code-foundations:code-clarity-and-docs -- the Dockerfile's gen9 guard needs its rationale inline or it will be removed as a slow build step
**Gate:** Minimal
**Depends on:** Phase 1
**Unlocks:** none
**File scope:** `docker/**`, `docker-compose.yml`, `.dockerignore`

**Goal:** Write the multi-stage worker image that builds gen9 poke-engine from pinned source and runs the gen9 guard test as a build step, the API image, and the compose file wiring both to Postgres.

**Scope:**
- IN: `docker/worker.Dockerfile` with a Rust and maturin builder stage, the pinned `v0.0.48` clone, the `gen9,terastallization` feature flags, the guard-test build step, a slim runtime stage, and the usage-stats file placed at the CWD-relative path the engine expects; `docker/api.Dockerfile`; `docker-compose.yml` for postgres, api, and N workers, configured entirely through environment variables; `.dockerignore`.
- OUT: building or running any of it; CI; deployment configuration.

**Constraints:** the guard step is not optional. `battle-engine`'s own notes record that the published PyPI wheel is gen4 and simulates gen9ou under gen4 mechanics with no error and no warning, so a build that fails loudly is the only defense. Terastallization is a separate Cargo feature and `gen9` alone does not enable it. No service may contain a hardcoded hostname; Postgres is reached through a single `DATABASE_URL`.

**Edge cases:** the usage-stats file is 13.7 MB and is not in this repo, so the Dockerfile must document where it comes from and fail clearly when it is absent at build time; `maturin` refuses to run when both `VIRTUAL_ENV` and `CONDA_PREFIX` are set, which the engine's own build script works around; the runtime stage must not carry the Rust toolchain.

**Produces:** `docker/worker.Dockerfile`, `docker/api.Dockerfile`, `docker-compose.yml`, `.dockerignore`, and a `docker/README.md` recording that no image has been built and naming the container runtime as the missing dependency.

**File hints:** `../battle-engine/scripts/build_poke_engine.sh` -- the authoritative build invocation, feature flags, pinned tag, and the guard test it runs.

**Done when:**
- [ ] DW-6.1: `docker/worker.Dockerfile` pins poke-engine to `v0.0.48` and passes `--no-default-features --features "poke-engine/gen9,poke-engine/terastallization"`.
- [ ] DW-6.2: The Dockerfile runs `tests/test_poke_engine_is_gen9.py` as a build step, with an inline comment stating why removing it is unsafe.
- [ ] DW-6.3: The runtime stage does not include cargo, rustup, or maturin.
- [ ] DW-6.4: `docker-compose.yml` contains no hardcoded hostname outside service names, and every tunable is an environment variable present in `.env.example`.
- [ ] DW-6.5: `docker/README.md` states that no image has been built and names the missing dependency.

**Difficulty:** MEDIUM
**Uncertainty:** The image cannot be built here, so DW-6.1 through DW-6.3 are verified by reading the file against the engine's build script rather than by a successful build.

---
## Test Coverage
**Level:** Targeted -- the TypeScript API pure layers (Phases 2 and 3) and the Python worker core (Phase 4) at 100% of their done-when items with real executed tests. Phases 1, 5, and 6 produce artifacts verified by inspection against a named source, because executing them requires system dependencies this machine does not have.

## Test Plan

**Phase 2 (contract), clean:**
- [ ] Each of the six real fixtures validates against `SchemaV1DocumentSchema` (DW-2.1).
- [ ] `identityKey` is order-independent across shuffled key insertion (DW-2.3).
- [ ] Each profile resolves to its documented engine parameters (DW-1.2 cross-check).

**Phase 2, dirty:**
- [ ] `schemaVersion: 2` rejected with the version named (DW-2.2).
- [ ] `schemaVersion` absent entirely, rejected.
- [ ] Unknown profile, invalid perspective, replay id with `/` and with `..` each rejected (DW-2.4).
- [ ] Two identities differing only in `seed` produce different keys (DW-2.3).

**Phase 3 (replay client), clean:**
- [ ] `estimateTurns` matches the recorded `totalTurns` for all six fixture replays (DW-3.1).
- [ ] A well-formed payload under the cap returns a parsed `ReplayPayload`.
- [ ] `estimateDuration` scales with turn count and differs between profiles.

**Phase 3, dirty:**
- [ ] Oversized body rejected mid-stream, with a fake stream that would exhaust memory if drained (DW-3.2).
- [ ] Body exactly at the cap accepted; one byte over rejected (boundary).
- [ ] 404, empty log, non-object JSON, non-JSON body, transport failure, timeout, each to a distinct `ErrorKind` (DW-3.3).
- [ ] Unsafe replay id rejected with the fetch seam asserting it was never called (DW-3.4).
- [ ] CRLF and LF logs estimate identically (DW-3.5).
- [ ] Log with zero `|turn|` lines returns zero rather than throwing.

**Phase 4 (worker core), clean:**
- [ ] Each profile maps to the exact `analyze_replay` keyword arguments (DW-4.1).
- [ ] Module imports with neither `poke_engine` nor `battle_engine` present (DW-4.2).
- [ ] `RunTelemetry` records wall time, per-turn time, `samplesUsed` distribution, and null-`winProbability` count.

**Phase 4, dirty:**
- [ ] Missing usage-stats file surfaces the engine's own remediation command (DW-4.3).
- [ ] `ReplayAnalysisError`, `ReplayParseError`, `BaseException`, and `RuntimeError` map to four distinct kinds (DW-4.4).
- [ ] A run exceeding its per-turn budget by the stated margin is flagged as degraded (DW-4.5).
- [ ] A returned document with zero turns handled without raising.
- [ ] Zero, negative, and over-core-count concurrency values rejected by config (DW-4.6, boundary).

**Phases 1, 5, 6 (inspection):**
- [ ] Manual: `db/queries/claim_job.sql` read line by line against DW-5.2's four requirements.
- [ ] Manual: `docker/worker.Dockerfile` diffed against `../battle-engine/scripts/build_poke_engine.sh` for tag, features, and guard test (DW-6.1, DW-6.2).
- [ ] Manual: every `.up.sql` paired with a `.down.sql` dropping exactly what it created (DW-5.4).

## Assumptions

| Assumption | Confidence | Verify Before Phase | Fallback If Wrong |
|---|---|---|---|
| `\|turn\|` line count equals `totalTurns` | Verified 2026-09-06, 6/6 replays, by DW-3.1's own test | -- | -- |
| Node 26's fetch exposes a readable stream allowing a mid-stream byte cap | Verified 2026-09-06; `readCapped` cancels the stream at the ceiling and a test proves an unbounded producer is not drained | -- | -- |
| `analyze_replay` takes **seven** keyword-only parameters, `replay_id` included | Verified 2026-09-06 against `replay_analysis.py:366` | -- | -- |
| `threads` affects aggregation and therefore belongs in the identity | Medium | Phase 5 | Dropping it from the constraint is a forward-only migration |
| The user will install a container runtime and Postgres before end-to-end work | Medium | after Phase 6 | The unverified phases stay unverified and the README keeps saying so |

## Decision Log

| Decision | Alternatives Considered | Rationale | Phase |
|---|---|---|---|
| Pure logic first, infrastructure second | Infrastructure-first per the scoping doc | No container runtime here; infrastructure-first would leave nothing tested | all |
| Postgres `SKIP LOCKED` for the queue | Redis, SQS, a dedicated broker | One fewer service; sufficient at this scale; the resume argument for Redis was deliberately not decisive | 5 |
| Server fetches replays by id | Client uploads the payload it already has | Keeps analyses cache-keyed and shareable; stops a client handing the service a blob to burn CPU on | 3 |
| Named profiles on the wire | Raw millisecond parameters | A client must not choose the server's CPU budget | 2 |
| `seed` in the identity despite schema v1 omitting it | Trust the document's own `engine` block | Two analyses at different seeds are otherwise indistinguishable | 2, 5 |
| No turn-level sharding | Reimplement the driver loop here | Would duplicate grading logic hardened over three security reviews upstream | 4 |
| Lazy `poke_engine` import in the adapter | Import at module load | Keeps the worker's own logic testable with no compiled extension | 4 |
| No git operations | Init and commit per phase as build normally does | The parent `CLAUDE.md` reserves git for the user, and the enclosing repo is the vault | all |

---
## Notes

- **The `EngineService` seam has no pending state.** `analysis(forReplayId:) async throws -> ReplayAnalysis?` is a two-outcome contract and hosted analysis has three. The resolution, recorded in the scoping doc section 2.1, is to preserve the signature literally with a submit-and-poll client and add progress through a separate additive protocol. Not in this plan's scope; it is the iOS phase.
- **Total visit counts are not recoverable by a caller.** `analyze_replay` normalizes to `visitShare` before returning. The observable degradation proxies are per-turn wall time against budget, the `samplesUsed` distribution, and null-`winProbability` counts. Phase 4 records those.
- **Two additive upstream proposals** worth making to `battle-engine` later, neither implemented here: a `progress_callback` kwarg, and a turn-range argument that would make sharding possible without duplicating the driver loop.
- **Open question for the user:** installing Docker Desktop or Colima, plus Postgres, is the single step that unblocks verification of Phases 5 and 6 and all of the scoping doc's Phases 1, 2, 4, and 7.

---
## Execution Log

### 2026-09-06 — Phases 1 through 4 built, 53 tests passing

Built inline rather than through build's subagent dispatch, and **not committed**: this
directory is not yet its own git repository and the parent `CLAUDE.md` reserves git for the
user.

| Phase | State | Evidence |
|---|---|---|
| 1. Skeleton and vocabulary | done | `docs/contract.md`, `README.md`, `.env.example`, both manifests |
| 2. API contract layer | done | 16 tests; all six real fixtures validate; `tsc --noEmit` clean |
| 3. Replay client and estimator | done | 13 tests; turn estimate exact on 6/6 replays; cap proven mid-stream |
| 4. Worker core | done | 24 tests; no engine or extension needed to run them |
| 5. Database schema and queue | done, executed | 31 tests against Postgres 16.15, including a two-connection SKIP LOCKED race |
| 6. Container definitions | done, built | 439 MB image, gen9 guard `9 passed` in-build, compose stack verified |

**Two findings that changed the code, both from the CHECK review:**

- `analyze_replay` declares **seven** keyword-only parameters, not six. `replay_id` is the
  fallback used when a payload carries no `"id"` of its own; dropping it would have made
  every id-less payload analyze as `"unknown"`.
- `default_usage_stats` is `@lru_cache`d on `(format_id, cutoff, stats_dir)` where
  `stats_dir` is the **relative** `Path("data/usage_stats")`. Two different working
  directories therefore produce the same cache key, so a process that chdir'd between
  analyses would silently receive stats parsed under the old directory. `EngineAdapter`
  pins the working directory once at construction and asserts it before every call rather
  than setting it per call, which would have caused the bug instead of preventing it.

**One finding that changed the plan rather than the code:** `profile` was listed in Phase 1's
`AnalysisIdentity` but excluded from the identity everywhere else. `docs/contract.md` had
already resolved it correctly, so the plan was corrected to match the document.

**A test caught a real defect in its own scraper:** `test_contract_agreement` initially read
every table in `docs/contract.md` and picked up `quick` from the profiles table. Scoped to the
error-kinds section.

### Review findings still open

From the CHECK pass, not yet acted on:

- **S14, cross-repo fixtures.** `api/test/` reads `../battle-brain/BattleBrain/Resources/`.
  That works here and will fail in CI, which will not have the sibling checkout. The six
  analysis documents and six replay payloads should be copied in with a provenance note.
- **S2.** Phase 6's DW-6.4 requires editing `.env.example`, which is outside its file scope.
- **S3.** Phase 4's OUT defers the queue loop to Phase 5, which does not produce one. It
  belongs to a later plan; the Context should say so.
- **S6, S7.** Phase 6's gate is Minimal on the artifact carrying the gen9 guard, which is the
  plan's highest-consequence unverifiable file. Phase 4 is not marked security-sensitive
  despite its own skills line saying it should be.
- **S8, S9, S10.** Phases 1, 5, and 6 have 3 of 15 done-when items covered by the test plan;
  Phase 5's five edge cases reach no test entries and it has no file hints and no
  positional-placeholder requirement.
- **S13.** Nothing in this plan produces user-observable output. A small script printing a
  local replay's turn count and both profiles' ETAs would fix it inside Phase 3's existing
  scope.
- **S19.** The scope doc requires the ~13.7 MB usage-stats cold-start parse to be measured
  rather than assumed. It cannot be measured without the engine installed; recorded as
  deferred rather than dropped.


### 2026-09-06, later — the infrastructure constraint was lifted, so Phases 5 and 6 became executable

The user authorized installing a container runtime and Postgres. Installed: Colima, the Docker
CLI, buildx, the compose plugin, and PostgreSQL 16.15. Everything the plan had marked
"reviewed but unverified" is now executed.

**The scoping doc's biggest risk is retired.** `docker/worker.Dockerfile` builds poke-engine's
Rust extension from pinned `v0.0.48` source with `--no-default-features --features
"poke-engine/gen9,poke-engine/terastallization"`, and the gen9 guard reports `9 passed` as a
build step rather than skipping. Image is 439 MB. A real analysis of `gen9ou-2672927429`
inside the container produced a schema-v1 document, 24 turns, 16 gradable, in 7.6 s at the
`quick` profile.

**The worker's queue loop was written and tested**, which the plan had deferred to a later
plan. `worker/battle_cloud_worker/queue.py` claims a job, loads its replay, analyzes, stores
the document, and completes or fails it, with a background heartbeat renewing the lease and
an idle worker doing the reclaim pass rather than a separate service.

**Test counts:** 29 API, 34 worker, 31 database. 94 total.

### Three defects this stretch found in work from the earlier one

**The degradation model was wrong and fired on every healthy run.** It flagged a run degraded
above `1.5x` of the search budget. Measured in the container at three budgets, the excess over
budget is about 60 ms per opponent sample, not a multiple of the budget: 118.3 ms at 2 samples,
245.8 at 4, 482.0 at 8, agreeing within 3%. The flat-ratio model appeared to fit only because
the two shipped profiles scale samples with budget in lockstep, and two points cannot separate
a proportional model from an affine one. The healthy baseline is 1.48x-1.59x, so the threshold
sat exactly on it. Now `budget + samples * 60ms` with a 1.25 margin, with a regression test
asserting all three measured healthy runs are not flagged. See
`notes/gotcha-engine-overhead-is-per-sample-not-a-flat-ratio.md`.

**The worker's SQL path did not survive containerization.** `queue.py` resolved `db/queries`
as `parents[2]`, correct in a checkout and wrong in the image, where the package is installed
into site-packages. Fixed with a `QUERIES_DIR` environment variable the image sets.

**Two Docker builds were reported as succeeding when they had failed**, because the command
was piped into `tail`, which returns `tail`'s exit status. The first failure was the legacy
builder rejecting `--build-context`, the second a stale `credsStore: desktop` in
`~/.docker/config.json` pointing at a Docker Desktop that is not installed. Both are recorded
alongside the `importorskip` finding in
`notes/gotcha-importorskip-makes-a-build-time-guard-vacuous.md`, since all three are the same
shape: a check that reports success for the case it exists to catch.

### Review findings closed this stretch

- **S10** (Phase 5 had no SQL-injection requirement): `db/tests/test_schema.py` now asserts no
  query file interpolates a value.
- **S18** (the relative-path `lru_cache`): implemented in `EngineAdapter` and written up as a
  gotcha note.
- **S19** (cold-start cost deferred as unmeasurable): now measurable, though not yet measured
  separately from total wall time.

Still open: **S14** (tests read fixtures from `../battle-brain`, which CI will not have),
**S2**, **S3**, **S6**, **S7**, **S8**, **S13**.
