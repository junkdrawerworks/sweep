// Shared by the unit tests: run a simulated room through the real byte protocol into looks.
import { SimLidar } from '../../js/sim.js';
import { Parser, CMD, TYPE, LENGTH, command } from '../../js/protocol.js';
import { Revolutions, makeLook } from '../../js/capture.js';
import { polygonArea, bbox, dist } from '../../js/geom.js';

// Captures `looks` looks of `seconds` each, moving the simulated person between them, as the app does.
export async function captureLooks(spec, { seconds = 3, looks = 1, seed = 7, rate = 6.2, chunk = 64, scanHeight } = {}) {
  const sim = new SimLidar(spec, { seed, rate, chunk, scanHeight });
  const parser = new Parser();
  sim.connect(b => parser.push(b));
  const out = [];
  for (let k = 0; k < looks; k++) {
    let revs = [];
    let t = 0;
    const R = new Revolutions(rev => revs.push(rev));
    parser.onNodes = nodes => R.push(nodes, t);
    const started = parser.expect(TYPE.SCAN, LENGTH.SCAN);
    sim.receive(command(CMD.SCAN));
    for (let i = 0; i < 2; i++) { sim.tick(5); t += 5; }
    await started;
    revs = []; // drop anything before the countdown ends, as the app does
    const end = t + seconds * 1000;
    while (t < end) { sim.tick(10); t += 10; }
    out.push(makeLook(revs, { hz: R.hz }));
    sim.receive(command(CMD.STOP));
    sim.tick(10);
    parser.reset();
    sim.hint('captured');
  }
  return out;
}

// The true room: its walls as runs, overall size and area, from the spec.
export function truth(spec) {
  const V = spec.outline;
  const box = bbox(V);
  return {
    w: box.w,
    h: box.h,
    area: Math.abs(polygonArea(V)),
    walls: V.map((a, i) => dist(a, V[(i + 1) % V.length])),
    openings: (spec.openings || []).map(o => o.width),
  };
}
