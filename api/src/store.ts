import type { Pool } from 'pg';
import type { AnalysisIdentity, Profile } from './contract/index.ts';

/**
 * Every database statement the API makes.
 *
 * Deliberately a module rather than an ORM: there are six statements, they are the same
 * ones `db/queries/` documents for the worker, and the identity tuple has to be spelled
 * out in full at each call site anyway. An ORM would hide exactly the part that matters.
 *
 * Every value is a bound parameter. Replay ids and perspectives arrive from untrusted
 * submissions.
 */

const IDENTITY_COLUMNS = `replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
                          threads, usage_stats_cutoff, poke_engine_tag, seed`;

function identityValues(id: AnalysisIdentity): unknown[] {
  return [
    id.replayId,
    id.perspective,
    id.searchBudgetMsPerTurn,
    id.opponentSamples,
    id.threads,
    id.usageStatsCutoff,
    id.pokeEngineTag,
    id.seed,
  ];
}

export interface StoredAnalysis {
  id: string;
  seed: number;
  createdAt: string;
  document: unknown;
}

export interface StoredJob {
  id: string;
  status: string;
  replayId: string;
  perspective: string;
  profile: string;
  estimatedTurns: number | null;
  estimatedSearchMs: number | null;
  analysisId: string | null;
  errorKind: string | null;
  createdAt: string;
  updatedAt: string;
}

const JOB_COLUMNS = `id, status, replay_id, perspective, profile, estimated_turns,
                     estimated_search_ms, analysis_id, error_kind, created_at, updated_at`;

function toJob(row: Record<string, any>): StoredJob {
  return {
    id: row['id'],
    status: row['status'],
    replayId: row['replay_id'],
    perspective: row['perspective'],
    profile: row['profile'],
    estimatedTurns: row['estimated_turns'],
    estimatedSearchMs: row['estimated_search_ms'],
    analysisId: row['analysis_id'],
    errorKind: row['error_kind'],
    createdAt: new Date(row['created_at']).toISOString(),
    updatedAt: new Date(row['updated_at']).toISOString(),
  };
}

export class Store {
  // Written out rather than a constructor parameter property: Node's strip-only
  // TypeScript support cannot transform those, and the test runner executes .ts directly.
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async analysisByIdentity(id: AnalysisIdentity): Promise<StoredAnalysis | null> {
    const { rows } = await this.pool.query(
      `SELECT id, seed, created_at, document FROM analyses
        WHERE replay_id = $1 AND perspective = $2 AND search_budget_ms_per_turn = $3
          AND opponent_samples = $4 AND threads = $5 AND usage_stats_cutoff = $6
          AND poke_engine_tag = $7 AND seed = $8`,
      identityValues(id),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row['id'],
      seed: row['seed'],
      createdAt: new Date(row['created_at']).toISOString(),
      document: row['document'],
    };
  }

  async analysisById(analysisId: string): Promise<StoredAnalysis | null> {
    const { rows } = await this.pool.query(
      'SELECT id, seed, created_at, document FROM analyses WHERE id = $1',
      [analysisId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row['id'],
      seed: row['seed'],
      createdAt: new Date(row['created_at']).toISOString(),
      document: row['document'],
    };
  }

  async upsertReplay(replay: {
    id: string;
    format: string;
    rating: number | null;
    players: unknown;
    log: string;
    payloadBytes: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO replays (id, format, rating, players, log, payload_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [replay.id, replay.format, replay.rating, JSON.stringify(replay.players ?? []), replay.log, replay.payloadBytes],
    );
  }

  /**
   * The stored log, or null. Returned rather than a boolean `hasReplay` because every
   * caller that wants to know whether a replay is stored also wants its turn count, and
   * two round trips for one question is one too many.
   */
  async replayLog(replayId: string): Promise<string | null> {
    const { rows } = await this.pool.query('SELECT log FROM replays WHERE id = $1', [replayId]);
    return rows[0] === undefined ? null : rows[0]['log'];
  }

  /**
   * Insert a job, or return the live one for this identity.
   *
   * The ON CONFLICT target is the partial unique index `jobs_active_identity_key`, so a
   * resubmit while a job is queued or running joins it rather than starting a second
   * core-minute of identical search. DO UPDATE rather than DO NOTHING because the caller
   * needs the existing row's id and DO NOTHING returns nothing.
   */
  async enqueue(
    id: AnalysisIdentity,
    profile: Profile,
    estimatedTurns: number,
    estimatedSearchMs: number,
  ): Promise<{ job: StoredJob; created: boolean }> {
    const { rows } = await this.pool.query(
      `INSERT INTO jobs (${IDENTITY_COLUMNS}, profile, estimated_turns, estimated_search_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (${IDENTITY_COLUMNS}) WHERE status IN ('queued','running')
       DO UPDATE SET updated_at = jobs.updated_at
       RETURNING ${JOB_COLUMNS}, (xmax = 0) AS created`,
      [...identityValues(id), profile, estimatedTurns, estimatedSearchMs],
    );
    const row = rows[0]!;
    return { job: toJob(row), created: row['created'] };
  }

  async jobById(jobId: string): Promise<StoredJob | null> {
    const { rows } = await this.pool.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [jobId]);
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
