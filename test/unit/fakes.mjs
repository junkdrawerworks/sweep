// Stand-ins for the hardware, for the unit tests: a CP2102 on WebUSB and a serial port on Web Serial, each with the
// simulated lidar behind it. Both behave as the real thing does at the level Sweep talks to it.
import { SimLidar, SAMPLE_ROOMS } from '../../js/sim.js';

// A Silicon Labs CP2102 as WebUSB shows it: one interface, a bulk endpoint each way, vendor control requests.
// It records every control request. Bytes only flow while the interface is enabled (IFC_ENABLE 1) at 115200 baud,
// and DTR (SET_MHS) switches the simulated motor the way the A1's adapter does: DTR on stops it.
export class FakeCp2102 {
  constructor(spec = SAMPLE_ROOMS[0], { seed = 3 } = {}) {
    this.vendorId = 0x10c4;
    this.productId = 0xea60;
    this.productName = 'CP2102 USB to UART Bridge Controller';
    this.sim = new SimLidar(spec, { seed, chunk: 0 });
    this.opened = false;
    this.configuration = null;
    this.claimed = null;
    this.requests = [];
    this.enabled = false;
    this.baud = 0;
    this.dtr = false;
    this.rx = [];
    this.waiting = [];
    this.sim.connect(bytes => { if (this.enabled && this.baud === 115200) { for (const b of bytes) this.rx.push(b); this.pump(); } });
    this.clock = setInterval(() => this.sim.tick(5), 5);
  }

  async open() { this.opened = true; }
  async selectConfiguration(n) {
    if (!this.opened) throw new Error('not open');
    this.configuration = {
      configurationValue: n,
      interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [
        { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
        { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
      ] } }],
    };
  }
  async claimInterface(n) { if (!this.configuration) throw new Error('no configuration'); this.claimed = n; }
  async releaseInterface() { this.claimed = null; }

  async controlTransferOut(setup, data) {
    if (this.claimed === null) throw new Error('interface not claimed');
    const bytes = data ? Array.from(new Uint8Array(data)) : null;
    this.requests.push({ ...setup, data: bytes });
    const { request, value } = setup;
    if (request === 0x00) this.enabled = value === 1;
    if (request === 0x1e) this.baud = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    if (request === 0x07 && (value & 0x0100)) { this.dtr = (value & 1) === 1; this.sim.setMotor(!this.dtr); }
    return { status: 'ok', bytesWritten: bytes ? bytes.length : 0 };
  }

  async transferOut(ep, bytes) {
    if (!this.enabled) throw new Error('interface disabled');
    this.sim.receive(bytes);
    return { status: 'ok', bytesWritten: bytes.length };
  }

  transferIn(ep, length) {
    return new Promise((resolve, reject) => { this.waiting.push({ length, resolve, reject }); this.pump(); });
  }

  pump() {
    while (this.waiting.length && this.rx.length) {
      const w = this.waiting.shift();
      const chunk = Uint8Array.from(this.rx.splice(0, Math.min(w.length, 64 * 4)));
      w.resolve({ status: 'ok', data: new DataView(chunk.buffer) });
    }
  }

  async clearHalt() {}
  async close() { this.opened = false; this.stop(); }
  stop() { clearInterval(this.clock); for (const w of this.waiting.splice(0)) w.reject(new DOMException('The device was disconnected.', 'NetworkError')); }
}

// navigator.usb with one device plugged in.
export function fakeUsb(device) {
  const listeners = new Set();
  return {
    requested: [],
    async getDevices() { return []; },
    async requestDevice(opts) { this.requested.push(opts); return device; },
    addEventListener(type, fn) { if (type === 'disconnect') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    unplug() { device.stop(); for (const fn of listeners) fn({ device }); },
  };
}

// A Web Serial port with the simulated lidar behind it.
export class FakeSerialPort {
  constructor(spec = SAMPLE_ROOMS[0], { seed = 3 } = {}) {
    this.sim = new SimLidar(spec, { seed, chunk: 40 });
    this.signals = [];
    this.options = null;
    this.listeners = new Set();
    this.readable = null;
    this.writable = null;
  }
  getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; }
  async open(options) {
    if (this.options) throw new DOMException('The port is already open.', 'InvalidStateError');
    this.options = options;
    let ctrl;
    this.readable = new ReadableStream({ start: c => { ctrl = c; } });
    this.sim.connect(bytes => { try { ctrl.enqueue(bytes); } catch { /* closed */ } });
    this.writable = new WritableStream({ write: chunk => this.sim.receive(chunk) });
    this.clock = setInterval(() => this.sim.tick(5), 5);
    this.ctrl = ctrl;
  }
  async setSignals(s) {
    this.signals.push(s);
    if ('dataTerminalReady' in s) this.sim.setMotor(!s.dataTerminalReady);
  }
  addEventListener(type, fn) { this.listeners.add(fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }
  async close() { clearInterval(this.clock); this.options = null; }
}
