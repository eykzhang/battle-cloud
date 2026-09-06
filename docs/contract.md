# The contract

The vocabulary both tiers implement. Changes here are changes to the wire format and to the
database's unique constraints, so they are not local edits.

## Profiles

A client names a profile. It never sends raw search parameters, because a client must not be
able to choose how much CPU the server spends. Each profile maps to keyword arguments of
`battle_engine.replay_analysis.analyze_replay`.

| Profile | `search_time_ms` | `n_opponent_samples` | `threads` | `usage_stats_cutoff` | `seed` |
|---|---:|---:|---:|---:|---:|
| `ladder-parity` | 1000 | 8 | 4 | 1500 | 0 |
| `quick` | 200 | 2 | 4 | 1500 | 0 |

`ladder-parity` reproduces the settings the six bundled `battle-brain` fixtures were generated
under, so an analysis served by this API is comparable to one shipped in the app.

`search_time_ms` is the whole per-turn budget and the engine divides it across samples
(`per_sample_ms = max(1, search_time_ms // n_opponent_samples)`). At `ladder-parity` that is
125 ms per sample. A 93-turn replay is therefore about 93 seconds of search.

## Analysis identity

Eight fields. This tuple is the cache key and the unique constraint on the `analyses` table.

```
replayId              Showdown replay id, e.g. "gen9ou-2672899958"
perspective           "p1" | "p2"
searchBudgetMsPerTurn integer
opponentSamples       integer
threads               integer
usageStatsCutoff      integer
pokeEngineTag         string, e.g. "v0.0.48"
seed                  integer
```

Seven of these appear in the analysis document, six inside its `engine` block plus `perspective`
and `replayId` at the top level. **`seed` does not.** `EngineConfiguration` in
`battle-brain/BattleBrain/Core/EngineService.swift` carries five fields and none of them is the
seed, so two analyses of the same replay at different seeds are indistinguishable from the JSON
alone. battle-cloud stores it separately. Dropping it from the identity would let a re-analysis
either collide with an existing row or create a duplicate nothing can tell apart.

`threads` is in the identity because aggregation across a time-budgeted multi-threaded search
has not been measured to be thread-count invariant. Keeping it costs nothing and avoids
asserting an invariance nobody has checked.

`profile` is not itself in the identity. It is a shorthand that expands into the parameters
above, so two profiles that happened to expand identically would correctly share one analysis.

## Job states

```
queued -> running -> succeeded
                  -> failed
queued -> cancelled
running -> queued        (lease expired, attempts under the cap)
running -> failed        (lease expired, attempts at the cap: dead letter)
```

A job is claimed with `FOR UPDATE SKIP LOCKED`, which hands two racing workers different rows.
A claim sets a lease expiry; a worker that dies has its job reclaimed when that lease expires
rather than leaving it `running` forever.

Submitting an identity that is already `queued` or `running` joins the existing job. It does not
create a second one.

## Error kinds

One closed vocabulary, shared by the API and the worker, so a failure that starts in a worker
reaches a client without being reclassified along the way.

**Replay acquisition** (API tier, fetching from Showdown):

| Kind | Meaning |
|---|---|
| `invalid_replay_id` | Failed the safe-character rule before any request was made |
| `replay_not_found` | Showdown returned 404 |
| `replay_empty_log` | 200 with no usable `log`, the shape a private replay returns |
| `replay_too_large` | Body exceeded the byte cap |
| `replay_malformed` | Not JSON, or JSON that is not an object |
| `replay_transport_failure` | Failed below the HTTP layer |
| `replay_timeout` | Request exceeded the timeout |

**Analysis** (worker tier):

| Kind | Meaning |
|---|---|
| `engine_unavailable` | `battle_engine` or `poke_engine` not importable |
| `engine_data_missing` | Cached usage-stats file absent for the requested cutoff |
| `analysis_rejected` | `ReplayAnalysisError` — the engine refused the payload or the parameters |
| `analysis_parse_failed` | `ReplayParseError` — the replay log could not be parsed |
| `engine_crashed` | A `BaseException` escaping the Rust extension |
| `engine_internal_error` | Any other unexpected exception |

**Request** (API tier):

| Kind | Meaning |
|---|---|
| `unknown_profile` | Profile name not in the registry |
| `invalid_request` | Failed schema validation |
| `rate_limited` | Submission rate cap exceeded for this address |
| `analysis_not_found` | No analysis for the requested id or identity |

## Documents are passed through, never rewritten

`schemaVersion` is `1` and `battle-brain`'s decoder rejects anything else. The API serves the
engine's document byte-faithfully inside an envelope that carries the identity fields the
document omits. Nothing is added inside the document, and `topActions` is never truncated:
truncating it would stop `visitShare` summing to approximately 1 and quietly break any consumer
treating it as a distribution. Large documents are compressed on the wire instead.

The API version (`/v1`) and the document's `schemaVersion` are independent. Neither implies the
other.
