// Getting rooms out: the CAD file, backups, file names. (The image and drawing are checked in the browser test.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dxf, backup, readBackup, fileName, wallsText } from '../../js/export.js';
import { makePlan } from '../../js/plan.js';
import { SAMPLE_ROOMS } from '../../js/sim.js';
import { captureLooks } from './helpers.mjs';

const plan = makePlan(await captureLooks(SAMPLE_ROOMS[1], { looks: 2, seconds: 2.5, seed: 3 }));

function pairs(text) {
  const lines = text.split('\r\n');
  assert.equal(lines.pop(), '', 'ends with CRLF');
  assert.equal(lines.length % 2, 0, 'group codes and values come in pairs');
  const out = [];
  for (let i = 0; i < lines.length; i += 2) out.push([+lines[i], lines[i + 1]]);
  return out;
}

test('the CAD file is DXF R12 in millimetres, with the outline as one closed polyline', () => {
  const p = pairs(dxf(plan));
  assert.deepEqual(p[0], [0, 'SECTION']);
  assert.deepEqual(p.at(-1), [0, 'EOF']);
  const text = p.map(x => x.join(':'));
  assert.ok(text.includes('1:AC1009'));
  const sections = p.filter((x, i) => x[0] === 2 && p[i - 1]?.[1] === 'SECTION').map(x => x[1]);
  assert.deepEqual(sections, ['HEADER', 'TABLES', 'ENTITIES']);
  const layers = p.filter((x, i) => x[0] === 2 && p[i - 1]?.[1] === 'LAYER').map(x => x[1]);
  assert.deepEqual(layers, ['OUTLINE', 'WALLS', 'INFERRED', 'OPENINGS', 'OBJECTS']);
  // The outline: one POLYLINE on OUTLINE, closed (70 = 1), with a VERTEX per corner, in mm.
  const start = p.findIndex((x, i) => x[1] === 'POLYLINE' && p[i + 1][1] === 'OUTLINE');
  assert.ok(start > 0);
  const end = p.findIndex((x, i) => i > start && x[1] === 'SEQEND');
  const flags = p.slice(start, end).find(x => x[0] === 70);
  assert.equal(flags[1], '1');
  const xs = [], ys = [];
  for (let i = start; i < end; i++) {
    if (p[i][1] === 'VERTEX') { xs.push(+p[i + 2][1]); ys.push(+p[i + 3][1]); }
  }
  assert.equal(xs.length, plan.outline.length);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(w - plan.box.w * 1000) < 1 && Math.abs(h - plan.box.h * 1000) < 1, `${w} x ${h} mm`);
  // One LINE per edge, each on the layer for its kind.
  const lines = p.filter((x, i) => x[1] === 'LINE' && x[0] === 0).length;
  assert.equal(lines, plan.edges.length);
  assert.ok(!/NaN|undefined/.test(dxf(plan)));
});

test('a backup reads back, and a wrong file says what is wrong with it', () => {
  const rooms = [{ id: 'abc', name: 'Kitchen', looks: [{ a: '', d: '', s: [] }] }];
  assert.deepEqual(readBackup(backup(rooms)), rooms);
  assert.throws(() => readBackup('hello'), /isn’t JSON/);
  assert.throws(() => readBackup('{"rooms": []}'), /isn’t a Sweep backup/);
  assert.throws(() => readBackup('{"sweep": 1, "rooms": [{"id": 5}]}'), /no rooms/);
});

test('file names come from the room name', () => {
  assert.equal(fileName({ name: 'Living room (sample)' }, 'png'), 'living-room-sample.png');
  assert.equal(fileName({ name: 'Kid’s room #2' }, 'dxf'), 'kid-s-room-2.dxf');
  assert.equal(fileName({ name: '' }, 'svg'), 'room.svg');
  assert.equal(fileName({ name: '???' }, 'svg'), 'room.svg');
});

test('the walls as text, one per line', () => {
  const t = wallsText(plan, 'ft').split('\n');
  assert.equal(t.length, plan.runs.length);
  assert.match(t[0], /^Wall 1: \d+′ \d+″$/);
});
