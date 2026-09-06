import { PROFILES, type Profile } from './profiles.ts';

/**
 * Showdown replay ids, matching the engine's own `_SAFE_ID_PATTERN` in
 * `battle_engine/replay_analysis.py`. Enforced here because a replay id becomes a URL
 * path segment before it ever reaches the engine, so this tier has to reject a
 * traversal or scheme-smuggling attempt on its own rather than relying on a downstream
 * check.
 */
export const SAFE_REPLAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeReplayId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REPLAY_ID.test(value) && !value.includes('..');
}

export const PERSPECTIVES = ['p1', 'p2'] as const;
export type Perspective = (typeof PERSPECTIVES)[number];

/**
 * The eight fields that identify an analysis. This is the cache key and the unique
 * constraint on the `analyses` table.
 *
 * `seed` is here even though schema v1 does not carry it: `EngineConfiguration` in
 * battle-brain's `EngineService.swift` has five fields and the seed is not one of them,
 * so two analyses of the same replay at different seeds are indistinguishable from the
 * document alone. Storing it separately is the whole reason this type exists rather than
 * the document's own `engine` block being used as the key.
 */
export interface AnalysisIdentity {
  readonly replayId: string;
  readonly perspective: Perspective;
  readonly searchBudgetMsPerTurn: number;
  readonly opponentSamples: number;
  readonly threads: number;
  readonly usageStatsCutoff: number;
  readonly pokeEngineTag: string;
  readonly seed: number;
}

/**
 * Field order for `identityKey`. Declared once, explicitly, so the key is stable across
 * refactors of the interface above: deriving it from `Object.keys` would silently change
 * every stored key the first time a field was reordered.
 */
const IDENTITY_FIELDS = [
  'replayId',
  'perspective',
  'searchBudgetMsPerTurn',
  'opponentSamples',
  'threads',
  'usageStatsCutoff',
  'pokeEngineTag',
  'seed',
] as const satisfies readonly (keyof AnalysisIdentity)[];

export function deriveIdentity(
  request: { replayId: string; perspective: Perspective; profile: Profile },
  pokeEngineTag: string,
): AnalysisIdentity {
  const params = PROFILES[request.profile];
  return {
    replayId: request.replayId,
    perspective: request.perspective,
    searchBudgetMsPerTurn: params.searchBudgetMsPerTurn,
    opponentSamples: params.opponentSamples,
    threads: params.threads,
    usageStatsCutoff: params.usageStatsCutoff,
    pokeEngineTag,
    seed: params.seed,
  };
}

/**
 * A stable string for an identity, independent of key insertion order.
 *
 * `JSON.stringify` would not do: it serializes in insertion order, so two structurally
 * equal identities built by different code paths would produce different keys and
 * silently duplicate an analysis. Values are escaped because `pokeEngineTag` and
 * `replayId` are strings and an unescaped separator inside one would let two different
 * identities collide.
 */
export function identityKey(identity: AnalysisIdentity): string {
  return IDENTITY_FIELDS.map((field) => `${field}=${encodeURIComponent(String(identity[field]))}`).join('&');
}
