/**
 * Engine parameters, keyed by profile name.
 *
 * A client names a profile and never sends raw search parameters. The reason is not
 * ergonomics: `search_time_ms` is a CPU budget on this server, and letting a caller pick
 * it hands them a lever on machine load. See docs/contract.md.
 *
 * Field names here are the API's camelCase spelling. The worker maps them to
 * `analyze_replay`'s snake_case keyword arguments, which is the only place the two
 * spellings meet.
 */
export const PROFILES = {
  'ladder-parity': {
    searchBudgetMsPerTurn: 1000,
    opponentSamples: 8,
    threads: 4,
    usageStatsCutoff: 1500,
    seed: 0,
  },
  quick: {
    searchBudgetMsPerTurn: 200,
    opponentSamples: 2,
    threads: 4,
    usageStatsCutoff: 1500,
    seed: 0,
  },
} as const;

export type Profile = keyof typeof PROFILES;

export type EngineParams = (typeof PROFILES)[Profile];

export const PROFILE_NAMES = Object.keys(PROFILES) as [Profile, ...Profile[]];

export function isProfile(value: unknown): value is Profile {
  return typeof value === 'string' && Object.hasOwn(PROFILES, value);
}

/**
 * Wall-clock search time a replay of `turns` turns will cost under `profile`, in
 * milliseconds. `searchBudgetMsPerTurn` is the whole per-turn budget, already divided
 * across opponent samples by the engine, so this is turns times budget and not turns
 * times budget times samples.
 *
 * Search only. Parsing, state translation, and process startup are not included, so
 * this is a floor rather than an estimate of total job duration.
 */
export function searchTimeMs(turns: number, profile: Profile): number {
  return turns * PROFILES[profile].searchBudgetMsPerTurn;
}
