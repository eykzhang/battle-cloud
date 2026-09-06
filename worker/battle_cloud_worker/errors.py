"""The worker half of the shared error vocabulary.

Kept in sync by hand with `api/src/contract/errors.ts` and `docs/contract.md`. There is
deliberately no code generation across the language boundary - two small hand-maintained
lists with a test asserting they agree is less machinery than a generator, and the test
fails loudly the moment they drift.
"""

from __future__ import annotations

from enum import Enum


class ErrorKind(str, Enum):
    """Every failure a job can end in, as the client will see it."""

    # Replay acquisition (API tier owns these; listed so the vocabularies match).
    INVALID_REPLAY_ID = "invalid_replay_id"
    REPLAY_NOT_FOUND = "replay_not_found"
    REPLAY_EMPTY_LOG = "replay_empty_log"
    REPLAY_TOO_LARGE = "replay_too_large"
    REPLAY_MALFORMED = "replay_malformed"
    REPLAY_TRANSPORT_FAILURE = "replay_transport_failure"
    REPLAY_TIMEOUT = "replay_timeout"

    # Analysis (this tier).
    ENGINE_UNAVAILABLE = "engine_unavailable"
    ENGINE_DATA_MISSING = "engine_data_missing"
    ANALYSIS_REJECTED = "analysis_rejected"
    ANALYSIS_PARSE_FAILED = "analysis_parse_failed"
    ENGINE_CRASHED = "engine_crashed"
    ENGINE_INTERNAL_ERROR = "engine_internal_error"

    # Request (API tier).
    UNKNOWN_PROFILE = "unknown_profile"
    INVALID_REQUEST = "invalid_request"
    RATE_LIMITED = "rate_limited"
    ANALYSIS_NOT_FOUND = "analysis_not_found"


class EngineFailure(Exception):
    """An analysis that could not be produced, carrying a classified kind.

    Raised instead of letting the engine's own exception types escape, so the queue layer
    never has to know what `ReplayAnalysisError` is, and so a `BaseException` from the
    Rust extension cannot take the worker process down with it.
    """

    def __init__(self, kind: ErrorKind, detail: str) -> None:
        super().__init__(f"{kind.value}: {detail}")
        self.kind = kind
        self.detail = detail
