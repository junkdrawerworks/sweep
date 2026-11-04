// The RPLIDAR byte protocol: commands, answer descriptors, measurements, and the streaming parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CMD, TYPE, LENGTH, command, descriptor, parseDescriptor, decodeNode, encodeNode,
  modelName, parseInfo, parseHealth, parseSampleRate, Parser,
} from '../../js/protocol.js';
import { rng } from '../../js/geom.js';

test('commands are 0xA5 then the command byte', () => {
  assert.deepEqual([...command(CMD.SCAN)], [0xa5, 0x20]);
  assert.deepEqual([...command(CMD.STOP)], [0xa5, 0x25]);
  assert.deepEqual([...command(CMD.RESET)], [0xa5, 0x40]);
  assert.deepEqual([...command(CMD.GET_INFO)], [0xa5, 0x50]);
  assert.deepEqual([...command(CMD.GET_HEALTH)], [0xa5, 0x52]);
  assert.deepEqual([...command(CMD.GET_SAMPLERATE)], [0xa5, 0x59]);
});

test('answer descriptors: the scan one from the A1 datasheet, and round trips', () => {
  // The datasheet's scan descriptor: A5 5A 05 00 00 40 81 (length 5, multiple answers, type 0x81).
  assert.deepEqual([...descriptor(TYPE.SCAN, LENGTH.SCAN, true)], [0xa5, 0x5a, 0x05, 0x00, 0x00, 0x40, 0x81]);
  assert.deepEqual(parseDescriptor([0xa5, 0x5a, 0x05, 0x00, 0x00, 0x40, 0x81]), { length: 5, multiple: true, type: 0x81 });
  // Device info: A5 5A 14 00 00 00 04 (20 bytes, single answer).
  assert.deepEqual([...descriptor(TYPE.INFO, LENGTH.INFO)], [0xa5, 0x5a, 0x14, 0x00, 0x00, 0x00, 0x04]);
  assert.deepEqual(parseDescriptor(descriptor(TYPE.HEALTH, LENGTH.HEALTH)), { length: 3, multiple: false, type: 0x06 });
  assert.equal(parseDescriptor([0x00, 0x5a, 0x05, 0, 0, 0x40, 0x81]), null);
});

test('measurements decode, round trip, and fail their check bits when out of step', () => {
  const R = rng(5);
  for (let k = 0; k < 2000; k++) {
    const start = R() < 0.1, q = Math.floor(R() * 64), q6 = Math.floor(R() * 23040), q2 = Math.floor(R() * 65536);
    const bytes = encodeNode(start, q, q6, q2);
    assert.deepEqual(decodeNode(bytes), { start, quality: q, q6, q2 });
  }
  // S and not-S equal: out of step.
  assert.equal(decodeNode([0b00000011, 0x01, 0, 0, 0]), null);
  assert.equal(decodeNode([0b00000000, 0x01, 0, 0, 0]), null);
  // The angle's check bit is always 1.
  assert.equal(decodeNode([0b00000010, 0x00, 0, 0, 0]), null);
  // A real one: start of a turn, quality 15, 90.0 degrees (5760/64), 1000 mm (4000/4).
  assert.deepEqual(decodeNode([(15 << 2) | 0b01, ((5760 & 0x7f) << 1) | 1, 5760 >> 7, 4000 & 0xff, 4000 >> 8]), { start: true, quality: 15, q6: 5760, q2: 4000 });
});

test('device info reads as the lidar reports it', () => {
  assert.equal(modelName(0x18), 'RPLIDAR A1M8');
  assert.equal(modelName(0x28), 'RPLIDAR A2M8');
  assert.equal(modelName(0x61), 'RPLIDAR, model 0x61');
  const serial = Array.from({ length: 16 }, (_, i) => i * 17);
  const info = parseInfo(Uint8Array.from([0x18, 29, 1, 7, ...serial]));
  assert.equal(info.name, 'RPLIDAR A1M8');
  assert.equal(info.firmware, '1.29');
  assert.equal(info.hardware, 7);
  assert.equal(info.serial, '00112233445566778899AABBCCDDEEFF');
  assert.equal(parseInfo(Uint8Array.from([0x18, 5, 1, 7, ...serial])).firmware, '1.05');
});

test('health and sample rate', () => {
  assert.deepEqual(parseHealth([0, 0, 0]), { status: 0, text: 'Good', error: 0 });
  assert.deepEqual(parseHealth([1, 0, 0]), { status: 1, text: 'Warning', error: 0 });
  assert.deepEqual(parseHealth([2, 0x34, 0x12]), { status: 2, text: 'Error', error: 0x1234 });
  assert.equal(parseHealth([7, 0, 0]).text, 'Unknown (7)');
  // 500 us a sample in standard mode is 2000 samples a second.
  assert.deepEqual(parseSampleRate([0xf4, 0x01, 0xfa, 0x00]), { standardUs: 500, expressUs: 250, standard: 2000 });
});

function streamOf(nodes) {
  const out = [];
  for (const n of nodes) out.push(...encodeNode(n.start, n.quality, n.q6, n.q2));
  return out;
}

function randomNodes(n, seed) {
  const R = rng(seed);
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push({ start: i % 360 === 0, quality: 1 + Math.floor(R() * 62), q6: (i * 64) % 23040, q2: 400 + Math.floor(R() * 40000) });
  return nodes;
}

test('the parser collects a single answer whatever chunks it arrives in', async () => {
  const answer = [...descriptor(TYPE.INFO, LENGTH.INFO), 0x18, 29, 1, 7, ...Array(16).fill(0xab)];
  for (const size of [1, 2, 3, 7, 64]) {
    const p = new Parser();
    const got = p.expect(TYPE.INFO, LENGTH.INFO);
    p.push(Uint8Array.from([0x13, 0x37])); // noise first
    for (let i = 0; i < answer.length; i += size) p.push(Uint8Array.from(answer.slice(i, i + size)));
    const data = await got;
    assert.equal(data.length, 20);
    assert.equal(parseInfo(data).name, 'RPLIDAR A1M8');
  }
});

test('the parser ignores bytes nobody asked for, and a reset rejects the wait', async () => {
  const p = new Parser();
  p.push(new TextEncoder().encode('RP LIDAR System.\r\n')); // the reset banner, in idle mode
  assert.equal(p.len, 0);
  const got = p.expect(TYPE.HEALTH, LENGTH.HEALTH);
  p.reset('stopped');
  await assert.rejects(got, /stopped/);
});

test('in scan mode the parser streams measurements, in any chunking', async () => {
  const nodes = randomNodes(1500, 3);
  const bytes = [...descriptor(TYPE.SCAN, LENGTH.SCAN, true), ...streamOf(nodes)];
  const R = rng(9);
  const p = new Parser();
  const got = [];
  p.onNodes = ns => got.push(...ns);
  const started = p.expect(TYPE.SCAN, LENGTH.SCAN);
  for (let i = 0; i < bytes.length;) { const n = 1 + Math.floor(R() * 70); p.push(Uint8Array.from(bytes.slice(i, i + n))); i += n; }
  assert.equal(await started, null);
  // Every measurement but possibly the last (which can't be confirmed in step until another follows).
  assert.ok(got.length >= nodes.length - 1, `${got.length} of ${nodes.length}`);
  assert.deepEqual(got, nodes.slice(0, got.length));
  assert.equal(p.dropped, 0);
});

test('the parser finds its step again after lost bytes, and never passes on a broken measurement', () => {
  const nodes = randomNodes(4000, 4);
  const bytes = streamOf(nodes);
  const R = rng(12);
  // Lose a byte here and there, as a full USB buffer would.
  const lossy = bytes.filter(() => R() > 0.002);
  const p = new Parser();
  const got = [];
  p.onNodes = ns => got.push(...ns);
  p.expect(TYPE.SCAN, LENGTH.SCAN);
  p.push(descriptor(TYPE.SCAN, LENGTH.SCAN, true));
  for (let i = 0; i < lossy.length; i += 64) p.push(Uint8Array.from(lossy.slice(i, i + 64)));
  assert.ok(p.dropped > 0, 'it should have had to skip bytes');
  assert.ok(got.length > nodes.length * 0.9, `kept ${got.length} of ${nodes.length}`);
  // Everything it passed on is a measurement that was really sent.
  const sent = new Set(nodes.map(n => `${n.q6}:${n.q2}`));
  const fake = got.filter(n => !sent.has(`${n.q6}:${n.q2}`));
  assert.ok(fake.length <= got.length * 0.002, `${fake.length} measurements were made up from misaligned bytes`);
});
