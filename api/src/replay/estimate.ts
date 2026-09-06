import { searchTimeMs, type Profile } from '../contract/index.ts';

/**
 * Turn count from a raw Showdown protocol log, by counting `|turn|N` lines.
 *
 * This exists because `analyze_replay` is one blocking call with no progress callback,
 * so a job cannot report real progress. Counting turns before the search starts is the
 * one thing available cheaply, and it is enough for an ETA. Everything derived from it
 * is named an estimate for that reason.
 *
 * CRLF is normalized first. A CRLF payload is ordinary third-party network output, and
 * the engine's own `analyze_replay` normalizes it for the same reason: leaving it would
 * make `|turn|1\r` fail to match and silently undercount.
 */
export function estimateTurns(log: string): number {
  const normalized = log.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let count = 0;
  for (const line of normalized.split('\n')) {
    if (/^\|turn\|\d+$/.test(line)) count += 1;
  }
  return count;
}

/**
 * Lower bound on how long a job will take, in milliseconds. Search time only: parsing,
 * state translation, and worker startup are excluded, so a client shown this should be
 * told it is a floor.
 */
export function estimateDuration(turns: number, profile: Profile): number {
  return searchTimeMs(turns, profile);
}
