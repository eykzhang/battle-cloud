# syntax=docker/dockerfile:1.7
#
# The battle-cloud worker image.
#
# Built with two named build contexts so neither sibling repo has to be vendored:
#
#   docker build -f docker/worker.Dockerfile \
#     --build-context engine=../battle-engine \
#     -t battle-cloud-worker .
#
# `engine` is the battle-engine checkout. It supplies the Python package, the gen9
# guard test, and the cached usage-stats file, none of which are on PyPI.

# ---------------------------------------------------------------------------
# Stage 1: compile poke-engine's Rust extension for gen9.
#
# `pip install poke-engine` is NEVER correct here. poke-engine selects its
# generation at COMPILE time via Cargo features and the published PyPI wheel is a
# gen4 build. A gen4 build accepts a gen9ou state and simulates it under gen4
# mechanics with no error and no warning: wrong damage, wrong abilities, no
# Terastallization. Terastallization is a separate feature on top of gen9; `gen9`
# alone does not imply it.
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS engine-builder

ARG POKE_ENGINE_TAG=v0.0.48
ARG POKE_ENGINE_REPO=https://github.com/pmariglia/poke-engine.git

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

RUN pip install --no-cache-dir maturin

WORKDIR /build
RUN git clone --depth 1 --branch ${POKE_ENGINE_TAG} ${POKE_ENGINE_REPO} poke-engine

# Feature flags copied from battle-engine/scripts/build_poke_engine.sh, which is the
# authoritative recipe. `maturin build` rather than `maturin develop`: this stage
# produces a wheel for the runtime stage to install, and develop would install into
# a venv that gets thrown away with the stage.
WORKDIR /build/poke-engine/poke-engine-py
RUN maturin build --release \
      --no-default-features \
      --features "poke-engine/gen9,poke-engine/terastallization" \
      --out /wheels

# ---------------------------------------------------------------------------
# Stage 2: the engine, installed and proven to be gen9.
#
# A separate stage from the runtime below, and deliberately so: nothing here needs the
# 13.7 MB usage-stats file, which is gitignored in battle-engine and therefore absent
# from a fresh clone. That makes this stage buildable from public sources alone, so CI
# can run the gen9 guard with `--target engine-verified` even though it cannot assemble
# a complete worker image.
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS engine-verified

WORKDIR /app

COPY --from=engine-builder /wheels/*.whl /tmp/wheels/
RUN pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels

# battle-engine is not on PyPI. Only the package, its manifest, and the guard test are
# copied: the ML extras (torch, stable-baselines3) are not in the replay-analysis import
# graph and would multiply the image size for nothing.
COPY --from=engine pyproject.toml /tmp/engine/pyproject.toml
COPY --from=engine battle_engine /tmp/engine/battle_engine
COPY --from=engine tests/test_poke_engine_is_gen9.py /tmp/engine/tests/test_poke_engine_is_gen9.py
RUN pip install --no-cache-dir /tmp/engine && pip install --no-cache-dir pytest

# The gen9 guard. Never remove this to speed up the build: the failure it catches is
# silent, so an image that skips it can serve gen4 results for months while looking
# healthy.
#
# The bare import runs FIRST and is not redundant. test_poke_engine_is_gen9.py opens with
# `pytest.importorskip("poke_engine")`, which is right for a developer checkout and wrong
# here: if the extension failed to install, pytest would SKIP every test and exit 0, and
# this build step would pass while proving nothing. The import fails hard instead.
RUN python -c "import poke_engine; print('poke_engine imported:', poke_engine.__file__)" \
 && python -m pytest /tmp/engine/tests/test_poke_engine_is_gen9.py -q --no-header \
 && rm -rf /tmp/engine

# ---------------------------------------------------------------------------
# Stage 3: the runnable worker. No Rust toolchain, no maturin, no build-essential.
# ---------------------------------------------------------------------------
FROM engine-verified AS runtime

# The dataset is the month, and the file name is derived from it rather than given
# independently, so the value baked into USAGE_STATS_DATASET below cannot disagree with
# the file actually copied in. That pair is what the analysis identity records, and a
# disagreement would label analyses with a prior they were not computed against.
ARG USAGE_STATS_DATASET=2026-07
ARG USAGE_STATS_SELECTOR=gen9ou-1500
ARG USAGE_STATS_FILE=${USAGE_STATS_DATASET}_${USAGE_STATS_SELECTOR}.json

# Re-declared because ARG scope is per stage: POKE_ENGINE_TAG was consumed by the builder
# and has to be named again here to reach the runtime environment.
ARG POKE_ENGINE_TAG=v0.0.48

# `/app` is the working directory for the life of the process.
#
# battle_engine.usage_stats.DEFAULT_STATS_DIR is the RELATIVE Path("data/usage_stats"),
# and analyze_replay exposes no stats_dir override, so a caller cannot inject the path
# through the public API and has to control the working directory instead. See
# notes/gotcha-usage-stats-cache-is-keyed-on-a-relative-path.md for why this is set once
# rather than per call.
WORKDIR /app

# Not in battle-engine's git (its .gitignore excludes data/), so this needs a checkout
# that has fetched it via scripts/fetch_usage_stats.py. This single line is why a full
# worker image cannot be built from public sources alone.
COPY --from=engine data/usage_stats/${USAGE_STATS_FILE} /app/data/usage_stats/${USAGE_STATS_FILE}

RUN pip install --no-cache-dir "psycopg[binary]"

COPY worker/pyproject.toml /app/worker/pyproject.toml
COPY worker/battle_cloud_worker /app/worker/battle_cloud_worker
RUN pip install --no-cache-dir /app/worker

# The queue's .sql files. The worker package is installed into site-packages, so its
# repo-relative fallback path for these does not exist here; QUERIES_DIR is what it uses.
COPY db/queries /app/db/queries

# POKE_ENGINE_TAG and USAGE_STATS_DATASET are identity fields, and the worker refuses to
# start without them. They are set from the build arguments that selected the wheel and
# the stats file, so the image describes itself rather than trusting a deploy to.
ENV PYTHONUNBUFFERED=1 \
    ENGINE_DATA_DIR=/app \
    QUERIES_DIR=/app/db/queries \
    POKE_ENGINE_TAG=${POKE_ENGINE_TAG} \
    USAGE_STATS_DATASET=${USAGE_STATS_DATASET}

CMD ["python", "-m", "battle_cloud_worker"]
