// From looks to a floor plan, checked against the simulated rooms' true measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_ROOMS } from '../../js/sim.js';
import { makePlan } from '../../js/plan.js';
import { planSvg } from '../../js/render.js';
import { fmtLength } from '../../js/units.js';
import { captureLooks, truth } from './helpers.mjs';

const sorted = a => [...a].sort((x, y) => x - y);
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got.toFixed(4)} against ${want.toFixed(4)} (allowed ${tol})`);

for (const spec of SAMPLE_ROOMS) {
  test(`${spec.name}, two looks: size, area, every wall and every opening`, async () => {
    const looks = await captureLooks(spec, { looks: 2, seconds: 3, seed: 3 });
    const plan = makePlan(looks);
    const T = truth(spec);
    assert.equal(plan.rough, false);
    near(plan.box.w, T.w, 0.01, 'width');
    near(plan.box.h, T.h, 0.01, 'depth');
    near(plan.area, T.area, T.area * 0.005, 'area');
    assert.equal(plan.runs.length, T.walls.length, 'number of walls');
    const runs = sorted(plan.runs.map(r => r.len)), walls = sorted(T.walls);
    runs.forEach((len, i) => near(len, walls[i], 0.02, `wall ${i + 1} (shortest first)`));
    const found = sorted(plan.openings.map(o => o.width)), want = sorted(T.openings);
    assert.equal(found.length, want.length, `openings: found ${found.map(v => v.toFixed(2))}, want ${want}`);
    found.forEach((w, i) => near(w, want[i], 0.08, `opening ${i + 1} (narrowest first)`));
    // Rotated square to the drawing: the plan is turned by the lidar's heading in the room.
    const off = ((plan.rotation + spec.scanner.heading) % 90 + 90) % 90;
    assert.ok(Math.min(off, 90 - off) < 1, `rotation ${plan.rotation} against heading ${spec.scanner.heading}`);
  });
}

test('one look with someone standing by the lidar: the plan warns about the blocked view', async () => {
  const looks = await captureLooks(SAMPLE_ROOMS[0], { looks: 1, seconds: 3, seed: 3 });
  const plan = makePlan(looks);
  assert.ok(plan.blocked.length >= 1, 'blocked view expected');
  const deg = plan.blocked.reduce((s, b) => s + b.width, 0);
  assert.ok(deg > 15 && deg < 60, `${deg} degrees blocked`);
  const T = truth(SAMPLE_ROOMS[0]);
  near(plan.box.w, T.w, 0.02, 'width');
});

test('with nobody in the way, one look is enough', async () => {
  for (const spec of SAMPLE_ROOMS) {
    const looks = await captureLooks({ ...spec, person: [] }, { looks: 1, seconds: 2.5, seed: 5 });
    const plan = makePlan(looks);
    const T = truth(spec);
    assert.equal(plan.blocked.length, 0, `${spec.name}: nothing should be blocked`);
    near(plan.box.w, T.w, 0.015, `${spec.name} width`);
    near(plan.box.h, T.h, 0.015, `${spec.name} depth`);
    near(plan.area, T.area, T.area * 0.01, `${spec.name} area`);
  }
});

test('a distance correction scales every length', async () => {
  const looks = await captureLooks({ ...SAMPLE_ROOMS[2], person: [] }, { looks: 1, seconds: 2.5, seed: 6 });
  const a = makePlan(looks);
  const b = makePlan(looks, { correction: 1.02 });
  near(b.box.w / a.box.w, 1.02, 0.002, 'width ratio');
  near(b.area / a.area, 1.02 ** 2, 0.004, 'area ratio');
});

test('without straightening, the walls still come out within a few centimetres', async () => {
  const spec = { ...SAMPLE_ROOMS[0], person: [] };
  const looks = await captureLooks(spec, { looks: 1, seconds: 3, seed: 4 });
  const plan = makePlan(looks, { straighten: false });
  const T = truth(spec);
  assert.equal(plan.rough, false);
  near(plan.box.w, T.w, 0.04, 'width');
  near(plan.area, T.area, T.area * 0.02, 'area');
});

test('the same looks always give the same plan', async () => {
  const looks = await captureLooks(SAMPLE_ROOMS[1], { looks: 2, seconds: 2, seed: 9 });
  assert.deepEqual(JSON.stringify(makePlan(looks).outline), JSON.stringify(makePlan(looks).outline));
});

test('an empty look gives a rough plan, not an exception', () => {
  const plan = makePlan([{ revs: 0, q6: new Uint16Array(0), q2: new Uint16Array(0), starts: [] }]);
  assert.equal(plan.rough, true);
});

test('the drawing labels every wall with its length, and has no NaN in it', async () => {
  const looks = await captureLooks(SAMPLE_ROOMS[1], { looks: 2, seconds: 2.5, seed: 3 });
  const plan = makePlan(looks);
  for (const units of ['ft', 'm']) {
    const svg = planSvg(plan, { width: 600, height: 600, units, title: 'Kitchen', date: 'today' });
    assert.ok(!/NaN|undefined|Infinity/.test(svg), 'NaN in the drawing');
    for (const [i, r] of plan.runs.entries()) {
      const label = new RegExp(`data-run="${i}">${fmtLength(r.len, units)}<`);
      assert.match(svg, label, `wall ${i + 1}'s label`);
    }
    assert.equal((svg.match(/ opening</g) || []).length, plan.openings.length);
  }
});
