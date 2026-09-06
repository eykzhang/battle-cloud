# battle-cloud

Puts [`battle-engine`](../battle-engine) behind a network API. Submit a Pokemon Showdown replay
id, get back a per-turn win-probability analysis computed by the real engine. A React and
TypeScript web client is the second half; `battle-brain`, the iOS app, is a second client whose
`EngineService` protocol was designed as a seam for exactly this.

## Status

Foundation in progress. The pure logic layers of both tiers are built and tested. The database
schema and the container definitions exist as reviewed artifacts that have never been executed.

| Piece | State |
|---|---|
| `docs/contract.md` | written |
| `api/src/contract/` | built, tested |
| `api/src/replay/` | built, tested |
| `worker/battle_cloud_worker/` | built, tested |
| `db/` | written, never executed |
| `docker/` | written, never built |
| web client | not started |
| deployment | not started |

## What is missing to run any of this end to end

Neither dependency is installed on the development machine as of 2026-09-06:

- **A container runtime** (Docker Desktop or Colima). The worker image builds `poke-engine`'s
  Rust extension from pinned source, which is the one step that can fail for reasons outside
  this repo.
- **Postgres.** Every migration and queue query in `db/` is unverified until there is a database
  to run them against.

## Repository setup

This directory is not yet its own git repository. When initializing it:

```
git init
printf 'CLAUDE.md\nnotes/\noverview.md\n' >> .git/info/exclude
```

The vault artifacts go in `.git/info/exclude` rather than `.gitignore`, because the exclusion is
personal to this working copy rather than something the repository should carry. See the parent
`../CLAUDE.md`.

## Layout

```
api/      TypeScript gateway (Fastify). Accepts jobs, serves analyses.
worker/   Python worker. One engine search in flight per process.
db/       Schema, migrations, and the SKIP LOCKED queue queries.
docker/   Image definitions, including the gen9 poke-engine build.
docs/     The contract both tiers implement.
```
