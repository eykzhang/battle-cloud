/**
 * The one closed error vocabulary both tiers share, so a failure that originates in a
 * worker reaches a client without being reclassified on the way through. Kept in sync
 * with docs/contract.md and with worker/battle_cloud_worker/errors.py by hand: there is
 * deliberately no code generation across the language boundary, and the tests on both
 * sides assert the two lists agree.
 */
export const ERROR_KINDS = [
  // Replay acquisition, API tier.
  'invalid_replay_id',
  'replay_not_found',
  'replay_empty_log',
  'replay_too_large',
  'replay_malformed',
  'replay_transport_failure',
  'replay_timeout',
  // Analysis, worker tier.
  'engine_unavailable',
  'engine_data_missing',
  'analysis_rejected',
  'analysis_parse_failed',
  'engine_crashed',
  'engine_internal_error',
  // Request, API tier.
  'unknown_profile',
  'invalid_request',
  'rate_limited',
  'analysis_not_found',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value);
}
