"""The two tiers hand-maintain the same error vocabulary. This is what stops them
drifting: both are checked against `docs/contract.md`, which is the source both were
written from."""

from __future__ import annotations

import re
from pathlib import Path

from battle_cloud_worker.errors import ErrorKind

REPO = Path(__file__).resolve().parents[2]
CONTRACT = REPO / "docs" / "contract.md"
TS_ERRORS = REPO / "api" / "src" / "contract" / "errors.ts"
TS_IDENTITY = REPO / "api" / "src" / "contract" / "identity.ts"
WORKER_DOCKERFILE = REPO / "docker" / "worker.Dockerfile"
ENV_EXAMPLE = REPO / ".env.example"
COMPOSE = REPO / "docker-compose.yml"
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"


def _kinds_in_contract_doc() -> set[str]:
    """Only the tables under `## Error kinds`. Scanning the whole document would also
    match the profiles table's own first column, which is how this test first failed."""
    section = CONTRACT.read_text().split("## Error kinds", 1)[1].split("\n## ", 1)[0]
    return set(re.findall(r"^\| `([a-z_]+)` \|", section, flags=re.MULTILINE))


def _kinds_in_typescript() -> set[str]:
    body = TS_ERRORS.read_text().split("ERROR_KINDS = [", 1)[1].split("]", 1)[0]
    return set(re.findall(r"'([a-z_]+)'", body))


def _identity_fields_in_contract_doc() -> list[str]:
    """The code block under `## Analysis identity`, which is the list both tiers were
    written from."""
    section = CONTRACT.read_text().split("## Analysis identity", 1)[1].split("```", 2)[1]
    return [line.split()[0] for line in section.strip().splitlines()]


def _identity_fields_in_typescript() -> list[str]:
    """`IDENTITY_FIELDS`, not the interface: that array is what actually orders the cache
    key, so it is the copy that can silently disagree."""
    body = TS_IDENTITY.read_text().split("const IDENTITY_FIELDS = [", 1)[1].split("]", 1)[0]
    return re.findall(r"'(\w+)'", body)


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def test_the_identity_is_the_same_nine_fields_everywhere():
    """Four copies of this list exist: the document, the TypeScript array, the Python
    dataclass, and the SQL constraints. The first three are checked here; the fourth is
    checked by db/tests/test_schema.py, which can ask Postgres directly."""
    from dataclasses import fields

    from battle_cloud_worker.contract import AnalysisIdentity

    documented = _identity_fields_in_contract_doc()
    assert len(documented) == 9
    assert _identity_fields_in_typescript() == documented
    assert [f.name for f in fields(AnalysisIdentity)] == [_snake(f) for f in documented]


def test_python_matches_the_contract_document():
    assert {k.value for k in ErrorKind} == _kinds_in_contract_doc()


def test_typescript_matches_the_contract_document():
    assert _kinds_in_typescript() == _kinds_in_contract_doc()


def _dockerfile_arg(name: str) -> str:
    return re.search(rf"^ARG {name}=(\S+)", WORKER_DOCKERFILE.read_text(), flags=re.MULTILINE).group(1)


def _env_example(name: str) -> str:
    return re.search(rf"^{name}=(\S+)", ENV_EXAMPLE.read_text(), flags=re.MULTILINE).group(1)


def _compose_defaults(name: str) -> set[str]:
    return set(re.findall(rf"\$\{{{name}:-([^}}]+)\}}", COMPOSE.read_text()))


def _workflow_env(name: str) -> str:
    return re.search(rf"^\s+{name}: '([^']+)'", WORKFLOW.read_text(), flags=re.MULTILINE).group(1)


def test_the_usage_stats_dataset_is_pinned_to_one_value_everywhere():
    """The API enqueues jobs naming this dataset and workers claim only jobs naming their
    own, so a disagreement between the image build and the API's environment does not
    degrade anything: it leaves every submission queued forever, with both sides healthy.

    CI is included because `fetch_usage_stats.py` with no `--month` resolves whatever
    month Smogon published most recently, which would move the image's dataset on its own
    schedule."""
    pinned = _dockerfile_arg("USAGE_STATS_DATASET")
    assert _env_example("USAGE_STATS_DATASET") == pinned
    assert _compose_defaults("USAGE_STATS_DATASET") == {pinned}
    assert _workflow_env("USAGE_STATS_DATASET") == pinned


def test_the_poke_engine_tag_is_pinned_to_one_value_everywhere():
    """Same shape, gentler failure: a tag mismatch misses the cache rather than stalling
    the queue, since the API would enqueue work no worker claims only if the tag also
    differs from the image's."""
    pinned = _dockerfile_arg("POKE_ENGINE_TAG")
    assert _env_example("POKE_ENGINE_TAG") == pinned
    assert _compose_defaults("POKE_ENGINE_TAG") == {pinned}
