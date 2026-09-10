# battle-cloud

Puts [`battle-engine`](../battle-engine) behind a network API. Submit a Pokemon Showdown replay
id, get back a per-turn win-probability analysis computed by the real engine. A React and
TypeScript web client is the second half; `battle-brain`, the iOS app, is a second client: its `HostedEngineService` implements the
`EngineService` seam over this API, though that app still ships bundled fixtures by default.

## Status

Deployed and public since 2026-09-10:

```
https://m6tky2d13e.execute-api.us-east-2.amazonaws.com
```

159 tests: 73 in the API tier, 86 in Python. `POST /v1/analyses` with a replay id fetches that
replay from Showdown, queues a job, and starts a Fargate worker that runs the real gen9 engine
and produces a schema-v1 analysis document that `GET /v1/analyses/{id}` serves back.
Resubmitting the same identity returns the cached analysis rather than spending another
core-minute. Measured end to end through the public URL: 26.7 s from submit to served analysis
for a 24-turn replay, of which 17.4 s is Fargate scheduling and 8.6 s is the engine.

The React web client is built and deploys to Cloudflare from `web/`.

| Piece | State |
|---|---|
| `docs/contract.md` | written |
| `api/src/contract/` | built, 17 tests |
| `api/src/replay/` | built, 13 tests |
| `api/src/store.ts` | built |
| `api/src/ratelimit.ts` | built on Postgres, shared across instances, 6 tests |
| `api/src/worker.ts` | starts a Fargate worker on submission, 11 tests |
| `api/src/lambda.ts` | the deployed entrypoint, 7 tests |
| `worker/battle_cloud_worker/` | built, 50 tests, polls or drains, runs in the image |
| `db/` | three migrations, on Neon in production, 36 tests |
| `docker/worker.Dockerfile` | builds, 103 MB pulled, gen9 guard passing |
| `docker/migrate.Dockerfile` | builds, 56 MB pulled, no engine |
| `docker/api.Dockerfile` | builds, 82 MB pulled, what compose runs |
| `docker-compose.yml` | postgres + migrate + api + worker, verified |
| `infra/` | Terraform: Lambda, HTTP API, ECS, ECR, OIDC, networking, scheduler |
| CI | tests, three image builds, gen9 guard, ECR mirror, and the API deploy |
| `web/` | React and TypeScript over Vite, on Cloudflare Workers |

## Try it

Against the deployed service, with nothing installed:

```
API=https://m6tky2d13e.execute-api.us-east-2.amazonaws.com

curl -X POST "$API/v1/analyses" \
  -H 'content-type: application/json' \
  -d '{"replayId":"gen9ou-2672927429","perspective":"p2","profile":"quick"}'
# -> 202 {"jobId": "...", "status": "queued", "estimatedTurns": 24, ...}
# -> 200 with the analysis, if this identity was already computed

curl "$API/v1/jobs/<jobId>"          # poll until succeeded
curl "$API/v1/analyses/<analysisId>" # the schema-v1 document
```

Submissions are limited to 20 an hour per address, since each one costs a Fargate minute.

Locally, which needs a container runtime and a `battle-engine` checkout beside this one:

```
cp .env.example .env
docker compose build
docker compose up -d postgres
docker compose --profile migrate run --rm migrate
docker compose up -d api worker
```

A `quick` analysis of a 24-turn replay takes about 8 seconds of engine time. `ladder-parity`,
which matches the settings the iOS app's bundled fixtures were generated under, takes about 36
seconds for the same replay and a little over two minutes for a 93-turn one.

## API

| Route | Behavior |
|---|---|
| `GET /v1/analyses` | A page of recent analyses, newest first, as summaries rather than documents. `limit` up to 50 and an opaque `cursor`. |
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

npm --prefix api install && npm --prefix api test                     # 73
DATABASE_URL=postgres:///battlecloud python -m pytest -q              # 86
```

Both suites need a local Postgres with the migration applied, and neither mocks it. `SKIP
LOCKED` in particular cannot be verified by reading SQL, so it is executed across two real
connections, and the route tests run against real rows rather than a fake store. Nothing in
either suite touches the network: the Showdown client is exercised through an injected fetch.

## Deployment

The API is a Lambda function behind an API Gateway HTTP API, in `us-east-2`. The worker is a
Fargate task the API starts when a submission queues a job, which drains the queue and exits;
an EventBridge schedule runs one hourly as a floor. Postgres is Neon, outside AWS. Everything
except the database is Terraform in `infra/`, applied from a laptop.

App Runner was the original target for the API and is not used: it returns
`SubscriptionRequiredException` on this account in every region, from an admin principal, with
a verified payment method, while every other service accepts the same credentials. Lambda is
also the cheaper shape, at roughly $0.07 per thousand analyses served against a few dollars a
month to idle. `infra/README.md` has the details and the arithmetic.

A push to `main` runs the tests, publishes three images, mirrors them to ECR, and deploys the
API by building the bundle and calling `update-function-code`. Terraform owns the function's
configuration; CI owns only its code.

The web client is the one piece outside AWS: Cloudflare builds and serves it from the same push,
with no workflow of ours and no bucket to configure. `web/README.md` has the settings and
`notes/decision-cloudflare-pages-for-the-web-client.md` the reasoning.

```
cd infra
AWS_PROFILE=tf terraform apply     # infrastructure
npm --prefix api run bundle        # the Lambda artifact, if deploying by hand
```

## Repository setup

The vault artifacts (`CLAUDE.md`, `notes/`, `overview.md`) are excluded through
`.git/info/exclude` rather than `.gitignore`, because the exclusion is personal to this
working copy rather than something the repository should carry. See the parent `../CLAUDE.md`.

## Layout

```
api/      TypeScript gateway (Fastify). Accepts jobs, serves analyses.
web/      React and TypeScript client. Submit, watch, read the eval curve.
worker/   Python worker. One engine search in flight per process.
db/       Schema, migrations, and the SKIP LOCKED queue queries.
docker/   Image definitions, including the gen9 poke-engine build.
docs/     The contract both tiers implement.
```
