import type { Pool } from 'pg';
import type { AnalysisIdentity, AnalysisSummary, Profile } from './contract/index.ts';

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
                          threads, usage_stats_cutoff, usage_stats_dataset, poke_engine_tag, seed`;

function identityValues(id: AnalysisIdentity): unknown[] {
  return [
    id.replayId,
    id.perspective,
    id.searchBudgetMsPerTurn,
    id.opponentSamples,
    id.threads,
    id.usageStatsCutoff,
    id.usageStatsDataset,
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

/**
 * The sort key of the public list: newest first, with the id breaking ties.
 *
 * Keyset rather than OFFSET. An offset re-reads and discards every row before the page,
 * so deep pages get slower in proportion to their depth, and a row inserted while a
 * visitor pages through shifts every later page by one, which shows up as a duplicated or
 * skipped entry rather than as an error. The id is in the key because two analyses of the
 * same replay at different profiles land within milliseconds of each other, and a cursor
 * on the timestamp alone would drop or repeat one at a page boundary.
 */
export interface AnalysisCursor {
  createdAt: string;
  id: string;
}

/** Opaque to clients, and deliberately not JSON: a client that parses it will break. */
export function encodeCursor(cursor: AnalysisCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export class CursorError extends Error {}

/**
 * Rejects rather than ignores a malformed cursor. Silently returning the first page would
 * turn a client's pagination bug into an infinite loop over page one.
 */
export function decodeCursor(raw: string): AnalysisCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator === -1) throw new CursorError('cursor is not a valid pagination cursor');
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  // Both halves are fed to Postgres as timestamptz and uuid, so a value that is neither
  // fails in the driver with a message about types rather than about the request.
  if (Number.isNaN(Date.parse(createdAt))) throw new CursorError('cursor carries an invalid timestamp');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new CursorError('cursor carries an invalid id');
  return { createdAt, id };
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
          AND usage_stats_dataset = $7 AND poke_engine_tag = $8 AND seed = $9`,
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

  /**
   * A page of recent analyses, newest first, joined to their replays for the parts a list
   * needs: format, rating, and the two player names.
   *
   * `limit` is passed through as given, and the route asks for one more row than it means
   * to return. That is how `nextCursor` is decided without a second COUNT query: if the
   * extra row exists there is another page, and if it does not there is not.
   */
  async recentAnalyses(limit: number, cursor: AnalysisCursor | null): Promise<AnalysisSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.replay_id, a.perspective, a.total_turns, a.gradable_turns,
              a.search_budget_ms_per_turn, a.opponent_samples, a.created_at,
              r.format, r.rating, r.players
         FROM analyses a
         JOIN replays r ON r.id = a.replay_id
        WHERE $2::timestamptz IS NULL
           OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $1`,
      [limit, cursor?.createdAt ?? null, cursor?.id ?? null],
    );
    return rows.map((row) => ({
      analysisId: row['id'],
      replayId: row['replay_id'],
      format: row['format'],
      rating: row['rating'],
      // The column is jsonb with a default of `[]`, and the replay payload it comes from
      // is untrusted, so anything that is not a string is dropped rather than served.
      players: Array.isArray(row['players']) ? row['players'].filter((p: unknown) => typeof p === 'string') : [],
      perspective: row['perspective'],
      totalTurns: row['total_turns'],
      gradableTurns: row['gradable_turns'],
      searchBudgetMsPerTurn: row['search_budget_ms_per_turn'],
      opponentSamples: row['opponent_samples'],
      createdAt: new Date(row['created_at']).toISOString(),
    }));
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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

  /**
   * Count one submission against `clientKey`'s window, or refuse it.
   *
   * One statement, and it has to be one: the read and the increment are the same race
   * that two API instances would otherwise lose. `DO UPDATE ... WHERE count < limit`
   * makes Postgres decide, and a refused increment returns no row at all, which is the
   * signal rather than a second query.
   */
  async consumeRateLimit(clientKey: string, windowStart: Date, limit: number): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limit_windows (client_key, window_start, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (client_key, window_start)
       DO UPDATE SET count = rate_limit_windows.count + 1
         WHERE rate_limit_windows.count < $3
       RETURNING count`,
      [clientKey, windowStart, limit],
    );
    return rows.length > 0;
  }

  /**
   * Drop windows that have closed. Without it the table grows one row per distinct
   * address per window forever, which is the same leak the in-memory version swept for,
   * except durable.
   */
  async sweepRateLimits(before: Date): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM rate_limit_windows WHERE window_start < $1', [before]);
    return rowCount ?? 0;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
