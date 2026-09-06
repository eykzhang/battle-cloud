import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Store } from '../src/store.ts';
import { RateLimiter } from '../src/ratelimit.ts';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres:///battlecloud';
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 6, 12, 34, 56);
const CLIENT = '203.0.113.7';

let pool: pg.Pool;

before(() => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE rate_limit_windows');
});

/** A limiter on its own clock, standing in for a separate API instance. */
function instance(limit: number, clock: () => number): RateLimiter {
  return new RateLimiter(new Store(pool), limit, HOUR, clock);
}

async function countFor(client: string): Promise<number[]> {
  const { rows } = await pool.query(
    'SELECT count FROM rate_limit_windows WHERE client_key = $1 ORDER BY window_start',
    [client],
  );
  return rows.map((r) => r.count);
}

test('two instances enforce one shared limit rather than one each', async () => {
  // The whole reason this moved out of process memory. In-memory, both instances would
  // have allowed two submissions each.
  const clock = () => T0;
  const a = instance(2, clock);
  const b = instance(2, clock);

  assert.equal(await a.tryConsume(CLIENT), true);
  assert.equal(await b.tryConsume(CLIENT), true);
  assert.equal(await a.tryConsume(CLIENT), false, 'the third submission exceeds the shared limit');
  assert.equal(await b.tryConsume(CLIENT), false);
  assert.deepEqual(await countFor(CLIENT), [2], 'a refused submission must not increment the counter');
});

test('each client gets its own window', async () => {
  const limiter = instance(1, () => T0);
  assert.equal(await limiter.tryConsume(CLIENT), true);
  assert.equal(await limiter.tryConsume('198.51.100.4'), true);
  assert.equal(await limiter.tryConsume(CLIENT), false);
});

test('the allowance refills at the window boundary', async () => {
  let clock = T0;
  const limiter = instance(1, () => clock);
  assert.equal(await limiter.tryConsume(CLIENT), true);
  assert.equal(await limiter.tryConsume(CLIENT), false);

  clock = T0 + HOUR;
  assert.equal(await limiter.tryConsume(CLIENT), true, 'a new window is a new allowance');
});

test('windows are aligned to the clock, not to a client first request', async () => {
  // Two instances that started at different times must still agree on where the window
  // begins, because they never talk to each other.
  const early = instance(1, () => T0);
  const late = instance(1, () => T0 + 5 * 60 * 1000);
  assert.equal(await early.tryConsume(CLIENT), true);
  assert.equal(await late.tryConsume(CLIENT), false, 'five minutes later is the same window');
  assert.deepEqual(await countFor(CLIENT), [1]);
});

test('retryAfterSeconds counts down to the boundary and stays inside the window', async () => {
  const atBoundary = instance(1, () => T0 - (T0 % HOUR));
  assert.equal(atBoundary.retryAfterSeconds(CLIENT), 3600);

  const nearEnd = instance(1, () => T0 - (T0 % HOUR) + HOUR - 30_000);
  assert.equal(nearEnd.retryAfterSeconds(CLIENT), 30);
});

test('closed windows are swept, and the live one is left alone', async () => {
  let clock = T0;
  const limiter = instance(5, () => clock);
  await limiter.tryConsume(CLIENT);
  assert.equal((await countFor(CLIENT)).length, 1);

  clock = T0 + HOUR;
  await limiter.tryConsume(CLIENT);
  assert.deepEqual(await countFor(CLIENT), [1], 'the previous window is gone, this one remains');
});
