# Images

## Status

`docker/worker.Dockerfile` builds and runs. Verified 2026-09-06 on Colima 4 CPU / 6 GB with
Docker 29.5.2 and buildx 0.37.0: image 439 MB, the gen9 guard reports `9 passed` during the
build, and a real analysis of `gen9ou-2672927429` inside the container produced a schema-v1
document with 24 turns and 16 gradable in 7.6 seconds at the `quick` profile.

There is no API image yet, because the API tier has no server yet.

## Building

Two named build contexts, so neither sibling repo has to be vendored into this one:

```
docker buildx build -f docker/worker.Dockerfile \
  --build-context engine=../battle-engine \
  -t battle-cloud-worker:dev --load .
```

`engine` supplies the `battle_engine` package, the gen9 guard test, and the 13.7 MB cached
usage-stats file, none of which are on PyPI. `docker build` (the legacy builder) does not
support `--build-context` and will reject this; buildx is required.

## The gen9 guard, and why the bare import in front of it is not redundant

poke-engine picks its generation at compile time via Cargo features, and the published PyPI
wheel is a **gen4** build. A gen4 build accepts a gen9ou state and simulates it under gen4
mechanics with no error and no warning: wrong damage, wrong abilities, no Terastallization.
`pip install poke-engine` is never correct here.

The image therefore builds from pinned source (`v0.0.48`, `--no-default-features --features
"poke-engine/gen9,poke-engine/terastallization"`) and runs `test_poke_engine_is_gen9.py` as
a build step. Do not remove that step to speed up the build.

The `python -c "import poke_engine"` ahead of it is load-bearing. That test file opens with
`pytest.importorskip("poke_engine")`, so if the wheel failed to install pytest would skip
every test and exit 0, and the build step would pass while proving nothing. See
`notes/gotcha-importorskip-makes-a-build-time-guard-vacuous.md`.

## Two things the runtime stage gets right on purpose

`WORKDIR /app` with the usage-stats file at `/app/data/usage_stats/`, because
`battle_engine.usage_stats.DEFAULT_STATS_DIR` is the relative `Path("data/usage_stats")` and
`analyze_replay` exposes no override.

`QUERIES_DIR=/app/db/queries`, because the worker package is pip-installed into
site-packages where its repo-relative fallback path for the `.sql` files does not exist.

## Compose

```
cp .env.example .env
docker compose --profile migrate run --rm migrate
docker compose up worker
```

Keep `WORKER_CONCURRENCY x ENGINE_THREADS` at or under the host's core count. The worker
refuses to start otherwise, because a wall-clock-budgeted search degrades in quality rather
than in speed when starved.
