import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SchemaV1DocumentSchema, SubmitRequestSchema } from '../../src/contract/index.ts';

/**
 * The six real analyses battle-brain bundles. Validating against these rather than
 * against a hand-written sample is the point: a schema written from the Swift struct
 * alone would not have caught that the real documents carry `rating` and `players`.
 */
const FIXTURE_DIR = new URL('../../../../battle-brain/BattleBrain/Resources/analysis/', import.meta.url).pathname;

function fixtures(): { name: string; doc: unknown }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((name) => ({ name, doc: JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) }));
}

test('all six real fixtures validate', () => {
  const all = fixtures();
  assert.equal(all.length, 6, 'expected six bundled fixtures');
  for (const { name, doc } of all) {
    const result = SchemaV1DocumentSchema.safeParse(doc);
    assert.equal(result.success, true, `${name} failed: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  }
});

test('validation preserves keys the Swift struct does not decode', () => {
  const { doc } = fixtures()[0]!;
  const parsed = SchemaV1DocumentSchema.parse(doc) as Record<string, unknown>;
  assert.ok('rating' in parsed, 'rating must survive validation');
  assert.ok('players' in parsed, 'players must survive validation');
  assert.deepEqual(parsed, doc, 'validation must not rewrite the document');
});

test('a document with a null winProbability still validates', () => {
  const { doc } = fixtures()[0]! as { doc: Record<string, any> };
  const mutated = structuredClone(doc);
  mutated.turns[0].winProbability = null;
  assert.equal(SchemaV1DocumentSchema.safeParse(mutated).success, true);
});

test('schemaVersion 2 is rejected with the found version named', () => {
  const { doc } = fixtures()[0]! as { doc: Record<string, any> };
  const mutated = { ...doc, schemaVersion: 2 };
  const result = SchemaV1DocumentSchema.safeParse(mutated);
  assert.equal(result.success, false);
  const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' ');
  assert.match(message, /expected 1/);
  assert.match(message, /found 2/);
});

test('a missing schemaVersion is rejected', () => {
  const { doc } = fixtures()[0]! as { doc: Record<string, any> };
  const { schemaVersion: _dropped, ...withoutVersion } = doc;
  assert.equal(SchemaV1DocumentSchema.safeParse(withoutVersion).success, false);
});

test('a non-finite visitShare is rejected', () => {
  const { doc } = fixtures()[0]! as { doc: Record<string, any> };
  const mutated = structuredClone(doc);
  mutated.turns[0].topActions[0].visitShare = Number.POSITIVE_INFINITY;
  assert.equal(SchemaV1DocumentSchema.safeParse(mutated).success, false);
});

test('SubmitRequest defaults the profile and accepts a valid body', () => {
  const parsed = SubmitRequestSchema.parse({ replayId: 'gen9ou-2672899958', perspective: 'p1' });
  assert.equal(parsed.profile, 'ladder-parity');
});

test('SubmitRequest rejects an unknown profile, a bad perspective, and an unsafe id', () => {
  const cases = [
    { replayId: 'gen9ou-1', perspective: 'p1', profile: 'exhaustive' },
    { replayId: 'gen9ou-1', perspective: 'p3', profile: 'quick' },
    { replayId: '../secrets', perspective: 'p1', profile: 'quick' },
    { replayId: 'a/b', perspective: 'p1', profile: 'quick' },
    { replayId: 'gen9ou-1/../2', perspective: 'p1', profile: 'quick' },
    { replayId: 'gen9ou-1', perspective: 'p1', profile: 'quick', extra: 'field' },
  ];
  for (const body of cases) {
    assert.equal(SubmitRequestSchema.safeParse(body).success, false, `expected rejection: ${JSON.stringify(body)}`);
  }
});
