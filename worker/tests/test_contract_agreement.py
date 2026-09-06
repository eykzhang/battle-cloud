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


def _kinds_in_contract_doc() -> set[str]:
    """Only the tables under `## Error kinds`. Scanning the whole document would also
    match the profiles table's own first column, which is how this test first failed."""
    section = CONTRACT.read_text().split("## Error kinds", 1)[1].split("\n## ", 1)[0]
    return set(re.findall(r"^\| `([a-z_]+)` \|", section, flags=re.MULTILINE))


def _kinds_in_typescript() -> set[str]:
    body = TS_ERRORS.read_text().split("ERROR_KINDS = [", 1)[1].split("]", 1)[0]
    return set(re.findall(r"'([a-z_]+)'", body))


def test_python_matches_the_contract_document():
    assert {k.value for k in ErrorKind} == _kinds_in_contract_doc()


def test_typescript_matches_the_contract_document():
    assert _kinds_in_typescript() == _kinds_in_contract_doc()
