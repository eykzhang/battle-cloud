import { isSafeReplayId } from '../contract/index.ts';
import { ReplayFetchError } from './errors.ts';

export interface ReplayPayload {
  readonly id: string;
  readonly log: string;
  readonly raw: Record<string, unknown>;
}

export interface ReplayDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly baseUrl: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export const DEFAULT_BASE_URL = 'https://replay.pokemonshowdown.com/';

/**
 * 5 MB. The largest of battle-brain's six bundled payloads is about 30 KB and a real log
 * is bounded by how many turns a battle can take, so this is well over a hundred times
 * the largest real payload. It exists to stop a fast or hostile host forcing this process
 * to buffer an arbitrarily large body, which matters more here than on the phone: this
 * process serves every user, so one oversized response is a shared-resource problem.
 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Read a body with a hard byte ceiling, cancelling the stream the moment the ceiling is
 * crossed.
 *
 * The cap is enforced while reading rather than after, which is the part battle-brain's
 * own `ReplaySource` documents as unfixed on its side: `URLSession.data(from:)` hands
 * back a complete `Data`, so the iOS check can only bound what the app retains, never
 * what the transport already buffered. Node exposes the stream, so the bound is real
 * here. Never replace this with `response.text()`.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) {
    throw new ReplayFetchError('replay_malformed', 'response had no body');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ReplayFetchError(
          'replay_too_large',
          `replay body exceeded ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Fetch a replay payload from Showdown by id.
 *
 * The server fetches by id rather than accepting a client-uploaded payload. That keeps an
 * analysis cache-keyed and shareable by id, and it stops a caller handing this service a
 * large blob to spend a core-minute of search on.
 *
 * The payload is third-party input. It is validated only as far as this tier needs
 * (it is an object, it has a non-empty string `log`); everything about its *content* is
 * left to the engine, which already rejects malformed `players`/`id`/`formatid` fields,
 * unsafe ids, truncated protocol lines, and deep-nested JSON. Duplicating those checks
 * here would mean two implementations of one rule drifting apart.
 */
export async function fetchReplay(replayId: string, deps: ReplayDeps): Promise<ReplayPayload> {
  // Before any URL is constructed. A traversal or scheme-smuggling id must never reach
  // the network layer at all, so this cannot be folded into the request path.
  if (!isSafeReplayId(replayId)) {
    throw new ReplayFetchError('invalid_replay_id', `unsafe replay id: ${JSON.stringify(replayId)}`);
  }

  const url = new URL(`${replayId}.json`, deps.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  let response: Response;
  try {
    response = await deps.fetch(url, { signal: controller.signal });
  } catch (cause) {
    clearTimeout(timer);
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new ReplayFetchError('replay_timeout', `replay fetch timed out after ${deps.timeoutMs}ms`, { cause });
    }
    throw new ReplayFetchError('replay_transport_failure', `replay fetch failed: ${String(cause)}`, { cause });
  }

  try {
    if (response.status === 404) {
      throw new ReplayFetchError('replay_not_found', `no replay at ${url.href}`);
    }
    if (!response.ok) {
      throw new ReplayFetchError('replay_transport_failure', `replay fetch returned HTTP ${response.status}`);
    }

    const text = await readCapped(response, deps.maxBytes);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new ReplayFetchError('replay_malformed', 'replay body was not valid JSON', { cause });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ReplayFetchError('replay_malformed', 'replay body was not a JSON object');
    }

    const raw = parsed as Record<string, unknown>;
    const log = raw['log'];
    // A 200 carrying no usable log is the shape a private replay returns. It is a
    // distinct outcome from a 404, and collapsing the two would tell a user their
    // replay does not exist when it does.
    if (typeof log !== 'string' || log.trim() === '') {
      throw new ReplayFetchError('replay_empty_log', `replay ${replayId} returned no usable log`);
    }

    return { id: replayId, log, raw };
  } finally {
    clearTimeout(timer);
  }
}
