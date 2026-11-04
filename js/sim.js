// A simulated RPLIDAR A1 in a simulated room. It speaks the same byte protocol as the real one, so Sweep's
// demo, and its tests, run through exactly the code a real lidar does: driver, parser, capture and plan.
//
// Rooms are drawn in metres, y up. The lidar stands at `scanner` and its 0 degree mark points `heading` degrees
// clockwise from +y. Things lower than the beam (sofas, beds, counters) don't exist for it; glass mostly lets the
// beam through; surfaces seen nearly edge-on often return nothing, as on the real thing.

import { CMD, TYPE, LENGTH, SYNC1, descriptor, encodeNode, Parser, command } from './protocol.js';
import { Revolutions, makeLook } from './capture.js';
import { DEG, sub, add, mul, dot, cross, len, norm, dist, rng } from './geom.js';

const WALL = 0.12; // wall thickness, for door jambs and what lies beyond an opening

export const SAMPLE_ROOMS = [
  {
    id: 'living',
    name: 'Living room',
    // 15 ft x 19 ft, a door, a picture window and an archway; a tall bookcase against the left wall
    outline: [[0, 0], [4.57, 0], [4.57, 5.79], [0, 5.79]],
    openings: [
      { edge: 0, from: 0.55, width: 0.91, kind: 'door', depth: 1.1 },
      { edge: 1, from: 1.9, width: 1.83, kind: 'glass' },
      { edge: 2, from: 1.25, width: 1.52, kind: 'arch', depth: 3.2 },
    ],
    objects: [
      { type: 'box', x: 0, y: 2.05, w: 0.35, d: 1.2, height: 1.95 }, // bookcase
      { type: 'box', x: 1.3, y: 0.3, w: 2.0, d: 0.9, height: 0.85 }, // sofa: under the beam
      { type: 'circle', x: 4.22, y: 5.42, r: 0.2, height: 1.5 }, // plant
      { type: 'circle', x: 0.42, y: 0.4, r: 0.015, height: 1.6 }, // floor lamp
    ],
    scanner: { x: 2.3, y: 2.75, heading: 14 },
    person: [{ d: 0.7, a: 200 }, { d: 0.7, a: 30 }],
  },
  {
    id: 'kitchen',
    name: 'Kitchen',
    // an L: 20 ft x 16 ft with a 7 ft x 7.5 ft corner taken out; a patio door, a doorway, a fridge in the corner
    outline: [[0, 0], [6.1, 0], [6.1, 2.6], [3.9, 2.6], [3.9, 4.9], [0, 4.9]],
    openings: [
      { edge: 5, from: 1.9, width: 1.8, kind: 'glass' },
      { edge: 4, from: 2.0, width: 0.9, kind: 'door', depth: 1.2 },
    ],
    objects: [
      { type: 'box', x: 5.0, y: 0, w: 0.9, d: 0.75, height: 1.8 }, // fridge
      { type: 'box', x: 1.6, y: 2.1, w: 1.8, d: 0.9, height: 0.92 }, // island: under the beam
    ],
    scanner: { x: 2.2, y: 1.5, heading: -8 },
    person: [{ d: 0.75, a: 120 }, { d: 0.75, a: 300 }],
  },
  {
    id: 'bedroom',
    name: 'Bedroom',
    // 12 ft x 14 ft with a 2 ft deep closet, a door, a window; a wardrobe on the left wall
    outline: [[0, 0], [3.66, 0], [3.66, 1.2], [4.27, 1.2], [4.27, 3.03], [3.66, 3.03], [3.66, 4.27], [0, 4.27]],
    openings: [
      { edge: 0, from: 0.3, width: 0.81, kind: 'door', depth: 1.0 },
      { edge: 6, from: 1.25, width: 1.22, kind: 'glass' },
    ],
    objects: [
      { type: 'box', x: 0, y: 1.5, w: 0.6, d: 1.2, height: 2.0 }, // wardrobe
      { type: 'box', x: 0.9, y: 2.2, w: 1.6, d: 2.0, height: 0.6 }, // bed: under the beam
    ],
    scanner: { x: 1.95, y: 2.05, heading: 31 },
    person: [{ d: 0.7, a: 160 }, { d: 0.7, a: 340 }],
  },
];

// A quick capture straight off the simulator, no transport or timers: for the home page's example plan.
export function simulateLooks(spec, { seconds = 2.5, looks = 1, seed = 5 } = {}) {
  const sim = new SimLidar(spec, { seed });
  const parser = new Parser();
  sim.connect(b => parser.push(b));
  const out = [];
  for (let k = 0; k < looks; k++) {
    const revs = [];
    let t = 0;
    const R = new Revolutions(rev => revs.push(rev));
    parser.onNodes = nodes => R.push(nodes, t);
    parser.expect(TYPE.SCAN, LENGTH.SCAN).catch(() => {});
    sim.receive(command(CMD.SCAN));
    while (t < seconds * 1000 + 20) { sim.tick(10); t += 10; }
    out.push(makeLook(revs, { hz: R.hz }));
    sim.receive(command(CMD.STOP));
    sim.tick(10);
    parser.reset();
    sim.hint('captured');
  }
  return out;
}

// Turns a room spec into segments and circles the beam can hit.
export function buildRoom(spec, scanHeight = 1.25) {
  const segs = [];
  const circles = [];
  const V = spec.outline;
  const n = V.length;
  for (let i = 0; i < n; i++) {
    const a = V[i], b = V[(i + 1) % n];
    const L = dist(a, b);
    const u = norm(sub(b, a));
    const out = [u[1], -u[0]]; // the outline runs anticlockwise, so outside is on the right
    const at = (t, off = 0) => add(add(a, mul(u, t)), mul(out, off));
    const ops = (spec.openings || []).filter(o => o.edge === i).sort((p, q) => p.from - q.from);
    let cursor = 0;
    for (const o of ops) {
      if (o.from > cursor) segs.push({ a: at(cursor), b: at(o.from), kind: 'wall', refl: 0.8 });
      const t0 = o.from, t1 = o.from + o.width;
      segs.push({ a: at(t0), b: at(t0, WALL), kind: 'wall', refl: 0.8 }); // jambs
      segs.push({ a: at(t1), b: at(t1, WALL), kind: 'wall', refl: 0.8 });
      if (o.kind === 'glass') {
        segs.push({ a: at(t0, WALL / 2), b: at(t1, WALL / 2), kind: 'glass', refl: 0.3 });
        // a couple of trees outside, beyond the lidar's reach for most rays
        circles.push({ c: at((t0 + t1) / 2 - 0.6, 7.5), r: 0.35, refl: 0.6 });
        circles.push({ c: at((t0 + t1) / 2 + 1.4, 10.5), r: 0.4, refl: 0.6 });
      } else {
        const d = o.depth || 1.2, m = 1.6;
        segs.push({ a: at(t0 - m, WALL + d), b: at(t1 + m, WALL + d), kind: 'beyond', refl: 0.8 });
        segs.push({ a: at(t0 - m, WALL), b: at(t0 - m, WALL + d), kind: 'beyond', refl: 0.8 });
        segs.push({ a: at(t1 + m, WALL), b: at(t1 + m, WALL + d), kind: 'beyond', refl: 0.8 });
      }
      cursor = t1;
    }
    if (cursor < L) segs.push({ a: at(cursor), b: at(L), kind: 'wall', refl: 0.8 });
  }
  for (const o of spec.objects || []) {
    if ((o.height ?? 2) <= scanHeight) continue;
    if (o.type === 'box') {
      const p = [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.d], [o.x, o.y + o.d]];
      for (let k = 0; k < 4; k++) segs.push({ a: p[k], b: p[(k + 1) % 4], kind: 'object', refl: 0.6 });
    } else if (o.type === 'circle') {
      circles.push({ c: [o.x, o.y], r: o.r, refl: 0.5 });
    }
  }
  return { segs, circles };
}

// The nearest thing a ray from o along u (unit) hits, skipping `skip`.
export function cast(room, o, u, skip = null) {
  let best = { t: Infinity };
  for (const s of room.segs) {
    if (s === skip) continue;
    const e = sub(s.b, s.a);
    const den = cross(u, e);
    if (Math.abs(den) < 1e-12) continue;
    const w = sub(s.a, o);
    const t = cross(w, e) / den;
    const k = cross(w, u) / den;
    if (t > 1e-6 && k >= 0 && k <= 1 && t < best.t) {
      let nn = norm([-e[1], e[0]]);
      if (dot(nn, u) > 0) nn = [-nn[0], -nn[1]];
      best = { t, kind: s.kind, refl: s.refl, n: nn, seg: s };
    }
  }
  for (const c of room.circles) {
    const w = sub(c.c, o);
    const tc = dot(w, u);
    const d2 = dot(w, w) - tc * tc;
    if (d2 > c.r * c.r) continue;
    const t = tc - Math.sqrt(c.r * c.r - d2);
    if (t > 1e-6 && t < best.t) {
      const p = add(o, mul(u, t));
      best = { t, kind: c.kind || 'object', refl: c.refl, n: norm(sub(p, c.c)), seg: c };
    }
  }
  return best;
}

// The simulated lidar: commands in, answers and a measurement stream out.
export class SimLidar {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.room = buildRoom(spec, opts.scanHeight);
    this.rand = rng(opts.seed ?? 1);
    this.rate = opts.rate ?? 6.2; // revolutions per second
    this.sps = opts.sps ?? 2000; // samples per second, standard scan
    this.motor = true;
    this.spunUpAt = 0;
    this.scanning = false;
    this.now = 0;
    this.head = this.rand() * 360; // the spinning head's angle
    this.carry = 0; // fractional samples owed
    this.queue = []; // [at, bytes] answers waiting to go out
    this.emit = null;
    this.personIndex = 0;
    this.chunk = opts.chunk ?? 0; // >0: split output into random chunks up to this size, as USB does
    this.rx = [];
  }

  connect(emit) { this.emit = emit; }
  disconnect() { this.emit = null; this.scanning = false; }

  setMotor(on) {
    if (on && !this.motor) this.spunUpAt = this.now + 400;
    this.motor = on;
  }

  // The app tells the demo a look is done, so the simulated person moves out of the way.
  hint(ev) { if (ev === 'captured') this.personIndex++; }

  send(bytes, delay = 2) { this.queue.push([this.now + delay, Uint8Array.from(bytes)]); }

  receive(bytes) {
    for (const b of bytes) this.rx.push(b);
    while (this.rx.length >= 2) {
      if (this.rx[0] !== SYNC1) { this.rx.shift(); continue; }
      const cmd = this.rx[1];
      if (cmd >= 0x80) { // commands with a payload: size byte, payload, checksum
        if (this.rx.length < 3 || this.rx.length < 4 + this.rx[2]) break;
        this.rx.splice(0, 4 + this.rx[2]);
        continue;
      }
      this.rx.splice(0, 2);
      this.command(cmd);
    }
  }

  command(cmd) {
    if (cmd === CMD.STOP) { this.scanning = false; return; }
    if (cmd === CMD.RESET) {
      this.scanning = false;
      this.send(new TextEncoder().encode('RP LIDAR System.\r\nFirmware Ver 1.29 - rtm, HW Ver 7\r\nModel: 18\r\n'), 120);
      return;
    }
    if (cmd === CMD.GET_INFO) {
      const serial = [];
      for (let i = 0; i < 16; i++) serial.push(Math.floor(this.rand() * 256));
      this.send([...descriptor(TYPE.INFO, LENGTH.INFO), 0x18, 29, 1, 7, ...serial]);
      return;
    }
    if (cmd === CMD.GET_HEALTH) { this.send([...descriptor(TYPE.HEALTH, LENGTH.HEALTH), 0, 0, 0]); return; }
    if (cmd === CMD.GET_SAMPLERATE) { this.send([...descriptor(TYPE.SAMPLERATE, LENGTH.SAMPLERATE), 0xf4, 0x01, 0xfa, 0x00]); return; }
    if (cmd === CMD.SCAN || cmd === CMD.FORCE_SCAN) {
      this.send(descriptor(TYPE.SCAN, LENGTH.SCAN, true));
      this.scanning = true;
      this.scanFrom = this.now + 3;
    }
  }

  // One measurement at the head's current angle.
  measure(theta) {
    const sc = this.spec.scanner;
    const phi = (sc.heading + theta) * DEG;
    const u = [Math.sin(phi), Math.cos(phi)];
    const o = [sc.x, sc.y];
    const R = this.rand;
    let hit = this.castWithPerson(o, u);
    if (hit.kind === 'glass') {
      const x = R();
      if (x < 0.7) {
        const p = add(o, mul(u, hit.t));
        const beyond = cast(this.room, p, u, hit.seg);
        hit = beyond.t < Infinity ? { ...beyond, t: beyond.t + hit.t } : { t: Infinity };
      } else if (x > 0.85) hit = { t: Infinity };
    }
    if (!(hit.t < 12)) return [0, 0];
    const inc = Math.acos(Math.min(1, Math.abs(dot(hit.n, u)))) / DEG;
    let drop = 0.01;
    if (inc > 62) drop += 0.85 * ((inc - 62) / 28) ** 2;
    if (hit.t > 7) drop += 0.25;
    if (R() < drop) return [0, 0];
    const r = hit.t + R.normal() * (0.002 + 0.004 * hit.t);
    const q = Math.max(1, Math.min(63, Math.round(47 * hit.refl * (1 - hit.t / 14) * Math.cos(inc * DEG) ** 0.3)));
    return [q, Math.max(0, r)];
  }

  castWithPerson(o, u) {
    const hit = cast(this.room, o, u);
    const spot = (this.spec.person || [])[this.personIndex];
    if (!spot) return hit;
    const sc = this.spec.scanner;
    const a = (sc.heading + spot.a) * DEG;
    const c = add(o, [Math.sin(a) * spot.d, Math.cos(a) * spot.d]);
    const w = sub(c, o);
    const tc = dot(w, u);
    const d2 = dot(w, w) - tc * tc;
    const r = 0.2;
    if (d2 > r * r) return hit;
    const t = tc - Math.sqrt(r * r - d2);
    if (t > 0 && t < hit.t) return { t, kind: 'person', refl: 0.5, n: norm(sub(add(o, mul(u, t)), c)) };
    return hit;
  }

  // Run the clock forward by ms, sending whatever is due.
  tick(ms) {
    const end = this.now + ms;
    const out = [];
    while (this.queue.length && this.queue[0][0] <= end) {
      const [, bytes] = this.queue.shift();
      for (const b of bytes) out.push(b);
    }
    if (this.scanning && this.motor && end > this.spunUpAt && end > this.scanFrom) {
      const dtSec = (end - Math.max(this.now, this.spunUpAt, this.scanFrom)) / 1000;
      this.carry += this.sps * dtSec;
      const rate = this.rate * (1 + 0.01 * this.rand.normal());
      const step = (360 * rate) / this.sps;
      while (this.carry >= 1) {
        this.carry -= 1;
        const before = this.head;
        this.head += step * (1 + 0.02 * this.rand.normal());
        const start = Math.floor(this.head / 360) > Math.floor(before / 360);
        this.head %= 360;
        const reported = this.head + 0.08 * this.rand.normal();
        const theta = ((reported % 360) + 360) % 360;
        const [q, r] = this.measure(theta);
        const q6 = Math.round(theta * 64) % (360 * 64);
        const q2 = Math.min(65535, Math.round(r * 1000 * 4));
        for (const b of encodeNode(start, q, q6, q2)) out.push(b);
      }
    }
    this.now = end;
    if (out.length && this.emit) {
      if (this.chunk > 0) {
        let i = 0;
        while (i < out.length) {
          const n = 1 + Math.floor(this.rand() * this.chunk);
          this.emit(Uint8Array.from(out.slice(i, i + n)));
          i += n;
        }
      } else this.emit(Uint8Array.from(out));
    }
  }
}
