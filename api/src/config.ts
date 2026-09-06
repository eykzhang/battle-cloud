import { DEFAULT_BASE_URL, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from './replay/index.ts';

export interface ApiConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly showdownBaseUrl: string;
  readonly replayMaxBytes: number;
  readonly replayTimeoutMs: number;
  readonly submitRateLimitPerHour: number;
  /**
   * Part of the analysis identity, so it must match the tag the worker image was built
   * from. A mismatch does not corrupt anything: it makes every identity miss the cache
   * and re-analyze, which is wasteful rather than wrong.
   */
  readonly pokeEngineTag: string;
  /**
   * The month of the usage-stats file the worker image carries, as it appears in the
   * file name (`2026-07_gen9ou-1500.json`). Also part of the identity, and with a
   * sharper failure mode than the tag above: a worker only claims jobs whose dataset
   * matches its own, so a wrong value here leaves every submission queued.
   */
  readonly usageStatsDataset: string;
}

export class ConfigError extends Error {}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const databaseUrl = env['DATABASE_URL'] ?? '';
  if (databaseUrl === '') throw new ConfigError('DATABASE_URL is required');
  return {
    port: int(env, 'PORT', 8080),
    databaseUrl,
    showdownBaseUrl: env['SHOWDOWN_BASE_URL'] ?? DEFAULT_BASE_URL,
    replayMaxBytes: int(env, 'REPLAY_MAX_BYTES', DEFAULT_MAX_BYTES),
    replayTimeoutMs: int(env, 'REPLAY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    submitRateLimitPerHour: int(env, 'SUBMIT_RATE_LIMIT_PER_HOUR', 20),
    pokeEngineTag: env['POKE_ENGINE_TAG'] ?? 'v0.0.48',
    usageStatsDataset: env['USAGE_STATS_DATASET'] ?? '2026-07',
  };
}
