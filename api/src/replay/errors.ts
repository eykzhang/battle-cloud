import type { ErrorKind } from '../contract/index.ts';

/**
 * A failure acquiring a replay, carrying a kind from the shared vocabulary rather than a
 * message a caller would have to pattern-match. The kind is what crosses the wire and
 * what the worker's own failures are classified into, so the two tiers agree without
 * either parsing the other's prose.
 */
export class ReplayFetchError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReplayFetchError';
    this.kind = kind;
  }
}
