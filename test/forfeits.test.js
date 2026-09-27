'use strict';

// v3 forfeit/replacement coverage: post-reveal winner forfeits, deterministic
// standby promotion in the group's shuffled order, vacant slots when standbys
// run out, the sequenced event log in the public view, and the stored-verify
// replay that flags non-winner forfeits, skipped standbys and duplicate
// replacements. v1/v2 records must stay on their original paths.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { buildApp } = require('../src/app');
const {
  commitmentFor,
  commitmentForVersion,
  snapshotDigestFor,
  computeOrder,
  computeGroupedResult,
  secretHash,
} = require('../src/lottery');

function makeApp() {
  const db = openDatabase(':memory:');
  const app = buildApp(db, { logger: false });
  return { db, app };
}

const GROUPS = [
  { name: 'red', quota: 2, candidates: ['alice', 'bob', 'carol'] },
  { name: 'blue', quota: 1, candidates: ['dave', 'erin'] },
  { name: 'observers', quota: 0, candidates: ['frank', 'grace'] },
];
const groupsOnly = () => GROUPS.map((g) => ({ name: g.name, quota: g.quota, candidates: [...g.candidates] }));

async function createRevealed(app, groups = groupsOnly(), nonce = 'n-1') {
  const created = (await app.inject({ method: 'POST', url: '/draws', payload: { groups } })).json();
  const revealed = (await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce },
  })).json();
  assert.equal(revealed.status, 'revealed');
  return { created, revealed };
}

async function forfeit(app, drawId, group, candidate) {
  return app.inject({
    method: 'POST', url: `/draws/${drawId}/forfeits`, payload: { group, candidate },
  });
}

function insertLegacy(db, { id, version = null, seed, nonce, candidates = ['alice', 'bob', 'carol'], count = 1 }) {
  const order = computeOrder(seed, nonce, candidates);
  const snapshotDigest = version === 'v2' ? snapshotDigestFor(candidates, count) : null;
  const commitment = version === 'v2'
    ? commitmentForVersion('v2', seed, snapshotDigest)
    : commitmentFor(seed);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                        result, created_at, revealed_at, protocol_version, snapshot_digest)
     VALUES (?, 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, commitment, seed, nonce, JSON.stringify(candidates), count,
    JSON.stringify({ order, winners: order.slice(0, count) }), now, now, version, snapshotDigest
  );
}

test('forfeit promotes the first standby in the group shuffled order; view shows original + effective winners + events', async () => {
  const { app } = makeApp();
  const { created, revealed } = await createRevealed(app);
  const expected = computeGroupedResult(revealed.seed, 'n-1', GROUPS);
  const [red, blue] = expected;

  // Before any forfeit: effective winners equal the original winners.
  const before = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.deepEqual(before.forfeits, []);
  assert.deepEqual(before.results[0].effectiveWinners, red.winners);
  assert.deepEqual(before.results[1].effectiveWinners, blue.winners);
  assert.deepEqual(before.results[2].effectiveWinners, []);

  // red's first winner forfeits; the first standby (red.order[2]) is promoted.
  const res = await forfeit(app, created.drawId, 'red', red.winners[0]);
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.deepEqual(body.event, {
    seq: 1,
    group: 'red',
    candidate: red.winners[0],
    replacement: red.order[2],
    createdAt: body.event.createdAt,
  });
  assert.deepEqual(body.effectiveWinners.red, [red.order[2], red.winners[1]]);
  assert.deepEqual(body.effectiveWinners.blue, blue.winners);
  assert.equal(body.forfeits.length, 1);

  // The draw query returns original results, current effective winners and
  // the forfeit/replacement events side by side.
  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.deepEqual(shown.results[0].winners, red.winners, 'original winners are preserved');
  assert.deepEqual(shown.results[0].order, red.order, 'original order is preserved');
  assert.deepEqual(shown.results[0].effectiveWinners, [red.order[2], red.winners[1]]);
  assert.equal(shown.forfeits.length, 1);
  assert.equal(shown.forfeits[0].seq, 1);
  assert.equal(shown.forfeits[0].candidate, red.winners[0]);
  assert.equal(shown.forfeits[0].replacement, red.order[2]);
  assert.ok(shown.forfeits[0].createdAt);

  // Stored verify stays valid and reports the replayed effective winners.
  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, true);
  assert.equal(report.checks.forfeitsConsistent, true);
  assert.deepEqual(report.expected.effectiveWinners.red, [red.order[2], red.winners[1]]);
  assert.equal(report.forfeits.length, 1);
});

test('a promoted replacement can forfeit again; exhausted standbys leave the slot vacant', async () => {
  const { app } = makeApp();
  const groups = [{ name: 'g', quota: 1, candidates: ['a', 'b', 'c'] }];
  const { created, revealed } = await createRevealed(app, groups, 'chain');
  const [order] = computeGroupedResult(revealed.seed, 'chain', groups).map((g) => g.order);
  const [w, s1, s2] = order;

  const f1 = (await forfeit(app, created.drawId, 'g', w)).json();
  assert.equal(f1.event.seq, 1);
  assert.equal(f1.event.replacement, s1);
  assert.deepEqual(f1.effectiveWinners.g, [s1]);

  // The replacement is now a current effective winner and may forfeit.
  const f2 = (await forfeit(app, created.drawId, 'g', s1)).json();
  assert.equal(f2.event.seq, 2);
  assert.equal(f2.event.replacement, s2);
  assert.deepEqual(f2.effectiveWinners.g, [s2]);

  // No standby remains: the slot goes vacant (null), the event is still recorded.
  const f3 = (await forfeit(app, created.drawId, 'g', s2)).json();
  assert.equal(f3.event.seq, 3);
  assert.equal(f3.event.replacement, null);
  assert.deepEqual(f3.effectiveWinners.g, [null]);

  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.deepEqual(shown.forfeits.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(shown.forfeits.map((e) => e.candidate), [w, s1, s2]);
  assert.deepEqual(shown.results[0].effectiveWinners, [null]);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, true);
  assert.equal(report.checks.forfeitsConsistent, true);
  assert.deepEqual(report.expected.effectiveWinners.g, [null]);
});

test('only current effective winners can forfeit', async () => {
  const { app } = makeApp();
  const { created, revealed } = await createRevealed(app);
  const [red, blue] = computeGroupedResult(revealed.seed, 'n-1', GROUPS);
  const standby = red.order[2]; // never won

  // A standby who never won.
  const notWinner = await forfeit(app, created.drawId, 'red', standby);
  assert.equal(notWinner.statusCode, 409);
  assert.ok(notWinner.json().message.includes(standby));
  assert.deepEqual(notWinner.json().effectiveWinners.red, red.winners);

  // A candidate of another group.
  const otherGroup = await forfeit(app, created.drawId, 'red', blue.winners[0]);
  assert.equal(otherGroup.statusCode, 409);

  // An unknown name entirely.
  assert.equal((await forfeit(app, created.drawId, 'red', 'nobody')).statusCode, 409);

  // A forfeited ex-winner cannot forfeit twice.
  assert.equal((await forfeit(app, created.drawId, 'red', red.winners[0])).statusCode, 201);
  const again = await forfeit(app, created.drawId, 'red', red.winners[0]);
  assert.equal(again.statusCode, 409);

  // The original winner list is unchanged by all of this.
  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.deepEqual(shown.results[0].winners, red.winners);
  assert.equal(shown.forfeits.length, 1);
});

test('forfeit endpoint validation: 404 unknown draw, 400 unknown group, 409 pending/legacy draws, 400 malformed body', async () => {
  const { db, app } = makeApp();

  assert.equal((await forfeit(app, 'no-such-draw', 'red', 'alice')).statusCode, 404);

  // Pending (not yet revealed) v3 draw.
  const pending = (await app.inject({ method: 'POST', url: '/draws', payload: { groups: groupsOnly() } })).json();
  const early = await forfeit(app, pending.drawId, 'red', 'alice');
  assert.equal(early.statusCode, 409);
  assert.ok(early.json().message.includes('pending'));

  // Revealed v3 draw, unknown group name.
  const { created } = await createRevealed(app);
  const unknownGroup = await forfeit(app, created.drawId, 'green', 'alice');
  assert.equal(unknownGroup.statusCode, 400);
  assert.ok(unknownGroup.json().message.includes('green'));

  // Malformed bodies are rejected by the schema.
  assert.equal((await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/forfeits`, payload: { group: 'red' },
  })).statusCode, 400);
  assert.equal((await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/forfeits`, payload: { group: 'red', candidate: '' },
  })).statusCode, 400);

  // v1/v2 legacy records are final at reveal: forfeits do not apply.
  insertLegacy(db, { id: 'legacy-v1', seed: 'a'.repeat(64), nonce: 'n' });
  insertLegacy(db, { id: 'legacy-v2', version: 'v2', seed: 'b'.repeat(64), nonce: 'n' });
  for (const id of ['legacy-v1', 'legacy-v2']) {
    const res = await forfeit(app, id, 'red', 'alice');
    assert.equal(res.statusCode, 409, id);
    assert.ok(res.json().message.includes('v3'));
  }
});

test('stored verify replays the event log and flags a forfeit by a non-winner', async () => {
  const { db, app } = makeApp();
  const { created, revealed } = await createRevealed(app);
  const [red] = computeGroupedResult(revealed.seed, 'n-1', GROUPS);

  assert.equal((await forfeit(app, created.drawId, 'red', red.winners[0])).statusCode, 201);
  assert.equal((await forfeit(app, created.drawId, 'red', red.winners[1])).statusCode, 201);

  // Tamper: the second event now names the first (already forfeited) winner.
  db.prepare('UPDATE forfeit_events SET candidate = ? WHERE draw_id = ? AND seq = 2')
    .run(red.winners[0], created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsConsistent, false);
  assert.ok(report.problems.some((p) => p.includes('非当前中奖者放弃')), report.problems.join('; '));
});

test('stored verify flags a replacement that skips an earlier standby', async () => {
  const { db, app } = makeApp();
  const groups = [{ name: 'g', quota: 1, candidates: ['a', 'b', 'c'] }];
  const { created, revealed } = await createRevealed(app, groups, 'skip');
  const [order] = computeGroupedResult(revealed.seed, 'skip', groups).map((g) => g.order);
  const [w, s1, s2] = order;

  const res = await forfeit(app, created.drawId, 'g', w);
  assert.equal(res.json().event.replacement, s1);

  // Tamper: the recorded replacement jumps over s1 to s2.
  db.prepare('UPDATE forfeit_events SET replacement = ? WHERE draw_id = ? AND seq = 1')
    .run(s2, created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsConsistent, false);
  assert.ok(report.problems.some((p) => p.includes('跳过更靠前候补')), report.problems.join('; '));
});

test('stored verify flags a duplicate replacement', async () => {
  const { db, app } = makeApp();
  const { created, revealed } = await createRevealed(app);
  const [red] = computeGroupedResult(revealed.seed, 'n-1', GROUPS);

  assert.equal((await forfeit(app, created.drawId, 'red', red.winners[0])).statusCode, 201);

  // Tamper: the replacement is someone who already holds a slot.
  db.prepare('UPDATE forfeit_events SET replacement = ? WHERE draw_id = ? AND seq = 1')
    .run(red.winners[1], created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsConsistent, false);
  assert.ok(report.problems.some((p) => p.includes('重复递补')), report.problems.join('; '));
});

test('stored verify flags a broken event sequence', async () => {
  const { db, app } = makeApp();
  const { created, revealed } = await createRevealed(app);
  const [red] = computeGroupedResult(revealed.seed, 'n-1', GROUPS);

  assert.equal((await forfeit(app, created.drawId, 'red', red.winners[0])).statusCode, 201);
  db.prepare('UPDATE forfeit_events SET seq = 7 WHERE draw_id = ? AND seq = 1').run(created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsConsistent, false);
  assert.ok(report.problems.some((p) => p.includes('forfeit sequence mismatch')), report.problems.join('; '));
});

test('multiparty v3 draws accept forfeits after the final reveal', async () => {
  const { app } = makeApp();
  const participants = ['p1', 'p2'];
  const secrets = { p1: 'p1-secret', p2: 'p2-secret' };
  const created = (await app.inject({
    method: 'POST', url: '/draws', payload: { groups: groupsOnly(), participants },
  })).json();
  for (const name of participants) {
    await app.inject({
      method: 'POST',
      url: `/draws/${created.drawId}/participants/${name}/commitment`,
      payload: { commitment: secretHash(secrets[name]) },
    });
  }
  let final;
  for (const name of participants) {
    final = (await app.inject({
      method: 'POST',
      url: `/draws/${created.drawId}/participants/${name}/reveal`,
      payload: { secret: secrets[name] },
    })).json();
  }
  assert.equal(final.status, 'revealed');
  assert.deepEqual(final.forfeits, []);

  const [red] = computeGroupedResult(final.seed, final.nonce, GROUPS);
  const res = await forfeit(app, created.drawId, 'red', red.winners[0]);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().event.replacement, red.order[2]);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, true);
  assert.equal(report.checks.forfeitsConsistent, true);
});

test('v1/v2 records keep their original view and verify shape (no forfeit fields)', async () => {
  const { db, app } = makeApp();
  insertLegacy(db, { id: 'legacy-v1', seed: 'c'.repeat(64), nonce: 'n' });
  insertLegacy(db, { id: 'legacy-v2', version: 'v2', seed: 'd'.repeat(64), nonce: 'n' });

  for (const id of ['legacy-v1', 'legacy-v2']) {
    const shown = (await app.inject({ method: 'GET', url: `/draws/${id}` })).json();
    assert.equal(shown.forfeits, undefined, `${id}: no forfeit log on legacy views`);
    assert.equal(shown.effectiveWinners, undefined);
    assert.ok(Array.isArray(shown.winners));

    const report = (await app.inject({ method: 'GET', url: `/draws/${id}/verify` })).json();
    assert.equal(report.valid, true, id);
    assert.equal(report.checks.forfeitsConsistent, undefined, `${id}: no forfeit checks on legacy verify`);
    assert.equal(report.forfeits, undefined);
  }
});
