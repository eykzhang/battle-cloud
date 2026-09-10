import type { FastifyInstance } from 'fastify';
import {
  deriveIdentity,
  SubmitRequestSchema,
  type ErrorKind,
  type Profile,
  ListQuerySchema,
} from './contract/index.ts';
import { estimateDuration, estimateTurns, fetchReplay, ReplayFetchError, type ReplayDeps } from './replay/index.ts';
import type { ApiConfig } from './config.ts';
import { CursorError, decodeCursor, encodeCursor, type AnalysisCursor } from './store.ts';
import type { Store, StoredAnalysis, StoredJob } from './store.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { WorkerLauncher } from './worker.ts';

export interface Deps {
  readonly config: ApiConfig;
  readonly store: Store;
  readonly limiter: RateLimiter;
  readonly fetch: typeof globalThis.fetch;
  readonly launcher: WorkerLauncher;
}

/** HTTP status per error kind. One table, so a kind cannot map two ways. */
const STATUS: Record<string, number> = {
  invalid_request: 400,
  invalid_replay_id: 400,
  unknown_profile: 400,
  replay_not_found: 404,
  analysis_not_found: 404,
  replay_empty_log: 422,
  replay_malformed: 422,
  replay_too_large: 413,
  rate_limited: 429,
  replay_transport_failure: 502,
  replay_timeout: 504,
};

function fail(kind: ErrorKind, message: string) {
  return { status: STATUS[kind] ?? 500, body: { error: { kind, message } } };
}

function envelope(analysis: StoredAnalysis) {
  return {
    analysisId: analysis.id,
    seed: analysis.seed,
    createdAt: analysis.createdAt,
    document: analysis.document,
  };
}

function jobView(job: StoredJob) {
  return {
    jobId: job.id,
    status: job.status,
    replayId: job.replayId,
    perspective: job.perspective,
    profile: job.profile,
    // Named estimates because that is what they are. The engine has no progress callback,
    // so this comes from counting |turn| lines before any search runs.
    estimatedTurns: job.estimatedTurns,
    estimatedSearchMs: job.estimatedSearchMs,
    analysisId: job.analysisId,
    errorKind: job.errorKind,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function registerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const replayDeps: ReplayDeps = {
    fetch: deps.fetch,
    baseUrl: deps.config.showdownBaseUrl,
    maxBytes: deps.config.replayMaxBytes,
    timeoutMs: deps.config.replayTimeoutMs,
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.store.ping();
      return { ok: true };
    } catch (cause) {
      return reply.code(503).send({ error: { kind: 'unavailable', message: String(cause) } });
    }
  });

  app.post('/v1/analyses', async (request, reply) => {
    const parsed = SubmitRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const { status, body } = fail('invalid_request', parsed.error.issues.map((i) => i.message).join('; '));
      return reply.code(status).send(body);
    }
    const submit = parsed.data;
    const identity = deriveIdentity(submit, {
      pokeEngineTag: deps.config.pokeEngineTag,
      usageStatsDataset: deps.config.usageStatsDataset,
    });

    // Cache first, before the rate limit: a hit costs one query, and charging for it
    // would penalize exactly the sharing the id-keyed design exists to encourage.
    const cached = await deps.store.analysisByIdentity(identity);
    if (cached !== null) {
      return reply.code(200).send(envelope(cached));
    }

    const clientKey = request.ip;
    if (!(await deps.limiter.tryConsume(clientKey))) {
      const { status, body } = fail('rate_limited', 'submission rate exceeded');
      return reply.code(status).header('retry-after', deps.limiter.retryAfterSeconds(clientKey)).send(body);
    }

    let estimatedTurns = 0;
    try {
      // Fetch only when the replay is not already stored. A second analysis of the same
      // replay at a different profile should not re-hit Showdown.
      const storedLog = await deps.store.replayLog(submit.replayId);
      if (storedLog === null) {
        const payload = await fetchReplay(submit.replayId, replayDeps);
        const raw = payload.raw;
        estimatedTurns = estimateTurns(payload.log);
        await deps.store.upsertReplay({
          id: submit.replayId,
          format: typeof raw['formatid'] === 'string' ? raw['formatid'] : 'unknown',
          rating: typeof raw['rating'] === 'number' ? raw['rating'] : null,
          players: raw['players'] ?? [],
          log: payload.log,
          payloadBytes: Buffer.byteLength(payload.log, 'utf8'),
        });
      } else {
        estimatedTurns = estimateTurns(storedLog);
      }
    } catch (cause) {
      if (cause instanceof ReplayFetchError) {
        const { status, body } = fail(cause.kind, cause.message);
        return reply.code(status).send(body);
      }
      throw cause;
    }

    const { job, created } = await deps.store.enqueue(
      identity,
      submit.profile as Profile,
      estimatedTurns,
      estimateDuration(estimatedTurns, submit.profile as Profile),
    );
    // Only for a job still waiting. A resubmit that joined a job already `running` has a
    // worker on it, and starting a second one would pay a 4 vCPU minute to claim nothing.
    //
    // The catch is not redundant with the launcher swallowing its own failures. The job is
    // durably enqueued by the line above, so from here on the submission has succeeded and
    // nothing about starting a worker early can be allowed to say otherwise. Depending on a
    // collaborator to never throw is a contract no type enforces, and the cost of being
    // wrong is a 500 telling a client its accepted job failed while a worker picks it up
    // anyway.
    if (job.status === 'queued') {
      await deps.launcher.ensureRunning().catch((cause: unknown) => {
        request.log.warn({ err: String(cause), jobId: job.id }, 'worker launch threw; the sweep covers it');
      });
    }

    // 202 either way. A resubmit that joined a live job is not an error, and the client
    // polls the same handle regardless of which call created it.
    return reply.code(202).header('location', `/v1/jobs/${job.id}`).send({ ...jobView(job), created });
  });

  /**
   * The public list. Unauthenticated and unlimited by rate, because a read costs a query
   * and the analyses are of public Showdown replays; the limiter exists for submissions,
   * which cost a core-minute.
   */
  /**
   * CORS preflight, answered with 204 and nothing else.
   *
   * The headers themselves come from API Gateway's own CORS configuration, which is
   * documented to ignore whatever the integration returns, so this handler deliberately
   * sets none. What it fixes is the status: a `$default` route catches `OPTIONS` along with
   * everything else, so a preflight reaches Fastify, finds no route, and returns 404 with
   * the gateway's CORS headers attached. Browsers require a 2xx preflight, so every
   * cross-origin POST from the web client failed before it was sent, while GETs -- which
   * are not preflighted -- worked. That asymmetry is what made it invisible until a real
   * browser tried to submit.
   *
   * Local runs (compose, the test suite) have no gateway in front and no browser either, so
   * a bare 204 is correct there as well.
   */
  app.options('/*', async (_request, reply) => reply.code(204).send());
  app.options('/', async (_request, reply) => reply.code(204).send());

  app.get<{ Querystring: Record<string, string> }>('/v1/analyses', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const { status, body } = fail('invalid_request', parsed.error.issues.map((i) => i.message).join('; '));
      return reply.code(status).send(body);
    }
    const { limit } = parsed.data;

    let cursor: AnalysisCursor | null = null;
    try {
      cursor = parsed.data.cursor === undefined ? null : decodeCursor(parsed.data.cursor);
    } catch (cause) {
      const message = cause instanceof CursorError ? cause.message : 'cursor is not a valid pagination cursor';
      const { status, body } = fail('invalid_request', message);
      return reply.code(status).send(body);
    }

    // One more than asked for, which is what decides whether there is a next page.
    const rows = await deps.store.recentAnalyses(limit + 1, cursor);
    const analyses = rows.slice(0, limit);
    const last = analyses[analyses.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt, id: last.analysisId })
        : null;
    return reply.code(200).send({ analyses, nextCursor });
  });

  app.get<{ Params: { analysisId: string } }>('/v1/analyses/:analysisId', async (request, reply) => {
    const analysis = await deps.store.analysisById(request.params.analysisId).catch(() => null);
    if (analysis === null) {
      const { status, body } = fail('analysis_not_found', `no analysis ${request.params.analysisId}`);
      return reply.code(status).send(body);
    }
    return reply.code(200).send(envelope(analysis));
  });

  app.get<{ Params: { jobId: string } }>('/v1/jobs/:jobId', async (request, reply) => {
    const job = await deps.store.jobById(request.params.jobId).catch(() => null);
    if (job === null) {
      const { status, body } = fail('analysis_not_found', `no job ${request.params.jobId}`);
      return reply.code(status).send(body);
    }
    return reply.code(200).send(jobView(job));
  });
}
