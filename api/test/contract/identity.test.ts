import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveIdentity,
  identityKey,
  isSafeReplayId,
  PROFILES,
  isProfile,
  searchTimeMs,
  type AnalysisIdentity,
} from '../../src/contract/index.ts';

const BASE = { replayId: 'gen9ou-2672899958', perspective: 'p2', profile: 'ladder-parity' } as const;

test('deriveIdentity expands a profile into the eight identity fields', () => {
  const id = deriveIdentity(BASE, 'v0.0.48');
  assert.deepEqual(id, {
    replayId: 'gen9ou-2672899958',
    perspective: 'p2',
    searchBudgetMsPerTurn: 1000,
    opponentSamples: 8,
    threads: 4,
    usageStatsCutoff: 1500,
    pokeEngineTag: 'v0.0.48',
    seed: 0,
  });
});

test('identityKey is independent of key insertion order', () => {
  const a = deriveIdentity(BASE, 'v0.0.48');
  // Rebuild with the keys inserted in reverse, which is what a different code path
  // constructing the same identity would plausibly produce.
  const reversed = Object.fromEntries(Object.entries(a).reverse()) as unknown as AnalysisIdentity;
  assert.notEqual(Object.keys(a).join(), Object.keys(reversed).join(), 'test setup: orders must differ');
  assert.equal(identityKey(a), identityKey(reversed));
});

test('identityKey separates identities that differ only in seed', () => {
  const a = deriveIdentity(BASE, 'v0.0.48');
  const b: AnalysisIdentity = { ...a, seed: 1 };
  assert.notEqual(identityKey(a), identityKey(b));
});

test('identityKey separates identities that differ only in pokeEngineTag', () => {
  const a = deriveIdentity(BASE, 'v0.0.48');
  const b: AnalysisIdentity = { ...a, pokeEngineTag: 'v0.0.49' };
  assert.notEqual(identityKey(a), identityKey(b));
});

test('identityKey cannot be collided by a separator smuggled into a string field', () => {
  const a: AnalysisIdentity = { ...deriveIdentity(BASE, 'v0.0.48'), pokeEngineTag: 'v1&seed=9' };
  const b: AnalysisIdentity = { ...deriveIdentity(BASE, 'v0.0.48'), pokeEngineTag: 'v1', seed: 9 };
  assert.notEqual(identityKey(a), identityKey(b));
});

test('the two profiles expand to different budgets', () => {
  assert.notEqual(PROFILES['ladder-parity'].searchBudgetMsPerTurn, PROFILES.quick.searchBudgetMsPerTurn);
  assert.equal(isProfile('ladder-parity'), true);
  assert.equal(isProfile('nope'), false);
});

test('searchTimeMs scales with turns and differs between profiles', () => {
  assert.equal(searchTimeMs(93, 'ladder-parity'), 93_000);
  assert.equal(searchTimeMs(93, 'quick'), 18_600);
  assert.ok(searchTimeMs(93, 'quick') < searchTimeMs(93, 'ladder-parity'));
});

test('isSafeReplayId rejects traversal and separators before any URL is built', () => {
  assert.equal(isSafeReplayId('gen9ou-2672899958'), true);
  for (const bad of ['../etc/passwd', 'a/b', 'gen9ou-1/../2', '', 'http://x', '.hidden', 'a b']) {
    assert.equal(isSafeReplayId(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});
