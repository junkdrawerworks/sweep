// Getting a room out of Sweep: an image, a drawing, a CAD file, and a backup of every room.

import { planSvg, PRINT } from './render.js';
import { fmtLength } from './units.js';

let fontCss = null;
// The plan's font, embedded, so an exported drawing looks the same anywhere. Fails quietly (the Artifact copy).
async function embeddedFont() {
  if (fontCss !== null) return fontCss;
  const one = async (file, weight) => {
    const res = await fetch(file);
    if (!res.ok) throw new Error('font');
    const bytes = new Uint8Array(await res.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `@font-face{font-family:'Barlow Semi Condensed';font-weight:${weight};src:url(data:font/woff2;base64,${btoa(s)}) format('woff2')}`;
  };
  try {
    fontCss = (await one('fonts/barlow-semi-condensed-600.woff2', 600)) + (await one('fonts/barlow-semi-condensed-700.woff2', 700));
  } catch { fontCss = ''; }
  return fontCss;
}

const stamp = d => new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

export async function drawingSvg(room, plan, units, size = { width: 1600, height: 1200 }) {
  return planSvg(plan, {
    ...size, units, colors: PRINT, background: true, title: room.name,
    date: `Measured with Sweep, ${stamp(room.created || Date.now())}`, fontCss: await embeddedFont(), fontSize: 22,
  });
}

export async function imageBlob(room, plan, units, size = { width: 1600, height: 1200 }) {
  const svg = await drawingSvg(room, plan, units, size);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('image')); img.src = url; });
    const c = document.createElement('canvas');
    c.width = size.width;
    c.height = size.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return await new Promise(resolve => c.toBlob(resolve, 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

// DXF, AutoCAD R12 text, millimetres. Layers: OUTLINE (one closed polyline: extrude it in OpenSCAD with
// import("room.dxf", layer="OUTLINE")), WALLS, INFERRED (walls Sweep had to guess), OPENINGS, OBJECTS.
export function dxf(plan) {
  const L = [];
  // Group codes 60-99 hold whole numbers (flags, colours); 10-59 hold coordinates and other real numbers.
  const whole = code => (code >= 60 && code <= 99) || (code >= 170 && code <= 179) || (code >= 270 && code <= 289);
  const g = (code, v) => {
    L.push(String(code), typeof v !== 'number' ? String(v) : whole(code) ? String(Math.round(v)) : (Math.round(v * 1000) / 1000).toFixed(3));
  };
  const mm = v => v * 1000;
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 5);
  const layers = [['OUTLINE', 7], ['WALLS', 7], ['INFERRED', 8], ['OPENINGS', 1], ['OBJECTS', 9]];
  for (const [name, color] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (layer, pts) => {
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(70, 1); g(10, 0); g(20, 0); g(30, 0);
    for (const p of pts) { g(0, 'VERTEX'); g(8, layer); g(10, mm(p[0])); g(20, mm(p[1])); g(30, 0); }
    g(0, 'SEQEND'); g(8, layer);
  };
  poly('OUTLINE', plan.outline);
  const layerOf = { wall: 'WALLS', inferred: 'INFERRED', opening: 'OPENINGS' };
  for (const e of plan.edges) {
    g(0, 'LINE'); g(8, layerOf[e.kind] || 'WALLS');
    g(10, mm(e.a[0])); g(20, mm(e.a[1])); g(30, 0);
    g(11, mm(e.b[0])); g(21, mm(e.b[1])); g(31, 0);
  }
  for (const o of plan.objects) poly('OBJECTS', o);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

export function backup(rooms) {
  return JSON.stringify({ sweep: 1, exported: new Date().toISOString(), rooms }, null, 1);
}

// Rooms from a backup file, or an error saying what's wrong with it.
export function readBackup(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('That file isn’t a Sweep backup: it isn’t JSON.'); }
  if (!doc || doc.sweep !== 1 || !Array.isArray(doc.rooms)) throw new Error('That file isn’t a Sweep backup.');
  const rooms = doc.rooms.filter(r => r && typeof r.id === 'string' && Array.isArray(r.looks) && r.looks.length);
  if (!rooms.length) throw new Error('That backup has no rooms in it.');
  return rooms;
}

export function fileName(room, ext) {
  const base = (room.name || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';
  return `${base}.${ext}`;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function wallsText(plan, units) {
  return plan.runs.map((r, i) => `Wall ${i + 1}: ${fmtLength(r.len, units)}`).join('\n');
}
