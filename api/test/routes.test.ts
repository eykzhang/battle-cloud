import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/routes.ts';
import { Store } from '../src/store.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import type { ApiConfig } from '../src/config.ts';

// TEST_DATABASE_URL first so a developer can point the suite at a scratch database
// without touching DATABASE_URL, then DATABASE_URL, then a local default. CI sets only
// DATABASE_URL, and an earlier version of this line skipped straight from the first to
// the default, which connected to nothing and failed 12 tests on SASL auth.
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres:///battlecloud';
const REPLAY_ID = 'gen9ou-2672927429';
const RAW = JSON.parse(readFileSync(new URL(`./fixtures/replays/${REPLAY_ID}.json`, import.meta.url), 'utf8'));
const ANALYSIS = JSON.parse(readFileSync(new URL(`./fixtures/analysis/${REPLAY_ID}.json`, import.meta.url), 'utf8'));

const CONFIG: ApiConfig = {
  port: 0,
  databaseUrl: DATABASE_URL,
  showdownBaseUrl: 'https://replay.pokemonshowdown.com/',
  replayMaxBytes: 5 * 1024 * 1024,
  replayTimeoutMs: 5000,
  submitRateLimitPerHour: 20,
  pokeEngineTag: 'v0.0.48',
};

let pool: pg.Pool;

before(() => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, analyses, replays RESTART IDENTITY CASCADE');
});

/** A server whose only non-real dependency is the network. */
async function server(opts: { fetch?: typeof globalThis.fetch; limit?: number } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const fetchImpl =
    opts.fetch ?? (async () => new Response(JSON.stringify(RAW), { status: 200 }));
  await registerRoutes(app, {
    config: { ...CONFIG, submitRateLimitPerHour: opts.limit ?? 20 },
    store: new Store(pool),
    limiter: new RateLimiter(opts.limit ?? 20),
    fetch: fetchImpl as typeof globalThis.fetch,
  });
  return app;
}

const SUBMIT = { replayId: REPLAY_ID, perspective: 'p2', profile: 'quick' };

async function seedAnalysis(): Promise<string> {
  await pool.query(
    "INSERT INTO replays (id, format, log, payload_bytes) VALUES ($1,'gen9ou',$2,$3)",
    [REPLAY_ID, RAW.log, Buffer.byteLength(RAW.log)],
  );
  const { rows } = await pool.query(
    `INSERT INTO analyses (replay_id, perspective, search_budget_ms_per_turn, opponent_samples,
        threads, usage_stats_cutoff, poke_engine_tag, seed, document, total_turns,
        gradable_turns, wall_ms)
     VALUES ($1,'p2',200,2,4,1500,'v0.0.48',0,$2,24,16,7500) RETURNING id`,
    [REPLAY_ID, JSON.stringify(ANALYSIS)],
  );
  return rows[0].id;
}

test('healthz and readyz answer', async () => {
  const app = await server();
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
  await app.close();
});

test('a first submission fetches the replay and returns 202 with a job handle', async () => {
  let fetched = 0;
  const app = await server({
    fetch: (async () => {
      fetched += 1;
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  const res = await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.status, 'queued');
  assert.equal(body.created, true);
  assert.equal(body.estimatedTurns, 24, 'turn count comes from the log, before any search');
  assert.equal(body.estimatedSearchMs, 24 * 200);
  assert.equal(res.headers['location'], `/v1/jobs/${body.jobId}`);
  assert.equal(fetched, 1);
  await app.close();
});

test('a resubmission joins the live job instead of starting a second one', async () => {
  const app = await server();
  const first = (await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT })).json();
  const second = (await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT })).json();
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.created, false);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM jobs');
  assert.equal(rows[0].n, 1);
  await app.close();
});

test('a stored replay is not refetched for a second profile', async () => {
  let fetched = 0;
  const app = await server({
    fetch: (async () => {
      fetched += 1;
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT });
  const second = await app.inject({
    method: 'POST',
    url: '/v1/analyses',
    payload: { ...SUBMIT, profile: 'ladder-parity' },
  });
  assert.equal(second.statusCode, 202);
  assert.equal(second.json().estimatedTurns, 24, 'turns come from the stored log this time');
  assert.equal(fetched, 1, 'the second profile must not re-hit Showdown');
  await app.close();
});

test('an existing analysis is served directly, with the document unchanged', async () => {
  const analysisId = await seedAnalysis();
  const app = await server({
    fetch: (async () => {
      throw new Error('must not fetch when the analysis is cached');
    }) as typeof globalThis.fetch,
  });
  const res = await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.analysisId, analysisId);
  assert.equal(body.seed, 0, 'seed lives in the envelope because schema v1 omits it');
  assert.deepEqual(body.document, ANALYSIS, 'the document is served byte-faithfully');
  assert.equal(body.document.turns.length, 24);
  assert.equal(body.document.turns[0].topActions.length, ANALYSIS.turns[0].topActions.length,
    'topActions is never truncated');
  await app.close();
});

test('a cached hit is not charged against the rate limit', async () => {
  await seedAnalysis();
  const app = await server({ limit: 1 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT })).statusCode, 200);
  }
  await app.close();
});

test('submissions past the rate limit get 429 with retry-after', async () => {
  const app = await server({ limit: 1 });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT })).statusCode, 202);
  const blocked = await app.inject({
    method: 'POST',
    url: '/v1/analyses',
    payload: { ...SUBMIT, perspective: 'p1' },
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.kind, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  await app.close();
});

test('an invalid body is rejected before anything is fetched or stored', async () => {
  let fetched = false;
  const app = await server({
    fetch: (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof globalThis.fetch,
  });
  for (const payload of [
    { replayId: '../etc/passwd', perspective: 'p2', profile: 'quick' },
    { replayId: REPLAY_ID, perspective: 'p3', profile: 'quick' },
    { replayId: REPLAY_ID, perspective: 'p2', profile: 'exhaustive' },
    {},
  ]) {
    const res = await app.inject({ method: 'POST', url: '/v1/analyses', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error.kind, 'invalid_request');
  }
  assert.equal(fetched, false);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM jobs');
  assert.equal(rows[0].n, 0);
  await app.close();
});

test('a Showdown failure maps to its own status and kind', async () => {
  const cases: [Response, number, string][] = [
    [new Response('', { status: 404 }), 404, 'replay_not_found'],
    [new Response(JSON.stringify({ id: 'x' }), { status: 200 }), 422, 'replay_empty_log'],
    [new Response('not json', { status: 200 }), 422, 'replay_malformed'],
    [new Response('', { status: 503 }), 502, 'replay_transport_failure'],
  ];
  for (const [response, status, kind] of cases) {
    const app = await server({ fetch: (async () => response.clone()) as typeof globalThis.fetch });
    const res = await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT });
    assert.equal(res.statusCode, status, kind);
    assert.equal(res.json().error.kind, kind);
    await app.close();
  }
});

test('a job can be polled by its handle', async () => {
  const app = await server();
  const { jobId } = (await app.inject({ method: 'POST', url: '/v1/analyses', payload: SUBMIT })).json();
  const res = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'queued');
  assert.equal(res.json().analysisId, null);
  await app.close();
});

test('unknown analysis and job ids are 404, including malformed uuids', async () => {
  const app = await server();
  for (const url of [
    '/v1/analyses/2b1c9b6e-0000-4000-8000-000000000000',
    '/v1/analyses/not-a-uuid',
    '/v1/jobs/2b1c9b6e-0000-4000-8000-000000000000',
    '/v1/jobs/not-a-uuid',
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
  }
  await app.close();
});

test('an analysis is retrievable by its own id', async () => {
  const analysisId = await seedAnalysis();
  const app = await server();
  const res = await app.inject({ method: 'GET', url: `/v1/analyses/${analysisId}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().document, ANALYSIS);
  await app.close();
});
