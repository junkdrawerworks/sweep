// Measurements into turns of the lidar, turns into looks, and looks into storage and back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Revolutions, makeLook, encodeLook, decodeLook, lookPoints } from '../../js/capture.js';

// n turns of 360 measurements at `hz`, every tenth measurement with no return (quality 0).
function turns(n, hz = 6) {
  const out = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 360; i++) out.push({ t: (k + i / 360) / hz * 1000, node: { start: i === 0, quality: i % 10 ? 40 : 0, q6: i * 64, q2: 4000 + i } });
  }
  return out;
}

test('a turn ends when the next one starts; a part turn at the start is dropped', () => {
  const got = [];
  const R = new Revolutions(r => got.push(r));
  const nodes = turns(5);
  R.push(nodes.slice(200, 360).map(x => x.node), 0); // the end of a turn already under way
  for (let k = 1; k < 5; k++) R.push(nodes.slice(k * 360, (k + 1) * 360).map(x => x.node), nodes[k * 360].t);
  R.push([{ start: true, quality: 40, q6: 0, q2: 4000 }], 5 / 6 * 1000);
  assert.equal(got.length, 4);
  assert.equal(got[0].q6.length, 360);
  assert.ok(Math.abs(R.hz - 6) < 0.01, `hz ${R.hz}`);
  assert.equal(R.angle, 0);
});

test('a look keeps only real returns, and where each turn starts', () => {
  const revs = [];
  const R = new Revolutions(r => revs.push(r));
  const nodes = turns(4);
  for (let k = 0; k < 4; k++) R.push(nodes.slice(k * 360, (k + 1) * 360).map(x => x.node), nodes[k * 360].t);
  R.push([{ start: true, quality: 40, q6: 0, q2: 4000 }], 700);
  const look = makeLook(revs, { hz: 6 });
  assert.equal(look.revs, 4);
  assert.equal(look.q6.length, 4 * 324); // 36 of every 360 had no return
  assert.deepEqual(look.starts, [0, 324, 648, 972]);
  assert.equal(look.hz, 6);
});

test('a look survives being stored and read back', () => {
  const look = { at: 1730000000000, revs: 2, hz: 5.876, q6: Uint16Array.from([0, 64, 23039, 100]), q2: Uint16Array.from([4000, 65535, 1, 22222]), starts: [0, 2] };
  const stored = JSON.parse(JSON.stringify(encodeLook(look)));
  assert.equal(stored.hz, 5.88);
  const back = decodeLook(stored);
  assert.deepEqual([...back.q6], [...look.q6]);
  assert.deepEqual([...back.q2], [...look.q2]);
  assert.deepEqual(back.starts, [0, 2]);
  assert.throws(() => decodeLook({ ...stored, d: stored.d.slice(0, 4) }), /do not match/);
});

test('points in degrees and metres, with the correction applied', () => {
  const look = { revs: 2, q6: Uint16Array.from([0, 5760, 11520, 17280]), q2: Uint16Array.from([4000, 8000, 4000, 2000]), starts: [0, 2] };
  const pts = lookPoints(look, 1.01);
  assert.deepEqual(pts.map(p => p.a), [0, 90, 180, 270]);
  assert.deepEqual(pts.map(p => p.rev), [0, 0, 1, 1]);
  assert.ok(Math.abs(pts[1].r - 2.02) < 1e-12);
});
