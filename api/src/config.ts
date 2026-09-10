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
  /**
   * Connections this process opens to Postgres. Ten suits a long-lived server handling
   * requests concurrently. Lambda sets it to two, because a function instance serves one
   * request at a time and the pool is multiplied by every concurrent instance: the
   * per-instance number is small precisely so the fleet's total stays under what Neon's
   * pooler will hold.
   */
  readonly dbPoolMax: number;
  /**
   * How to start a worker after enqueueing, or `null` for a deployment that has no way to.
   * Compose and the test suite are the second case: there is no ECS to call, and the
   * scheduled sweep covers a real deployment that omits this.
   */
  readonly workerLaunch: WorkerLaunchConfig | null;
}

export interface WorkerLaunchConfig {
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly subnetIds: readonly string[];
  readonly securityGroup: string;
  readonly maxTasks: number;
}

export class ConfigError extends Error {}

const WORKER_LAUNCH_KEYS = [
  'WORKER_CLUSTER',
  'WORKER_TASK_DEFINITION',
  'WORKER_SUBNET_IDS',
  'WORKER_SECURITY_GROUP',
] as const;

/**
 * All of them or none of them.
 *
 * A partially-set group is the failure this rejects: the trigger would quietly do nothing
 * and every submission would wait for the hourly sweep, while both tiers reported healthy
 * and the queue drained eventually. That is the same shape of silent failure the engine
 * identity fields exist to prevent, and it deserves the same treatment, which is refusing
 * to start rather than guessing.
 */
function loadWorkerLaunch(env: NodeJS.ProcessEnv): WorkerLaunchConfig | null {
  const present = WORKER_LAUNCH_KEYS.filter((key) => (env[key] ?? '') !== '');
  if (present.length === 0) return null;
  if (present.length !== WORKER_LAUNCH_KEYS.length) {
    const missing = WORKER_LAUNCH_KEYS.filter((key) => (env[key] ?? '') === '');
    throw new ConfigError(
      `worker launch is partially configured: ${present.join(', ')} set, ${missing.join(', ')} missing. ` +
        'Set all of them to start workers on submission, or none to leave it to the scheduled sweep.',
    );
  }

  const subnetIds = (env['WORKER_SUBNET_IDS'] ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '');
  if (subnetIds.length === 0) {
    throw new ConfigError('WORKER_SUBNET_IDS must list at least one subnet');
  }

  return {
    cluster: env['WORKER_CLUSTER'] as string,
    taskDefinition: env['WORKER_TASK_DEFINITION'] as string,
    subnetIds,
    securityGroup: env['WORKER_SECURITY_GROUP'] as string,
    maxTasks: int(env, 'WORKER_MAX_TASKS', 2),
  };
}

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
    dbPoolMax: int(env, 'DB_POOL_MAX', 10),
    workerLaunch: loadWorkerLaunch(env),
  };
}
