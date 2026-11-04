// Drawing a plan as SVG (on screen, and for the image and drawing exports) and the live radar view on a canvas.

import { bbox, norm, sub } from './geom.js';
import { fmtLength, fmtArea, fmtSize } from './units.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = v => (Math.round(v * 10) / 10).toString();

// On screen the colours come from the page's own tokens; exports pass plain colours.
export const SCREEN = {
  paper: 'var(--paper)', room: 'var(--room)', wall: 'var(--ink)', soft: 'var(--ink-2)', mark: 'var(--mark)',
  object: 'var(--object)', points: 'var(--ink-2)', tape: 'var(--tape)', tapeInk: 'var(--tape-ink)',
};
export const PRINT = {
  paper: '#ffffff', room: '#f2f5f3', wall: '#1e2638', soft: '#5b6577', mark: '#c8261b',
  object: '#dfe5e2', points: '#8a93a3', tape: '#f5c400', tapeInk: '#15130a',
};

// Each drawing's hatch pattern gets its own id: a page can hold several drawings, and a url(#id) that found one inside
// a hidden screen would draw nothing.
let drawings = 0;

// plan: from makePlan. o: { width, height, units, colors, points, highlight, title, date, fontCss, font }
export function planSvg(plan, o) {
  const hatch = `hatch${++drawings}`;
  const W = o.width, H = o.height;
  const C = o.colors || SCREEN;
  const font = o.font || "'Barlow Semi Condensed', 'Barlow', system-ui, sans-serif";
  const units = o.units || 'ft';
  const P = plan.outline;
  if (!P || P.length < 3) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"></svg>`;
  const fs = o.fontSize || Math.max(11, Math.min(17, Math.min(W, H) / 34));
  const titleH = o.title ? fs * 5 : 0;
  const footH = o.title ? fs * 3 : 0;
  const margin = fs * 3.4;
  const b = bbox(P.concat(plan.objects.flat(), [plan.lidar]));
  const s = Math.min((W - 2 * margin) / Math.max(b.w, 0.5), (H - 2 * margin - titleH - footH) / Math.max(b.h, 0.5));
  const ox = (W - b.w * s) / 2 - b.minx * s;
  const oy = titleH + (H - titleH - footH - b.h * s) / 2 + b.maxy * s;
  const X = x => ox + x * s, Y = y => oy - y * s;
  const pt = p => `${f1(X(p[0]))},${f1(Y(p[1]))}`;
  const wall = Math.max(3, Math.min(9, s * 0.11)); // drawn wall thickness, outside the measured surface
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${esc(font)}" role="img">`);
  if (o.fontCss) out.push(`<style>${o.fontCss}</style>`);
  out.push(`<defs><pattern id="${hatch}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" style="stroke:${C.soft};stroke-width:1;stroke-opacity:.45"/></pattern></defs>`);
  if (o.background) out.push(`<rect width="${W}" height="${H}" style="fill:${C.paper}"/>`);

  // walls: a stroke twice the wall's thickness on the measured line, then the room drawn over its inner half
  const edges = plan.edges;
  const groups = [];
  for (const e of edges) {
    const g = groups.at(-1);
    if (g && g.kind === e.kind && g.edges.at(-1).b === e.a) g.edges.push(e); else groups.push({ kind: e.kind, edges: [e] });
  }
  if (groups.length > 1 && groups[0].kind === groups.at(-1).kind && groups.at(-1).edges.at(-1).b === groups[0].edges[0].a) {
    groups[0].edges = groups.pop().edges.concat(groups[0].edges);
  }
  const line = g => [g.edges[0].a, ...g.edges.map(e => e.b)].map(pt).join(' ');
  for (const g of groups) {
    if (g.kind !== 'wall') continue;
    out.push(`<polyline points="${line(g)}" style="fill:none;stroke:${C.wall};stroke-width:${f1(wall * 2)};stroke-linejoin:miter;stroke-miterlimit:4;stroke-linecap:square"/>`);
  }
  out.push(`<polygon points="${P.map(pt).join(' ')}" style="fill:${C.room}"/>`);
  for (const g of groups) {
    if (g.kind !== 'inferred') continue;
    out.push(`<polyline points="${line(g)}" style="fill:none;stroke:${C.soft};stroke-width:2;stroke-dasharray:6 5"/>`);
  }
  // openings: a gap with its jambs marked, and a hairline across
  for (const op of plan.openings) {
    const u = norm(sub(op.b, op.a));
    const n = [u[1], -u[0]]; // outward
    for (const q of [op.a, op.b]) {
      out.push(`<line x1="${f1(X(q[0]))}" y1="${f1(Y(q[1]))}" x2="${f1(X(q[0]) + n[0] * wall * 2.2)}" y2="${f1(Y(q[1]) - n[1] * wall * 2.2)}" style="stroke:${C.wall};stroke-width:2"/>`);
    }
    out.push(`<line x1="${f1(X(op.a[0]))}" y1="${f1(Y(op.a[1]))}" x2="${f1(X(op.b[0]))}" y2="${f1(Y(op.b[1]))}" style="stroke:${C.mark};stroke-width:1.2;stroke-dasharray:2 3"/>`);
  }
  // things against the walls
  for (const obj of plan.objects) {
    out.push(`<polygon points="${obj.map(pt).join(' ')}" style="fill:url(#${hatch});stroke:${C.soft};stroke-width:1.2"/>`);
  }
  if (o.points && plan.points.length) {
    let d = '';
    for (const p of plan.points) d += `M${f1(X(p[0]))} ${f1(Y(p[1]))}h0`;
    out.push(`<path d="${d}" style="stroke:${C.points};stroke-width:2;stroke-linecap:round;stroke-opacity:.55;fill:none"/>`);
  }
  // where the lidar stood
  const lx = X(plan.lidar[0]), ly = Y(plan.lidar[1]);
  out.push(`<g style="stroke:${C.mark};stroke-width:1.4;fill:none"><circle cx="${f1(lx)}" cy="${f1(ly)}" r="5"/><line x1="${f1(lx - 9)}" y1="${f1(ly)}" x2="${f1(lx + 9)}" y2="${f1(ly)}"/><line x1="${f1(lx)}" y1="${f1(ly - 9)}" x2="${f1(lx)}" y2="${f1(ly + 9)}"/></g>`);

  // dimensions: each straight run of the outline, outside it, architects' ticks at the ends
  plan.runs.forEach((r, i) => {
    if (r.len < 0.4) return;
    const u = norm(sub(r.b, r.a));
    const nS = [u[1], u[0]]; // outward normal, in screen coordinates (y flipped)
    const uS = [u[0], -u[1]];
    const D = wall * 2 + fs * 1.15;
    const A = [X(r.a[0]), Y(r.a[1])], B = [X(r.b[0]), Y(r.b[1])];
    const A2 = [A[0] + nS[0] * D, A[1] + nS[1] * D], B2 = [B[0] + nS[0] * D, B[1] + nS[1] * D];
    const hot = i === o.highlight;
    const col = hot ? C.mark : C.soft;
    const ext = (p, q) => `<line x1="${f1(p[0] + nS[0] * (wall * 2 + 3))}" y1="${f1(p[1] + nS[1] * (wall * 2 + 3))}" x2="${f1(q[0] + nS[0] * 4)}" y2="${f1(q[1] + nS[1] * 4)}"/>`;
    const k = fs * 0.42;
    const tick = p => `<line x1="${f1(p[0] - (uS[0] + nS[0]) * k)}" y1="${f1(p[1] - (uS[1] + nS[1]) * k)}" x2="${f1(p[0] + (uS[0] + nS[0]) * k)}" y2="${f1(p[1] + (uS[1] + nS[1]) * k)}" style="stroke-width:1.6"/>`;
    out.push(`<g style="stroke:${col};stroke-width:1" data-run="${i}">${ext(A, A2)}${ext(B, B2)}<line x1="${f1(A2[0])}" y1="${f1(A2[1])}" x2="${f1(B2[0])}" y2="${f1(B2[1])}"/>${tick(A2)}${tick(B2)}</g>`);
    let ang = Math.atan2(uS[1], uS[0]) * 180 / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang <= -90) ang += 180;
    const M = [(A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2];
    out.push(`<text x="${f1(M[0])}" y="${f1(M[1])}" transform="rotate(${f1(ang)} ${f1(M[0])} ${f1(M[1])})" text-anchor="middle" dominant-baseline="central" style="font-size:${f1(fs)}px;font-weight:600;fill:${hot ? C.mark : C.wall};stroke:${C.paper};stroke-width:5;paint-order:stroke;font-variant-numeric:tabular-nums" data-run="${i}">${esc(fmtLength(r.len, units))}</text>`);
    // the openings in this run, labelled inside the room
    for (const op of r.openings) {
      if (op.width < 0.25) continue;
      const m = [(X(op.a[0]) + X(op.b[0])) / 2 - nS[0] * fs * 1.0, (Y(op.a[1]) + Y(op.b[1])) / 2 - nS[1] * fs * 1.0];
      out.push(`<text x="${f1(m[0])}" y="${f1(m[1])}" transform="rotate(${f1(ang)} ${f1(m[0])} ${f1(m[1])})" text-anchor="middle" dominant-baseline="central" style="font-size:${f1(fs * 0.82)}px;font-weight:600;fill:${C.mark};stroke:${C.room};stroke-width:4;paint-order:stroke">${esc(fmtLength(op.width, units))} opening</text>`);
    }
  });

  if (o.title) {
    out.push(`<text x="${f1(margin * 0.6)}" y="${f1(fs * 2.2)}" style="font-size:${f1(fs * 1.9)}px;font-weight:700;fill:${C.wall}">${esc(o.title)}</text>`);
    out.push(`<text x="${f1(margin * 0.6)}" y="${f1(fs * 3.9)}" style="font-size:${f1(fs * 1.1)}px;font-weight:600;fill:${C.soft}">${esc(fmtSize(plan.box.w, plan.box.h, units))}   ${esc(fmtArea(plan.area, units))}</text>`);
    // a tape for scale: one foot (or 25 cm) per division
    const unitM = units === 'm' ? 0.25 : 0.3048;
    const divs = Math.max(2, Math.min(10, Math.floor((W * 0.32) / (unitM * s))));
    const tw = divs * unitM * s, tx = margin * 0.6, ty = H - fs * 2.2;
    out.push(`<rect x="${f1(tx)}" y="${f1(ty - fs * 0.6)}" width="${f1(tw)}" height="${f1(fs * 1.2)}" rx="2" style="fill:${C.tape}"/>`);
    for (let k = 0; k <= divs; k++) {
      const x = tx + k * unitM * s;
      out.push(`<line x1="${f1(x)}" y1="${f1(ty - fs * 0.6)}" x2="${f1(x)}" y2="${f1(ty - fs * 0.6 + (k % 4 === 0 ? fs * 0.75 : fs * 0.45))}" style="stroke:${C.tapeInk};stroke-width:1.2"/>`);
    }
    const label = units === 'm' ? `${(divs * unitM).toFixed(2).replace(/\.?0+$/, '')} m` : `${divs} ft`;
    out.push(`<text x="${f1(tx + tw + fs * 0.6)}" y="${f1(ty)}" dominant-baseline="central" style="font-size:${f1(fs * 0.9)}px;font-weight:600;fill:${C.soft}">${esc(label)}</text>`);
    if (o.date) out.push(`<text x="${f1(W - margin * 0.6)}" y="${f1(ty)}" text-anchor="end" dominant-baseline="central" style="font-size:${f1(fs * 0.85)}px;fill:${C.soft}">${esc(o.date)}</text>`);
  }
  out.push('</svg>');
  return out.join('');
}

// The live view: the lidar in the middle, front up, what it sees around it.
export function drawRadar(ctx, w, h, view) {
  const { revs, angle, range, units, colors } = view;
  const C = colors;
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2 - 6;
  const s = R / range;
  ctx.clearRect(0, 0, w, h);
  // rings every metre, or every 3 ft
  const step = units === 'm' ? 1 : 0.9144;
  ctx.lineWidth = 1;
  ctx.font = `600 ${Math.max(10, Math.round(R / 22))}px 'Barlow Semi Condensed', system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let k = 1; k * step <= range + 1e-6; k++) {
    const r = k * step * s;
    ctx.strokeStyle = C.grid;
    ctx.setLineDash(k % 2 ? [3, 5] : []);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = C.soft;
    ctx.fillText(units === 'm' ? `${k} m` : `${k * 3} ft`, cx + r * 0.7071 + 3, cy - r * 0.7071 - 6);
  }
  ctx.setLineDash([]);
  // the beam and the fading wedge behind it
  if (Number.isFinite(angle)) {
    const a = (angle - 90) * Math.PI / 180;
    const grad = ctx.createConicGradient ? ctx.createConicGradient(a - 0.6, cx, cy) : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.095, C.beamFade);
      grad.addColorStop(0.0955, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a - 0.6, a);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = C.mark;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();
  }
  // what it sees: the newest turn strongest
  revs.forEach((rev, k) => {
    const newest = k === revs.length - 1;
    ctx.fillStyle = newest ? C.mark : C.ink;
    ctx.globalAlpha = newest ? 1 : 0.18 + 0.5 * (k / revs.length);
    const dot = newest ? 2.4 : 1.8;
    for (let i = 0; i < rev.q6.length; i++) {
      if (!rev.q[i] || !rev.q2[i]) continue;
      const r = rev.q2[i] / 4000;
      if (r > range) continue;
      const th = (rev.q6[i] / 64) * Math.PI / 180;
      ctx.fillRect(cx + Math.sin(th) * r * s - dot / 2, cy - Math.cos(th) * r * s - dot / 2, dot, dot);
    }
  });
  ctx.globalAlpha = 1;
  // the lidar, front up
  ctx.fillStyle = C.ink;
  ctx.strokeStyle = C.paper;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx - 5, cy - 10);
  ctx.lineTo(cx + 5, cy - 10);
  ctx.closePath();
  ctx.fill();
}
