import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTurns, estimateDuration } from '../../src/replay/index.ts';

const BRAIN = new URL('../../../../battle-brain/BattleBrain/Resources/', import.meta.url).pathname;
const ANALYSIS_DIR = join(BRAIN, 'analysis');
const REPLAY_DIR = join(BRAIN, 'replays');

/**
 * The load-bearing test for the whole ETA path: does counting `|turn|` lines in the raw
 * payload actually reproduce the turn count the engine reported after driving the log?
 * If it does not, every estimate a client sees is wrong, and the fix is to label the
 * number an upper bound instead of an estimate.
 */
test('estimateTurns reproduces totalTurns for every bundled replay', () => {
  const names = readdirSync(ANALYSIS_DIR).filter((f) => f.endsWith('.json'));
  assert.equal(names.length, 6);
  const mismatches: string[] = [];
  for (const name of names) {
    const analysis = JSON.parse(readFileSync(join(ANALYSIS_DIR, name), 'utf8'));
    const replayPath = join(REPLAY_DIR, name);
    assert.ok(existsSync(replayPath), `missing raw payload for ${name}`);
    const payload = JSON.parse(readFileSync(replayPath, 'utf8'));
    const estimated = estimateTurns(payload.log);
    if (estimated !== analysis.totalTurns) {
      mismatches.push(`${name}: estimated ${estimated}, document says ${analysis.totalTurns}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('estimateTurns is unchanged by CRLF line endings', () => {
  const lf = '|start\n|turn|1\n|move|x\n|turn|2\n';
  assert.equal(estimateTurns(lf), estimateTurns(lf.replace(/\n/g, '\r\n')));
  assert.equal(estimateTurns(lf), 2);
});

test('estimateTurns returns zero for a log with no turns', () => {
  assert.equal(estimateTurns(''), 0);
  assert.equal(estimateTurns('|start\n|player|p1|a\n'), 0);
});

test('estimateTurns does not count lines that merely mention a turn', () => {
  assert.equal(estimateTurns('|turn|1\n|c|user|turn|99\n|turn|abc\n|turn|2|extra\n'), 1);
});

test('estimateDuration scales with turns and separates the profiles', () => {
  assert.equal(estimateDuration(93, 'ladder-parity'), 93_000);
  assert.ok(estimateDuration(93, 'quick') < estimateDuration(93, 'ladder-parity'));
  assert.equal(estimateDuration(0, 'ladder-parity'), 0);
});
