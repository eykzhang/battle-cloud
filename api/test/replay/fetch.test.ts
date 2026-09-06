import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchReplay, ReplayFetchError, DEFAULT_BASE_URL } from '../../src/replay/index.ts';
import type { ReplayDeps } from '../../src/replay/index.ts';

const OK_BODY = JSON.stringify({ id: 'gen9ou-1', log: '|turn|1\n|turn|2\n' });

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) controller.close();
      else controller.enqueue(chunks[i++]!);
    },
  });
}

function responding(body: string, init: ResponseInit = {}): ReplayDeps {
  return {
    fetch: async () => new Response(body, { status: 200, ...init }),
    baseUrl: DEFAULT_BASE_URL,
    maxBytes: 5 * 1024 * 1024,
    timeoutMs: 1000,
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '<no error thrown>';
  } catch (e) {
    assert.ok(e instanceof ReplayFetchError, `expected ReplayFetchError, got ${String(e)}`);
    return e.kind;
  }
}

test('a well-formed payload under the cap is returned', async () => {
  const payload = await fetchReplay('gen9ou-1', responding(OK_BODY));
  assert.equal(payload.id, 'gen9ou-1');
  assert.equal(payload.log, '|turn|1\n|turn|2\n');
  assert.equal(payload.raw['id'], 'gen9ou-1');
});

test('an unsafe replay id is rejected before the fetch seam is ever called', async () => {
  let called = false;
  const deps: ReplayDeps = {
    fetch: async () => {
      called = true;
      return new Response('{}');
    },
    baseUrl: DEFAULT_BASE_URL,
    maxBytes: 1024,
    timeoutMs: 1000,
  };
  for (const bad of ['../secrets', 'a/b', 'gen9ou-1/../2', '']) {
    assert.equal(await kindOf(fetchReplay(bad, deps)), 'invalid_replay_id');
  }
  assert.equal(called, false, 'the network seam must not be reached for an unsafe id');
});

test('an oversized body is rejected mid-stream, without draining it', async () => {
  const chunk = new Uint8Array(64 * 1024);
  let produced = 0;
  const deps: ReplayDeps = {
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            // Unbounded on purpose: if the cap is checked after buffering rather than
            // while reading, this test never terminates instead of failing politely.
            produced += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
    baseUrl: DEFAULT_BASE_URL,
    maxBytes: 256 * 1024,
    timeoutMs: 5000,
  };
  assert.equal(await kindOf(fetchReplay('gen9ou-1', deps)), 'replay_too_large');
  assert.ok(produced <= 256 * 1024 + chunk.byteLength * 2, `read ${produced} bytes past a 256KB cap`);
});

test('a body exactly at the cap is accepted and one byte over is rejected', async () => {
  const body = JSON.stringify({ id: 'gen9ou-1', log: '|turn|1\n' });
  const bytes = new TextEncoder().encode(body);
  const atCap: ReplayDeps = {
    fetch: async () => new Response(streamOf([bytes])),
    baseUrl: DEFAULT_BASE_URL,
    maxBytes: bytes.byteLength,
    timeoutMs: 1000,
  };
  assert.equal((await fetchReplay('gen9ou-1', atCap)).log, '|turn|1\n');

  const overCap: ReplayDeps = { ...atCap, maxBytes: bytes.byteLength - 1 };
  assert.equal(await kindOf(fetchReplay('gen9ou-1', overCap)), 'replay_too_large');
});

test('each failure shape maps to its own error kind', async () => {
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding('', { status: 404 }))), 'replay_not_found');
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding('', { status: 503 }))), 'replay_transport_failure');
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding('not json at all'))), 'replay_malformed');
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding('[1,2,3]'))), 'replay_malformed');
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding('"a string"'))), 'replay_malformed');
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding(JSON.stringify({ id: 'x' })))), 'replay_empty_log');
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding(JSON.stringify({ log: '   ' })))), 'replay_empty_log');
  assert.equal(await kindOf(fetchReplay('gen9ou-1', responding(JSON.stringify({ log: 42 })))), 'replay_empty_log');
});

test('a transport failure below the HTTP layer is classified as one', async () => {
  const deps: ReplayDeps = {
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
    baseUrl: DEFAULT_BASE_URL,
    maxBytes: 1024,
    timeoutMs: 1000,
  };
  assert.equal(await kindOf(fetchReplay('gen9ou-1', deps)), 'replay_transport_failure');
});

test('an aborted request is classified as a timeout, not a transport failure', async () => {
  const deps: ReplayDeps = {
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal!;
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    baseUrl: DEFAULT_BASE_URL,
    maxBytes: 1024,
    timeoutMs: 20,
  };
  assert.equal(await kindOf(fetchReplay('gen9ou-1', deps)), 'replay_timeout');
});

test('the request URL is built from the base URL and the id', async () => {
  let seen = '';
  const deps: ReplayDeps = {
    fetch: async (url) => {
      seen = String(url);
      return new Response(OK_BODY);
    },
    baseUrl: DEFAULT_BASE_URL,
    maxBytes: 1024 * 1024,
    timeoutMs: 1000,
  };
  await fetchReplay('gen9ou-2672899958', deps);
  assert.equal(seen, 'https://replay.pokemonshowdown.com/gen9ou-2672899958.json');
});
