# battle-cloud

Puts [`battle-engine`](../battle-engine) behind a network API. Submit a Pokemon Showdown replay
id, get back a per-turn win-probability analysis computed by the real engine. A React and
TypeScript web client is the second half; `battle-brain`, the iOS app, is a second client whose
`EngineService` protocol was designed as a seam for exactly this.

## Status

The worker half runs end to end. Submit a job against a stored replay and a containerized
worker produces a real schema-v1 analysis document and stores it. The API tier has its typed
contract and its Showdown client but no HTTP server yet, so nothing is reachable over a
network.

| Piece | State |
|---|---|
| `docs/contract.md` | written |
| `api/src/contract/` | built, 16 tests |
| `api/src/replay/` | built, 13 tests |
| `worker/battle_cloud_worker/` | built, 34 tests, runs in the image |
| `db/` | applied to Postgres 16.15, 31 tests |
| `docker/worker.Dockerfile` | builds, 439 MB, gen9 guard passing |
| `docker-compose.yml` | postgres + migrate + worker, verified |
| API HTTP server | not started |
| web client | not started |
| deployment | not started |

## Try it

Needs a container runtime (Colima or Docker Desktop) and a `battle-engine` checkout beside
this one.

```
cp .env.example .env
docker compose build worker
docker compose up -d postgres
docker compose --profile migrate run --rm migrate
docker compose up worker
```

The worker polls for jobs. Nothing enqueues one yet without the API, so insert a replay row
and a job row by hand to watch it work; `db/README.md` has the schema.

## Tests

```
npm --prefix api install && npm --prefix api test          # 29
DATABASE_URL=postgres:///battlecloud python -m pytest db/tests worker/tests -q   # 65
```

The database tests need a local Postgres and an applied migration. They are not mocked: the
`SKIP LOCKED` behavior in particular cannot be verified by reading SQL, so it is executed
across two real connections.

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
