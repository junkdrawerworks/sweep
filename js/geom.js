// Small 2D geometry helpers. Points are [x, y] in metres, y up.

export const DEG = Math.PI / 180;

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = a => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Angle wrapped into [-180, 180).
export function wrap180(a) { return ((a + 180) % 360 + 360) % 360 - 180; }
// Angle wrapped into [-45, 45): how far a direction is from the nearest axis.
export function wrap90(a) { return ((a + 45) % 90 + 90) % 90 - 45; }
// Angle in [0, 360).
export function wrap360(a) { return ((a % 360) + 360) % 360; }

// The bearing of a point as the lidar reports angles: degrees clockwise from +y.
export function bearing(p) { return wrap360(Math.atan2(p[0], p[1]) / DEG); }

// Total least squares line through points: centroid c, unit direction u, unit normal n (u rotated +90 degrees),
// offset d = n . c, and the RMS distance of the points from the line.
export function fitLine(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p[0]; sy += p[1]; }
  const n = pts.length;
  const cx = sx / n, cy = sy / n;
  let xx = 0, xy = 0, yy = 0;
  for (const p of pts) { const dx = p[0] - cx, dy = p[1] - cy; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  const u = [Math.cos(theta), Math.sin(theta)];
  const nn = [-u[1], u[0]];
  const d = nn[0] * cx + nn[1] * cy;
  let ss = 0;
  for (const p of pts) { const e = nn[0] * p[0] + nn[1] * p[1] - d; ss += e * e; }
  return { c: [cx, cy], u, n: nn, d, rms: Math.sqrt(ss / n) };
}

// Where two lines (point p, direction u) cross, or null if they're parallel.
export function intersect(p1, u1, p2, u2) {
  const den = cross(u1, u2);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(p2, p1), u2) / den;
  return add(p1, mul(u1, t));
}

// Distance along a ray from the origin (direction u, unit) to segment ab, or Infinity.
export function rayToSegment(u, a, b) {
  const e = sub(b, a);
  const den = cross(u, e);
  if (Math.abs(den) < 1e-12) return Infinity;
  const t = cross(a, e) / den; // origin + u t = a + e s
  const s = cross(a, u) / den;
  if (t <= 1e-9 || s < -1e-9 || s > 1 + 1e-9) return Infinity;
  return t;
}

// Perpendicular distance from p to the infinite line through a with direction u (unit), signed by u's left normal.
export function lineDist(p, a, u) { return cross(u, sub(p, a)); }

// Projection of p onto the line through a with direction u (unit).
export function project(p, a, u) { return add(a, mul(u, dot(sub(p, a), u))); }

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function bbox(points) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of points) {
    if (p[0] < minx) minx = p[0];
    if (p[1] < miny) miny = p[1];
    if (p[0] > maxx) maxx = p[0];
    if (p[1] > maxy) maxy = p[1];
  }
  return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
}

export function rotate(p, deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

// Do segments ab and cd cross (properly, not at shared ends)?
export function segmentsCross(a, b, c, d) {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

export function selfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

// Douglas-Peucker on an open polyline.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const a = pts[i0], u = norm(sub(pts[i1], a));
    let best = -1, bd = tol;
    for (let k = i0 + 1; k < i1; k++) {
      const dd = Math.abs(lineDist(pts[k], a, u));
      if (dd > bd) { bd = dd; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Seeded random numbers (mulberry32) and a normal draw, for the simulator and tests.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return next;
}
