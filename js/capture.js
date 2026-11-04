// From a stream of measurements to revolutions, and from revolutions to a "look": everything the lidar saw from
// one spot in a few seconds. A room is one or more looks from the same spot.

export class Revolutions {
  constructor(onRevolution) {
    this.onRevolution = onRevolution;
    this.cur = null;
    this.starts = []; // timestamps of recent revolution starts
    this.counts = []; // [time, samples] for the samples-per-second figure
    this.last = null; // the last completed revolution
    this.angle = 0; // the newest measurement's angle, for the beam on the live view
  }

  push(nodes, now = Date.now()) {
    this.counts.push([now, nodes.length]);
    while (this.counts.length && now - this.counts[0][0] > 2000) this.counts.shift();
    for (const n of nodes) {
      if (n.start) {
        if (this.cur && this.cur.q6.length >= 30) this.finish(this.cur);
        this.cur = { t: now, q6: [], q2: [], q: [] };
        this.starts.push(now);
        while (this.starts.length > 12) this.starts.shift();
      }
      if (!this.cur) continue; // wait for the first full revolution
      this.cur.q6.push(n.q6);
      this.cur.q2.push(n.q2);
      this.cur.q.push(n.quality);
      this.angle = n.q6 / 64;
    }
  }

  finish(rev) {
    this.last = rev;
    if (this.onRevolution) this.onRevolution(rev);
  }

  get hz() {
    const s = this.starts;
    if (s.length < 3) return 0;
    return (s.length - 1) / ((s[s.length - 1] - s[0]) / 1000);
  }

  get sps() {
    const c = this.counts;
    if (c.length < 2) return 0;
    const span = (c[c.length - 1][0] - c[0][0]) / 1000;
    if (span <= 0) return 0;
    return c.slice(1).reduce((s, x) => s + x[1], 0) / span;
  }
}

// A look from completed revolutions: valid measurements only (quality above 0, a distance), angles in 1/64 degree
// and distances in 1/4 mm as the lidar sent them, and where each revolution starts.
export function makeLook(revs, extra = {}) {
  let n = 0;
  for (const r of revs) for (let i = 0; i < r.q6.length; i++) if (r.q[i] > 0 && r.q2[i] > 0) n++;
  const q6 = new Uint16Array(n), q2 = new Uint16Array(n), starts = [];
  let k = 0;
  for (const r of revs) {
    starts.push(k);
    for (let i = 0; i < r.q6.length; i++) {
      if (r.q[i] > 0 && r.q2[i] > 0) { q6[k] = r.q6[i]; q2[k] = r.q2[i]; k++; }
    }
  }
  return { at: Date.now(), revs: revs.length, q6, q2, starts, ...extra };
}

function toB64(u16) {
  const bytes = new Uint8Array(u16.length * 2);
  for (let i = 0; i < u16.length; i++) { bytes[2 * i] = u16[i] & 0xff; bytes[2 * i + 1] = u16[i] >> 8; }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const u16 = new Uint16Array(s.length >> 1);
  for (let i = 0; i < u16.length; i++) u16[i] = s.charCodeAt(2 * i) | (s.charCodeAt(2 * i + 1) << 8);
  return u16;
}

export function encodeLook(look) {
  return { at: look.at, revs: look.revs, hz: look.hz ? Math.round(look.hz * 100) / 100 : undefined, a: toB64(look.q6), d: toB64(look.q2), s: look.starts };
}

export function decodeLook(o) {
  const look = { at: o.at, revs: o.revs, hz: o.hz, q6: fromB64(o.a), q2: fromB64(o.d), starts: o.s };
  if (look.q6.length !== look.q2.length) throw new Error('a look whose angles and distances do not match');
  return look;
}

// Every measurement of a look as angle in degrees, distance in metres, and which revolution it came from.
export function lookPoints(look, correction = 1) {
  const out = [];
  const s = look.starts;
  let rev = 0;
  for (let i = 0; i < look.q6.length; i++) {
    while (rev + 1 < s.length && i >= s[rev + 1]) rev++;
    out.push({ a: look.q6[i] / 64, r: (look.q2[i] / 4000) * correction, rev });
  }
  return out;
}
