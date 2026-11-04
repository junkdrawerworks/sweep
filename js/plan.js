// From looks to a floor plan.
//
//  1. Keep what's really there. Every degree of bearing gets one surface: the farthest one that at least 30% of a
//     look's revolutions saw. A person who moved between looks, or a dog walking through, falls away; a wall seen in
//     any look stays.
//  2. Find straight runs. The kept points, in bearing order, are broken where the range jumps and split into
//     straight pieces (split and merge), each fitted with a least-squares line.
//  3. Square up. The walls' dominant direction turns the plan so they run along the axes, and pieces within 10
//     degrees of an axis are set exactly on it ("Straighten walls", on by default).
//  4. Sort walls from things. Pieces seen through a doorway are what lies beyond it. Things standing in front of
//     the walls (a bookcase, a fridge) become objects, drawn lightly; things standing clear of them (you, a column)
//     are left out. The wall behind both carries on.
//  5. Walk round. Each wall meets the next at a corner, across a doorway, or, where one hides the other, at a step,
//     so the outline closes even where the lidar couldn't see.
//  6. Measure. Each straight run of the outline gets its length, each opening its width, and the room its overall
//     size, area and perimeter.

import { DEG, sub, add, mul, dot, cross, len, dist, norm, fitLine, intersect, rayToSegment, lineDist, project,
  polygonArea, bbox, rotate, wrap90, wrap360, bearing, selfIntersects, simplify } from './geom.js';
import { lookPoints } from './capture.js';

export const SETTINGS = {
  minRange: 0.15,
  maxRange: 12,
  support: 0.3, // share of a look's revolutions that must see a surface
  minSegLen: 0.3,
  minSegPts: 8,
  snapDeg: 10,
  objectDepth: 0.9, // things this close in front of a wall are objects against it
  objectFace: 1.8, // longest face of an object standing in a corner
  recessDepth: 0.95, // deeper than this behind a wall line is another space, seen through an opening
  nearBlock: 1.3, // metres: what's this close to the lidar may be you
};

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

// 1. One surface per degree.
export function selectPoints(looks, correction = 1, S = SETTINGS) {
  const bins = Array.from({ length: 360 }, () => []);
  looks.forEach((look, li) => {
    for (const p of lookPoints(look, correction)) {
      if (p.r < S.minRange || p.r > S.maxRange) continue;
      bins[Math.floor(p.a) % 360].push({ a: p.a, r: p.r, look: li, rev: p.rev });
    }
  });
  const revs = looks.map(l => Math.max(1, l.revs));
  const kept = [];
  const perLook = looks.map(() => new Float32Array(360).fill(NaN)); // farthest steady surface per look
  const chosen = new Float32Array(360).fill(NaN);
  for (let b = 0; b < 360; b++) {
    const arr = bins[b].sort((p, q) => p.r - q.r);
    if (!arr.length) continue;
    const clusters = [];
    let cur = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].r - arr[i - 1].r > Math.max(0.05, 0.04 * arr[i - 1].r)) { clusters.push(cur); cur = []; }
      cur.push(arr[i]);
    }
    clusters.push(cur);
    let best = null;
    for (const c of clusters) {
      if (c.length < 3) continue;
      const seen = looks.map(() => new Set());
      for (const p of c) seen[p.look].add(p.rev);
      let steady = false;
      seen.forEach((s, li) => {
        if (s.size / revs[li] >= S.support) {
          steady = true;
          const m = median(c.filter(p => p.look === li).map(p => p.r));
          if (!(perLook[li][b] >= m)) perLook[li][b] = m;
        }
      });
      if (steady) best = c; // clusters run nearest to farthest, so the last steady one wins
    }
    // Something close that one look saw, where another look got nothing back at all (glass, or open to far away):
    // that was a person standing in the way, and the view past them is open.
    if (best && median(best.map(p => p.r)) < S.nearBlock + 0.3) {
      if (looks.some((l, li) => Number.isNaN(perLook[li][b]) && l.revs >= 4)) best = null;
    }
    if (best) {
      for (const p of best) kept.push(p);
      chosen[b] = median(best.map(p => p.r));
    }
  }
  kept.sort((p, q) => p.a - q.a);
  for (const p of kept) { p.x = p.r * Math.sin(p.a * DEG); p.y = p.r * Math.cos(p.a * DEG); }
  return { kept, perLook, chosen };
}

// Stretches of the bearing where something near the lidar blocked the view in the latest look and no look saw past it.
export function blockedViews(sel, S = SETTINGS) {
  const last = sel.perLook[sel.perLook.length - 1];
  const blk = Array.from({ length: 360 }, (_, b) => last[b] < S.nearBlock && sel.chosen[b] < S.nearBlock + 0.3);
  const first = blk.indexOf(false);
  if (first < 0) return [{ from: 0, to: 0, width: 360 }];
  const out = [];
  let start = -1;
  for (let k = 0; k <= 360; k++) {
    const b = (first + k) % 360;
    if (k < 360 && blk[b]) { if (start < 0) start = first + k; } else if (start >= 0) {
      const width = first + k - start;
      if (width >= 8) out.push({ from: start % 360, to: (first + k) % 360, width });
      start = -1;
    }
  }
  return out;
}

// 2. Straight pieces.
function makeSeg(points) {
  const P = points.map(p => [p.x, p.y]);
  const f = fitLine(P);
  let u = f.u;
  if (dot(sub(P[P.length - 1], P[0]), u) < 0) u = [-u[0], -u[1]];
  const n = [-u[1], u[0]];
  let t0 = Infinity, t1 = -Infinity;
  for (const p of P) { const t = dot(sub(p, f.c), u); if (t < t0) t0 = t; if (t > t1) t1 = t; }
  const rmean = points.reduce((s, p) => s + p.r, 0) / points.length;
  return {
    pts: points, P, c: f.c, u, n, rms: f.rms, a: add(f.c, mul(u, t0)), b: add(f.c, mul(u, t1)),
    len: t1 - t0, count: points.length, rmean,
  };
}

// How far off a line a corner must bend before a piece is split: about four times the A1's noise at that range.
function splitTol(r) { return Math.max(0.04, 0.02 * r); }

// Split and merge (iterative end point fit). The ends are steadied by averaging a few points, and the bend is found
// on a lightly smoothed profile, so one noisy measurement doesn't split a wall: a real corner bends many in a row.
function iepf(points, i0, i1, out) {
  const n = i1 - i0 + 1;
  if (n < 8) { out.push(points.slice(i0, i1 + 1)); return; }
  const k = Math.min(3, n >> 2);
  const avg = (from, to) => {
    let x = 0, y = 0;
    for (let i = from; i <= to; i++) { x += points[i].x; y += points[i].y; }
    return [x / (to - from + 1), y / (to - from + 1)];
  };
  const A = avg(i0, i0 + k - 1), B = avg(i1 - k + 1, i1);
  const u = norm(sub(B, A));
  let rs = 0;
  const dev = [];
  for (let i = i0; i <= i1; i++) { rs += points[i].r; dev.push(lineDist([points[i].x, points[i].y], A, u)); }
  const tol = splitTol(rs / n);
  let worst = -1, wd = 0;
  for (let i = 2; i < n - 2; i++) {
    const m = median([dev[i - 2], dev[i - 1], dev[i], dev[i + 1], dev[i + 2]]);
    if (Math.abs(m) > wd) { wd = Math.abs(m); worst = i0 + i; }
  }
  if (wd > tol && worst > i0 + 1 && worst < i1 - 1) {
    iepf(points, i0, worst, out);
    iepf(points, worst + 1, i1, out);
  } else out.push(points.slice(i0, i1 + 1));
}

function fitsOneLine(points) {
  if (points.length < 3) return true;
  const f = fitLine(points.map(p => [p.x, p.y]));
  const tol = splitTol(points.reduce((s, p) => s + p.r, 0) / points.length);
  const res = points.map(p => Math.abs(dot([p.x, p.y], f.n) - f.d));
  return f.rms <= 0.5 * tol && quantile(res, 0.95) <= tol;
}

export function pieces(kept) {
  if (kept.length < 2) return [];
  // break where the bearing skips or the range jumps
  const runs = [];
  let cur = [kept[0]];
  for (let i = 1; i < kept.length; i++) {
    const p = kept[i - 1], q = kept[i];
    const gap = Math.hypot(q.x - p.x, q.y - p.y);
    if (q.a - p.a > 3 || gap > Math.max(0.1, 0.035 * Math.max(p.r, q.r))) { runs.push(cur); cur = []; }
    cur.push(q);
  }
  runs.push(cur);
  if (runs.length > 1) { // the last run may carry on across 0 degrees into the first
    const p = runs[runs.length - 1].at(-1), q = runs[0][0];
    const gap = Math.hypot(q.x - p.x, q.y - p.y);
    if (q.a + 360 - p.a <= 3 && gap <= Math.max(0.1, 0.035 * Math.max(p.r, q.r))) runs[0] = runs.pop().concat(runs[0]);
  }
  const out = [];
  for (const run of runs) {
    const parts = [];
    iepf(run, 0, run.length - 1, parts);
    // merge neighbours that the noise split
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i + 1 < parts.length; i++) {
        const both = parts[i].concat(parts[i + 1]);
        if (fitsOneLine(both)) { parts.splice(i, 2, both); changed = true; break; }
      }
    }
    for (const p of parts) out.push(p);
  }
  return out;
}

// 3. Which way the walls run.
export function dominantAngle(segs) {
  const cand = segs.filter(s => s.len >= 0.5);
  if (!cand.length) return 0;
  const dir = s => Math.atan2(s.u[1], s.u[0]) / DEG;
  const mean = (list, around) => {
    let X = 0, Y = 0;
    for (const s of list) {
      const a = dir(s);
      if (around !== undefined && Math.abs(wrap90(a - around)) > 12) continue;
      X += s.len * Math.cos(4 * a * DEG);
      Y += s.len * Math.sin(4 * a * DEG);
    }
    return Math.atan2(Y, X) / DEG / 4;
  };
  let a = mean(cand);
  a = mean(cand, a);
  return mean(cand, a);
}

function snapSeg(s) {
  const ang = Math.atan2(s.u[1], s.u[0]) / DEG;
  const dev = wrap90(ang);
  const axis = Math.round((ang - dev) / 90) * 90;
  s.u = [Math.round(Math.cos(axis * DEG)), Math.round(Math.sin(axis * DEG))];
  s.n = [-s.u[1], s.u[0]];
  const off = median(s.P.map(p => dot(p, s.n)));
  const along = s.P.map(p => dot(p, s.u));
  const t0 = Math.min(...along), t1 = Math.max(...along);
  const base = mul(s.n, off);
  s.c = add(base, mul(s.u, (t0 + t1) / 2));
  s.a = add(base, mul(s.u, t0));
  s.b = add(base, mul(s.u, t1));
  s.len = t1 - t0;
  s.snapped = true;
}

function refit(s) {
  const t = makeSeg(s.pts);
  Object.assign(s, t);
}

function collinear(A, B) {
  if (Math.abs(cross(A.u, B.u)) > Math.sin(4 * DEG) || dot(A.u, B.u) < 0) return false;
  return Math.abs(lineDist(B.c, A.c, A.u)) < 0.05 && Math.abs(lineDist(A.c, B.c, B.u)) < 0.05;
}

function mergeSegs(A, B) {
  const s = makeSeg(A.pts.concat(B.pts));
  if (A.snapped && B.snapped) snapSeg(s);
  return s;
}

const bearingOf = p => bearing(p);
// how far round from bearing a to bearing b, going clockwise
const span = (a, b) => wrap360(b - a);

// The kept points whose bearing lies strictly between two points' bearings (clockwise from a to b).
function pointsBetween(kept, pa, pb) {
  const a = bearingOf(pa), w = span(a, bearingOf(pb));
  return kept.filter(p => { const d = span(a, p.a); return d > 0.2 && d < w - 0.2; });
}

// Solid points (on walls and objects), bucketed by whole degree of bearing, for visibility tests.
export function bucketPoints(segs) {
  const buckets = Array.from({ length: 360 }, () => []);
  for (const s of segs) for (const p of s.P) {
    const r = len(p);
    if (r < 0.05) continue;
    buckets[Math.floor(bearingOf(p)) % 360].push([p[0] / r, p[1] / r, r]);
  }
  return buckets;
}

// How many solid points a guessed stretch of wall would hide: the lidar can't have seen a surface behind a wall.
function hides(path, buckets) {
  if (!buckets) return 0;
  let n = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    if (dist(a, b) < 0.01) continue;
    let b0 = bearingOf(a), w = span(b0, bearingOf(b));
    if (w > 180) { b0 = bearingOf(b); w = 360 - w; }
    for (let k = Math.floor(b0); k <= Math.floor(b0 + w); k++) {
      for (const q of buckets[((k % 360) + 360) % 360]) {
        const t = rayToSegment([q[0], q[1]], a, b);
        if (t + 0.15 < q[2]) n++;
      }
    }
  }
  return n;
}

// 5. How two walls in bearing order meet: the end of A, anything in between, and the start of B.
// Candidate shapes are tried and the one that hides the fewest solid points wins; ties go to the simplest:
// a corner, a step, an elbow (two square turns), then a straight guess.
function junction(A, B, kept, buckets) {
  const between = pointsBetween(kept, A.b, B.a);
  const c = Math.abs(cross(A.u, B.u));
  const par = c < Math.sin(25 * DEG);
  if (!par) {
    const cands = [];
    const K = intersect(A.c, A.u, B.c, B.u);
    if (K) {
      const near = dist(K, A.b) < 0.35 && dist(K, B.a) < 0.35;
      // a wall is only stretched so far to meet another: 5 m, and no more than four times what was seen of it
      const reach = dist(K, A.b) < Math.min(5, Math.max(0.6, 4 * A.len)) && dist(K, B.a) < Math.min(5, Math.max(0.6, 4 * B.len));
      // the corner must lie ahead of A's end and before B's start, or close to both
      const ahead = dot(sub(K, A.b), A.u) > -0.35 && dot(sub(B.a, K), B.u) > -0.35;
      if (near) return { type: 'corner', aEnd: K, bStart: K, mid: [], gap: 'wall', path: [A.b, K, B.a] };
      if (reach && ahead) cands.push({ type: 'corner', aEnd: K, bStart: K, mid: [], gap: 'wall', path: [A.b, K, B.a], rank: 0 });
    }
    if (c > Math.sin(60 * DEG)) {
      const M = intersect(A.b, B.u, B.a, A.u);
      if (M && dist(M, A.b) < 5 && dist(M, B.a) < 5) {
        cands.push({ type: 'elbow', aEnd: A.b, bStart: B.a, mid: [M], gap: 'inferred', path: [A.b, M, B.a], rank: 2 });
      }
    }
    cands.push({ type: 'straight', aEnd: A.b, bStart: B.a, mid: [], gap: 'inferred', path: [A.b, B.a], rank: 3 });
    return best(cands, buckets);
  }
  const offset = Math.abs(lineDist(B.c, A.c, A.u));
  if (offset < 0.08) {
    // collinear: an opening, a wall hidden behind something, or a short gap in one wall
    const g = dist(A.b, B.a);
    const toward = Math.sign(lineDist([0, 0], A.c, A.u)) || 1; // the lidar's side of the wall
    const side = p => toward * lineDist([p.x, p.y], A.c, A.u); // positive: in front of the wall
    const behind = between.filter(p => side(p) < -0.15);
    const front = between.filter(p => side(p) > 0.05);
    let gap = 'wall';
    if (g >= 0.3) {
      // seen through and nothing in the way: the whole gap is the opening. Partly hidden: the hidden part is wall,
      // and the opening is only where the lidar saw through (seeThrough finds it).
      if (behind.length > 0) gap = front.length > 3 ? 'inferred' : 'opening';
      else if (front.length > 0) gap = 'inferred';
      else gap = 'opening';
    } else if (g >= 0.1 && front.length > 0) gap = 'inferred';
    return { type: 'collinear', aEnd: A.b, bStart: B.a, mid: [], gap, path: [A.b, B.a] };
  }
  // parallel and offset: a step, square to both walls, usually from the nearer end, which hides it
  const fromA = project(A.b, B.c, B.u);
  const fromB = project(B.a, A.c, A.u);
  const cands = [
    { type: 'step', aEnd: A.b, bStart: fromA, mid: [], gap: 'inferred', path: [A.b, fromA, B.a], rank: len(A.b) <= len(B.a) ? 1 : 1.5 },
    { type: 'step', aEnd: fromB, bStart: B.a, mid: [], gap: 'inferred', path: [A.b, fromB, B.a], rank: len(A.b) <= len(B.a) ? 1.5 : 1 },
    { type: 'straight', aEnd: A.b, bStart: B.a, mid: [], gap: 'inferred', path: [A.b, B.a], rank: 3 },
  ];
  return best(cands, buckets);
}

function best(cands, buckets) {
  let pick = null;
  for (const c of cands) {
    c.hidden = hides(c.path, buckets);
    if (!pick || c.hidden < pick.hidden || (c.hidden === pick.hidden && c.rank < pick.rank)) pick = c;
  }
  return pick;
}

// The boundary two walls imply between them, as a polyline from A's end to B's start.
function impliedPath(A, B, kept, buckets) {
  const j = junction(A, B, kept, buckets);
  return { j, path: j.path };
}

function rayToPath(u, path) {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) best = Math.min(best, rayToSegment(u, path[i], path[i + 1]));
  return best;
}

function pathDistance(p, path) {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const e = sub(b, a);
    const L2 = dot(e, e);
    const t = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), e) / L2)) : 0;
    best = Math.min(best, dist(p, add(a, mul(e, t))));
  }
  return best;
}

// 4. Pull out what isn't wall. Returns the walls left, and the objects, occluders and seen-through things removed.
export function sortWalls(segs, kept, S = SETTINGS) {
  let alive = segs.slice();
  const objects = [], occluders = [], beyond = [];
  const idx = s => alive.indexOf(s);
  const prev = i => alive[(i - 1 + alive.length) % alive.length];
  const next = i => alive[(i + 1) % alive.length];

  // things seen through openings: behind a wall line, between two pieces of it, deeper than a closet
  const lines = [];
  for (const s of alive) {
    const L = lines.find(l => collinear(l[0], s));
    if (L) L.push(s); else lines.push([s]);
  }
  for (const L of lines) {
    if (L.length < 2) continue;
    const toward = Math.sign(lineDist([0, 0], L[0].c, L[0].u)) || 1;
    const order = L.slice().sort((p, q) => alive.indexOf(p) - alive.indexOf(q));
    for (let k = 0; k < order.length; k++) {
      const A = order[k], B = order[(k + 1) % order.length];
      if (A === B) continue;
      const ia = alive.indexOf(A), ib = alive.indexOf(B);
      if (ia < 0 || ib < 0) continue;
      const inner = [];
      for (let i = (ia + 1) % alive.length; i !== ib; i = (i + 1) % alive.length) inner.push(alive[i]);
      if (!inner.length || inner.length > 8) continue;
      if (dist(A.b, B.a) > 4.5) continue;
      if (span(bearingOf(A.b), bearingOf(B.a)) > 120) continue;
      const depths = inner.flatMap(s => s.P.map(p => -toward * lineDist(p, A.c, A.u)));
      if (depths.every(d => d > 0.1) && Math.max(...depths) >= S.recessDepth) {
        for (const s of inner) { beyond.push(s); alive.splice(alive.indexOf(s), 1); }
      }
    }
  }

  const merge = () => {
    for (let changed = true; changed && alive.length > 2;) {
      changed = false;
      for (let i = 0; i < alive.length; i++) {
        const A = alive[i], B = next(i);
        if (A === B || !collinear(A, B)) continue;
        const between = pointsBetween(kept, A.b, B.a);
        const toward = Math.sign(lineDist([0, 0], A.c, A.u)) || 1;
        const g = dist(A.b, B.a);
        const behind = between.some(p => -toward * lineDist([p.x, p.y], A.c, A.u) > 0.15);
        if (behind || (g > 0.3 && between.length === 0)) continue; // an opening: keep the pieces apart
        const m = mergeSegs(A, B);
        const j = idx(B);
        alive[i] = m;
        alive.splice(j, 1);
        changed = true;
        break;
      }
    }
  };
  merge();

  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    // runs of short pieces that touch end to end; every longer piece on its own
    const chains = [];
    for (let i = 0; i < alive.length; i++) {
      const s = alive[i];
      if (s.len > S.objectFace * 1.7) { chains.push([s]); continue; }
      const g = chains.at(-1);
      if (g && g.short && g.at(-1) === prev(i) && dist(prev(i).b, s.a) < 0.3) g.push(s);
      else { const ng = [s]; ng.short = true; chains.push(ng); }
    }
    // a thing can be any stretch of up to three pieces in a chain: a bookcase's side and front, next to the wall
    const groups = [];
    for (const C of chains) {
      for (let size = 1; size <= Math.min(3, C.length); size++) {
        for (let k = 0; k + size <= C.length; k++) { const g = C.slice(k, k + size); g.short = C.short; groups.push(g); }
      }
    }
    for (const G of groups) {
      if (alive.length < 4) break;
      if (G.some(s => idx(s) < 0)) continue; // part of it went already
      const i0 = idx(G[0]), i1 = idx(G.at(-1));
      const A = prev(i0), B = next(i1);
      if (G.includes(A) || G.includes(B) || A === B) continue;
      const pts = G.flatMap(s => s.P);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (extent > 8) continue;
      const others = alive.filter(s => !G.includes(s)).concat(objects.flatMap(o => o.segs));
      const { j, path } = impliedPath(A, B, kept, bucketPoints(others));
      const ahead = []; // along the ray: how far in front of the implied wall each point is (negative: behind it)
      const depths = []; // straight to the implied wall
      let missing = 0;
      for (const p of pts) {
        const r = len(p);
        const t = rayToPath(mul(p, 1 / r), path);
        if (t === Infinity) { missing++; continue; }
        ahead.push(t - r);
        depths.push(pathDistance(p, path));
      }
      if (missing > pts.length * 0.2 || !ahead.length) continue;
      const front = ahead.filter(d => d > 0.05).length / ahead.length;
      const back = ahead.filter(d => d < -0.1).length / ahead.length;
      let kind = null;
      // a piece that lines up with another wall piece outside the group is part of a longer wall, not a thing
      const partOfWall = G.some(s => alive.some(o => !G.includes(o) && collinear(s, o)));
      if (back >= 0.8 && !partOfWall && (j.type === 'collinear' || j.type === 'corner') && quantile(depths, 0.9) >= S.recessDepth) {
        kind = 'beyond'; // seen through an opening in the wall the neighbours imply
      } else if (front >= 0.8 && G.short && extent <= 3.2 && !partOfWall) {
        const deep = quantile(depths, 0.9);
        const face = Math.max(...G.map(s => s.len));
        const jumpA = len(A.b) - len(G[0].a) > 0.25;
        const jumpB = len(B.a) - len(G.at(-1).b) > 0.25;
        // only against a wall the neighbours really imply: one line, or a corner. Not a guessed diagonal.
        if (deep <= S.objectDepth && (j.type === 'collinear' || (j.type === 'corner' && face <= S.objectFace))) kind = 'object';
        else if (jumpA && jumpB) kind = 'occluder';
      }
      if (!kind) continue;
      if (kind === 'beyond') beyond.push(...G);
      else (kind === 'object' ? objects : occluders).push({ segs: G, path });
      for (const s of G) alive.splice(idx(s), 1);
      changed = true;
    }
    merge();
    if (!changed) break;
  }
  return { walls: alive, objects, occluders, beyond };
}

// Walls joined end to end along one line share it exactly, so the outline has no hairline steps.
function unifyLines(walls, kept) {
  const n = walls.length;
  if (n < 2) return;
  const link = walls.map((A, i) => junction(A, walls[(i + 1) % n], kept).type === 'collinear'); // i joins i + 1
  let s = 0;
  while (s < n && link[(s - 1 + n) % n]) s++;
  if (s === n) s = 0; // every wall on one line: nothing sensible to do but treat it as one chain
  const chains = [];
  let cur = [];
  for (let k = 0; k < n; k++) {
    const i = (s + k) % n;
    cur.push(walls[i]);
    if (!link[i] || k === n - 1) { chains.push(cur); cur = []; }
  }
  for (const C of chains) {
    if (C.length < 2) continue;
    const total = C.reduce((s, w) => s + w.len, 0);
    const u = C[0].u;
    const nn = [-u[1], u[0]];
    let off = 0;
    for (const w of C) off += dot(w.c, nn) * w.len;
    off /= total;
    for (const w of C) {
      const shift = mul(nn, off - dot(w.c, nn));
      w.c = add(w.c, shift); w.a = add(w.a, shift); w.b = add(w.b, shift);
      w.u = u; w.n = nn;
    }
  }
}

// Spans of the outline the lidar saw through: it measured something beyond them.
function seeThrough(edges, kept) {
  const hits = edges.map(() => []);
  for (const p of kept) {
    const P = [p.x, p.y];
    const r = len(P);
    if (r < 0.2) continue;
    const u = mul(P, 1 / r);
    let best = Infinity, which = -1;
    edges.forEach((e, k) => { const t = rayToSegment(u, e.a, e.b); if (t < best) { best = t; which = k; } });
    if (which < 0 || r - best < 0.15) continue;
    const e = edges[which];
    hits[which].push(dist(e.a, mul(u, best)));
  }
  return hits.map((h, k) => {
    if (edges[k].kind === 'opening' || h.length < 4) return [];
    h.sort((x, y) => x - y);
    const spans = [];
    let s0 = h[0], prevT = h[0], count = 1;
    for (let i = 1; i <= h.length; i++) {
      if (i === h.length || h[i] - prevT > 0.25) {
        if (count >= 4 && prevT - s0 >= 0.25) spans.push([s0, prevT]);
        if (i < h.length) { s0 = h[i]; count = 0; }
      }
      if (i < h.length) { prevT = h[i]; count++; }
    }
    return spans;
  });
}

function splitOpenings(edges, spans) {
  const out = [];
  edges.forEach((e, k) => {
    if (!spans[k].length) { out.push(e); return; }
    const u = norm(sub(e.b, e.a));
    let t = 0;
    for (const [t0, t1] of spans[k]) {
      const a = Math.max(t, t0), b = Math.min(e.len, t1);
      if (b - a < 0.2) continue;
      if (a - t > 0.005) out.push({ a: add(e.a, mul(u, t)), b: add(e.a, mul(u, a)), kind: e.kind, len: a - t });
      out.push({ a: add(e.a, mul(u, a)), b: add(e.a, mul(u, b)), kind: 'opening', len: b - a });
      t = b;
    }
    if (e.len - t > 0.005) out.push({ a: add(e.a, mul(u, t)), b: e.b, kind: e.kind, len: e.len - t });
  });
  return out;
}

// 5 and 6. The outline, its edges and its measurements.
function outline(walls, kept, buckets) {
  const n = walls.length;
  const J = walls.map((A, i) => junction(A, walls[(i + 1) % n], kept, buckets));
  const verts = []; // [point, kind of the edge that leaves this point]
  const push = (p, kind) => {
    const last = verts.at(-1);
    if (last && dist(last[0], p) < 0.005) { last[1] = kind; return; }
    verts.push([p, kind]);
  };
  for (let i = 0; i < n; i++) {
    const W = walls[i];
    const start = J[(i - 1 + n) % n].bStart;
    const end = J[i].aEnd;
    // the stretch from the corner to what was actually seen is inferred if it's long
    const tA = dot(sub(W.a, start), W.u), tB = dot(sub(end, W.b), W.u);
    if (tA > 0.3) { push(start, 'inferred'); push(W.a, 'wall'); } else push(start, 'wall');
    if (tB > 0.3) { push(W.b, 'inferred'); }
    const j = J[i];
    if (j.type === 'corner') continue; // end is the corner: the next wall starts there
    push(end, j.gap);
    for (const m of j.mid) push(m, j.gap);
  }
  // close up and drop repeats
  if (verts.length > 1 && dist(verts[0][0], verts.at(-1)[0]) < 0.005) verts.pop();
  return verts;
}

function edgesOf(verts) {
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i][0], b = verts[(i + 1) % verts.length][0];
    if (dist(a, b) < 0.005) continue;
    out.push({ a, b, kind: verts[i][1], len: dist(a, b) });
  }
  return out;
}

// Straight runs of the outline, each measured end to end, with the openings in it.
function runsOf(edges) {
  const runs = [];
  for (const e of edges) {
    const u = norm(sub(e.b, e.a));
    const r = runs.at(-1);
    if (r && Math.abs(cross(r.u, u)) < Math.sin(2 * DEG) && dot(r.u, u) > 0 && Math.abs(lineDist(e.a, r.a, r.u)) < 0.02) {
      r.b = e.b; r.edges.push(e);
    } else runs.push({ a: e.a, b: e.b, u, edges: [e] });
  }
  if (runs.length > 1) {
    const f = runs[0], l = runs.at(-1);
    if (Math.abs(cross(f.u, l.u)) < Math.sin(2 * DEG) && dot(f.u, l.u) > 0 && Math.abs(lineDist(f.a, l.a, l.u)) < 0.02) {
      f.a = l.a; f.edges = l.edges.concat(f.edges); runs.pop();
    }
  }
  for (const r of runs) {
    r.len = dist(r.a, r.b);
    r.openings = r.edges.filter(e => e.kind === 'opening').map(e => ({ a: e.a, b: e.b, width: e.len }));
    r.seen = r.edges.filter(e => e.kind === 'wall').reduce((s, e) => s + e.len, 0);
  }
  return runs;
}

// Walls numbered the way you'd read the plan: clockwise, starting from the top wall at the left.
function readingOrder(runs) {
  if (runs.length < 2) return runs;
  const cw = runs.slice().reverse(); // each run keeps its own direction (anticlockwise): drawing relies on it
  let first = 0, best = -Infinity;
  cw.forEach((r, i) => {
    const my = (r.a[1] + r.b[1]) / 2, mx = (r.a[0] + r.b[0]) / 2;
    const score = my * 10 - mx; // highest first, then leftmost
    if (score > best + 1e-6) { best = score; first = i; }
  });
  return cw.slice(first).concat(cw.slice(0, first));
}

export function makePlan(looks, { correction = 1, straighten = true } = {}, S = SETTINGS) {
  const sel = selectPoints(looks, correction, S);
  const kept = sel.kept;
  const blocked = blockedViews(sel, S);
  const raw = pieces(kept).map(makeSeg);
  const rotation = wrap90(-dominantAngle(raw.filter(s => s.count >= S.minSegPts)));
  for (const p of kept) { const q = rotate([p.x, p.y], rotation); p.x = q[0]; p.y = q[1]; p.a = wrap360(p.a - rotation); }
  // the pieces share point objects with kept, so they're already turned: refit them in the new frame
  const segs = raw.map(s => { const t = makeSeg(s.pts); return t; });
  if (straighten) for (const s of segs) {
    const dev = wrap90(Math.atan2(s.u[1], s.u[0]) / DEG);
    if (Math.abs(dev) < S.snapDeg) snapSeg(s);
  }
  const solid = segs.filter(s => s.len >= S.minSegLen && s.count >= S.minSegPts);
  const clutter = segs.filter(s => !solid.includes(s));
  const sorted = sortWalls(solid, kept, S);
  let walls = sorted.walls;
  if (walls.length >= 3) unifyLines(walls, kept);
  const buckets = bucketPoints(walls.concat(sorted.objects.flatMap(o => o.segs)));
  let verts = walls.length >= 3 ? outline(walls, kept, buckets) : [];
  let rough = false;
  if (verts.length < 3 || selfIntersects(verts.map(v => v[0]))) {
    // not enough straight walls: follow the points themselves
    rough = true;
    const ring = kept.map(p => [p.x, p.y]);
    verts = simplify(ring.concat([ring[0]]), 0.06).slice(0, -1).map(p => [p, 'inferred']);
  }
  // the walk runs clockwise; the plan is drawn anticlockwise
  let poly = verts.map(v => v[0]);
  let edges = edgesOf(verts);
  if (!rough) edges = splitOpenings(edges, seeThrough(edges, kept));
  if (polygonArea(poly) < 0) {
    poly = poly.slice().reverse();
    edges = edges.map(e => ({ ...e, a: e.b, b: e.a })).reverse();
  }
  const runs = readingOrder(runsOf(edges));
  const box = bbox(poly);
  const perimeter = runs.reduce((s, r) => s + r.len, 0);
  const seen = edges.filter(e => e.kind === 'wall').reduce((s, e) => s + e.len, 0);
  const objects = sorted.objects.map(o => objectShape(o, straighten && !rough)).filter(Boolean);
  return {
    rotation,
    lidar: [0, 0],
    outline: poly,
    edges,
    runs,
    openings: runs.flatMap(r => r.openings),
    objects,
    occluders: sorted.occluders.map(o => o.segs.flatMap(s => s.P)),
    points: kept.map(p => [p.x, p.y]),
    blocked,
    box,
    area: Math.abs(polygonArea(poly)),
    perimeter,
    seenShare: perimeter ? seen / perimeter : 0,
    rough,
    debug: { segs, clutter, walls, sorted },
  };
}

// An object's footprint: its seen faces, pushed straight back to the wall behind them.
// With the walls straightened, furniture is drawn as a box square to them, reaching back to the wall it stands against.
function objectShape(o, square) {
  const pts = o.segs.flatMap(s => [s.a, s.b]);
  const back = pts.map(p => closestOnPath(p, o.path));
  const all = pts.concat(back);
  if (all.length < 3) return null;
  if (!square) return hull(all);
  const b = bbox(all);
  if (b.w < 0.05 || b.h < 0.05) return hull(all);
  return [[b.minx, b.miny], [b.maxx, b.miny], [b.maxx, b.maxy], [b.minx, b.maxy]];
}

function closestOnPath(p, path) {
  let best = null, bd = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], e = sub(path[i + 1], a);
    const L2 = dot(e, e);
    const t = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), e) / L2)) : 0;
    const q = add(a, mul(e, t));
    const d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  return best || p;
}

function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(sub(lower.at(-1), lower.at(-2)), sub(q, lower.at(-2))) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(sub(upper.at(-1), upper.at(-2)), sub(q, upper.at(-2))) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
