// The three ways to reach the lidar, each with the Lidar driver on top, against stand-ins for the hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lidar } from '../../js/lidar.js';
import { Cp210xTransport, SerialTransport, SimTransport, pickMethod } from '../../js/transports.js';
import { SimLidar, SAMPLE_ROOMS } from '../../js/sim.js';
import { Revolutions } from '../../js/capture.js';
import { FakeCp2102, fakeUsb, FakeSerialPort } from './fakes.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
function setNavigator(props) {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(globalThis.navigator, k, { value: v, configurable: true, writable: true });
}
function clearNavigator(...keys) { for (const k of keys) delete globalThis.navigator[k]; }

// Streams for a while and returns what the live view would show.
async function stream(lidar, ms) {
  const revs = [];
  const R = new Revolutions(r => revs.push(r));
  lidar.onNodes = nodes => R.push(nodes);
  await wait(ms);
  lidar.onNodes = null;
  return { revs, hz: R.hz, sps: R.sps };
}

test('WebUSB: Sweep sets the CP2102 up the way Silicon Labs documents (AN571)', async () => {
  const dev = new FakeCp2102();
  const usb = fakeUsb(dev);
  setNavigator({ usb });
  try {
    const t = await Cp210xTransport.choose();
    assert.deepEqual(usb.requested[0], { filters: [{ vendorId: 0x10c4, productId: 0xea60 }] });
    const lidar = new Lidar(t);
    const info = await lidar.open();
    // Every request is vendor type, to the interface (bmRequestType 0x41), with the interface number as wIndex.
    for (const r of dev.requests) {
      assert.equal(r.requestType, 'vendor');
      assert.equal(r.recipient, 'interface');
      assert.equal(r.index, 0);
    }
    const seq = dev.requests.map(r => [r.request, r.value, r.data]);
    assert.deepEqual(seq.slice(0, 6), [
      [0x00, 0x0001, null], // IFC_ENABLE: on
      [0x1e, 0, [0x00, 0xc2, 0x01, 0x00]], // SET_BAUDRATE: 115200, little-endian
      [0x03, 0x0800, null], // SET_LINE_CTL: 8 data bits, no parity, 1 stop bit
      [0x07, 0x0300, null], // SET_MHS: DTR and RTS both off (masks set)
      [0x13, 0, Array(16).fill(0)], // SET_FLOW: no handshaking
      [0x12, 0x000f, null], // PURGE: both directions
    ]);
    // Then Lidar.open() turns the motor on: DTR off.
    assert.deepEqual(seq[6], [0x07, 0x0100, null]);
    assert.equal(info.name, 'RPLIDAR A1M8');
    assert.equal(info.firmware, '1.29');
    assert.equal(lidar.health.text, 'Good');
    assert.equal(lidar.rate.standard, 2000);
    assert.equal(t.label, 'USB, CP2102 driven by Sweep');

    await lidar.startScan();
    const s = await stream(lidar, 1500);
    assert.ok(s.revs.length >= 5, `${s.revs.length} turns in 1.5 s`);
    assert.ok(s.hz > 5 && s.hz < 7.5, `spinning at ${s.hz} turns a second`);
    assert.ok(s.sps > 1700 && s.sps < 2300, `${s.sps} points a second`);

    // Stop the motor: DTR on. Start it: DTR off.
    await lidar.setMotor(false);
    assert.deepEqual(seq.length < dev.requests.length && [dev.requests.at(-1).request, dev.requests.at(-1).value], [0x07, 0x0101]);
    assert.equal(dev.sim.motor, false);
    await lidar.setMotor(true);
    assert.deepEqual([dev.requests.at(-1).request, dev.requests.at(-1).value], [0x07, 0x0100]);

    await lidar.close();
    const last = dev.requests.at(-1);
    assert.deepEqual([last.request, last.value], [0x00, 0x0000]); // IFC_ENABLE: off
    assert.equal(dev.claimed, null);
    assert.equal(dev.opened, false);
  } finally { dev.stop(); clearNavigator('usb'); }
});

test('WebUSB: unplugging the adapter closes the lidar', async () => {
  const dev = new FakeCp2102();
  const usb = fakeUsb(dev);
  setNavigator({ usb });
  try {
    const lidar = new Lidar(await Cp210xTransport.choose());
    await lidar.open();
    await lidar.startScan();
    let closed = null;
    lidar.onClose = err => { closed = err; };
    usb.unplug();
    await wait(20);
    assert.ok(closed, 'onClose should have been called');
    assert.equal(lidar.scanning, false);
  } finally { dev.stop(); clearNavigator('usb'); }
});

test('Web Serial: opens at 115200 8N1 with a big buffer, reads the lidar, DTR switches the motor', async () => {
  const port = new FakeSerialPort(SAMPLE_ROOMS[1]);
  const requested = [];
  setNavigator({ serial: { getPorts: async () => [], requestPort: async o => { requested.push(o); return port; } } });
  try {
    const t = await SerialTransport.choose();
    assert.deepEqual(requested[0], { filters: [{ usbVendorId: 0x10c4, usbProductId: 0xea60 }] });
    const lidar = new Lidar(t);
    const info = await lidar.open();
    assert.deepEqual(port.options, { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 32768 });
    assert.deepEqual(port.signals[0], { dataTerminalReady: false }); // motor on
    assert.equal(info.name, 'RPLIDAR A1M8');
    assert.equal(t.label, 'USB serial, CP2102');
    await lidar.startScan();
    const s = await stream(lidar, 1200);
    assert.ok(s.revs.length >= 4, `${s.revs.length} turns`);
    await lidar.setMotor(false);
    assert.deepEqual(port.signals.at(-1), { dataTerminalReady: true });
    await lidar.close();
  } finally { clearNavigator('serial'); }
});

test('Web Serial: a port Chrome already knows is used without asking again', async () => {
  const port = new FakeSerialPort();
  let asked = 0;
  setNavigator({ serial: { getPorts: async () => [port], requestPort: async () => { asked++; return port; } } });
  try {
    const t = await SerialTransport.choose();
    assert.equal(t.port, port);
    assert.equal(asked, 0);
  } finally { clearNavigator('serial'); }
});

test('the simulated lidar answers like the real one', async () => {
  const lidar = new Lidar(new SimTransport(new SimLidar(SAMPLE_ROOMS[2], { seed: 8, chunk: 48 })));
  const info = await lidar.open();
  assert.equal(info.name, 'RPLIDAR A1M8');
  assert.equal(lidar.t.label, 'Simulated lidar');
  await lidar.startScan();
  const s = await stream(lidar, 1000);
  assert.ok(s.revs.length >= 4);
  // A health check in the middle of a scan stops it, asks, and starts it again.
  const h = await lidar.refreshHealth();
  assert.equal(h.text, 'Good');
  assert.equal(lidar.scanning, true);
  const s2 = await stream(lidar, 600);
  assert.ok(s2.revs.length >= 2, 'the scan should be running again');
  await lidar.close();
});

test('the lidar asks again when its first question goes unanswered', async () => {
  const sim = new SimLidar(SAMPLE_ROOMS[0], { seed: 2 });
  let swallowed = 0;
  const receive = sim.receive.bind(sim);
  sim.receive = bytes => { if (bytes[1] === 0x50 && swallowed++ === 0) return; receive(bytes); }; // lose the first GET_INFO
  const lidar = new Lidar(new SimTransport(sim));
  const info = await lidar.open();
  assert.equal(swallowed, 2);
  assert.equal(info.name, 'RPLIDAR A1M8');
  await lidar.close();
});

test('which way to connect', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const as = nav => Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  try {
    as({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/142', serial: {}, usb: {} });
    assert.equal(pickMethod('auto'), 'serial');
    assert.equal(pickMethod('usb'), 'usb');
    as({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/148 Mobile', serial: {}, usb: {} });
    assert.equal(pickMethod('auto'), 'usb'); // Android lists no USB adapters under Web Serial
    assert.equal(pickMethod('serial'), 'serial');
    as({ userAgent: 'Mozilla/5.0 (iPhone) Safari' });
    assert.equal(pickMethod('auto'), null);
    as({ userAgent: 'Mozilla/5.0 Firefox/140' });
    assert.equal(pickMethod('usb'), null);
  } finally { Object.defineProperty(globalThis, 'navigator', saved); }
});
