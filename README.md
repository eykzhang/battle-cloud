# battle-cloud

Puts [`battle-engine`](../battle-engine) behind a network API. Submit a Pokemon Showdown replay
id, get back a per-turn win-probability analysis computed by the real engine. A React and
TypeScript web client is the second half; `battle-brain`, the iOS app, is a second client whose
`EngineService` protocol was designed as a seam for exactly this.

## Status

It works end to end over HTTP. `POST /v1/analyses` with a replay id fetches that replay from
Showdown, queues a job, and a containerized worker running the real engine produces a
schema-v1 analysis document that `GET /v1/analyses/{id}` serves back. Resubmitting the same
identity returns the cached analysis rather than spending another core-minute.

Not built: the React web client, and any deployment. Nothing has a public URL.

| Piece | State |
|---|---|
| `docs/contract.md` | written |
| `api/src/contract/` | built, 16 tests |
| `api/src/replay/` | built, 13 tests |
| `api/src/store.ts`, `ratelimit.ts` | built |
| `worker/battle_cloud_worker/` | built, 34 tests, runs in the image |
| `db/` | applied to Postgres 16.15, 31 tests |
| `docker/worker.Dockerfile` | builds, 439 MB, gen9 guard passing |
| `docker-compose.yml` | postgres + migrate + worker, verified |
| `api/src/routes.ts` | built, 12 route tests against real Postgres |
| `docker/api.Dockerfile` | written |
| web client | not started |
| deployment | not started |

## Try it

Needs a container runtime (Colima or Docker Desktop) and a `battle-engine` checkout beside
this one.

```
cp .env.example .env
docker compose build
docker compose up -d postgres
docker compose --profile migrate run --rm migrate
docker compose up -d api worker

curl -X POST localhost:8080/v1/analyses \
  -H 'content-type: application/json' \
  -d '{"replayId":"gen9ou-2672927429","perspective":"p2","profile":"quick"}'
# -> 202 {"jobId": "...", "status": "queued", "estimatedTurns": 24, ...}

curl localhost:8080/v1/jobs/<jobId>          # poll until succeeded
curl localhost:8080/v1/analyses/<analysisId> # the schema-v1 document
```

A `quick` analysis of a 24-turn replay takes about 8 seconds. `ladder-parity`, which matches
the settings the iOS app's bundled fixtures were generated under, takes about 36 seconds for
the same replay and a little over two minutes for a 93-turn one.

## API

| Route | Behavior |
|---|---|
| `POST /v1/analyses` | 200 with the analysis if this identity is already computed, else 202 with a job handle. Resubmitting a live identity joins its job. |
| `GET /v1/analyses/{analysisId}` | The envelope: `analysisId`, `seed`, `createdAt`, and the untouched schema-v1 `document`. |
| `GET /v1/jobs/{jobId}` | Status, estimated turns, estimated search time, and the analysis id once it exists. |
| `GET /healthz`, `GET /readyz` | Liveness, and liveness plus a database round trip. |

Clients name a `profile` (`ladder-parity` or `quick`) rather than sending search parameters,
so no caller picks how much CPU this server spends. `docs/contract.md` has the expansions,
the eight-field analysis identity, the job states, and the error vocabulary.

## Tests

```
createdb battlecloud
DATABASE_URL=postgres:///battlecloud python db/migrate.py up

npm --prefix api install && npm --prefix api test                     # 41
DATABASE_URL=postgres:///battlecloud python -m pytest -q              # 65
```

Both suites need a local Postgres with the migration applied, and neither mocks it. `SKIP
LOCKED` in particular cannot be verified by reading SQL, so it is executed across two real
connections, and the route tests run against real rows rather than a fake store. Nothing in
either suite touches the network: the Showdown client is exercised through an injected fetch.

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
