// Three ways to reach a lidar, all with the same shape: open(), write(bytes), setDTR(on), close(),
// calling onData(bytes) as bytes arrive and onClose(err) if the device goes away.
//
//  - SerialTransport: Web Serial (Chrome and Edge on a computer). The operating system's CP210x driver does the USB.
//  - Cp210xTransport: WebUSB, for Chrome on Android, where Web Serial doesn't list USB adapters. Sweep drives the
//    adapter's Silicon Labs CP2102 chip itself, with the same requests Silicon Labs documents in AN571 and
//    usb-serial-for-android uses.
//  - SimTransport: the simulated lidar, for the demo and the tests.

const SILABS = 0x10c4;
const CP210X = 0xea60;
const BAUD = 115200;

export const supports = {
  serial: () => typeof navigator !== 'undefined' && 'serial' in navigator,
  usb: () => typeof navigator !== 'undefined' && 'usb' in navigator,
};

export const isAndroid = () => typeof navigator !== 'undefined' &&
  (navigator.userAgentData?.platform === 'Android' || /Android/i.test(navigator.userAgent || ''));

// Which way to connect: Web Serial on a computer, WebUSB on Android. 'auto' picks.
export function pickMethod(pref = 'auto') {
  if (pref === 'serial' && supports.serial()) return 'serial';
  if (pref === 'usb' && supports.usb()) return 'usb';
  if (isAndroid() && supports.usb()) return 'usb';
  if (supports.serial()) return 'serial';
  if (supports.usb()) return 'usb';
  return null;
}

export class SerialTransport {
  constructor(port = null) {
    this.kind = 'serial';
    this.port = port;
    this.onData = null;
    this.onClose = null;
    this.closing = false;
  }

  // Must run from a tap or click the first time: that's when Chrome may show its port picker.
  static async choose(any = false) {
    const known = await navigator.serial.getPorts();
    const mine = known.find(p => { const i = p.getInfo(); return i.usbVendorId === SILABS && i.usbProductId === CP210X; });
    if (mine && !any) return new SerialTransport(mine);
    const port = any ? await navigator.serial.requestPort()
      : await navigator.serial.requestPort({ filters: [{ usbVendorId: SILABS, usbProductId: CP210X }] });
    return new SerialTransport(port);
  }

  get label() {
    const i = this.port?.getInfo?.() || {};
    return i.usbVendorId === SILABS ? 'USB serial, CP2102' : 'USB serial';
  }

  async open() {
    await this.port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 32768 });
    this.writer = this.port.writable.getWriter();
    this.gone = () => this.finish(new Error('unplugged'));
    this.port.addEventListener('disconnect', this.gone);
    this.loop();
  }

  async loop() {
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length && this.onData) this.onData(value);
        }
      } catch (err) {
        if (!this.closing && err?.name !== 'BufferOverrunError' && err?.name !== 'FramingError' && err?.name !== 'ParityError' && err?.name !== 'BreakError') {
          this.finish(err);
          return;
        }
      } finally {
        try { this.reader.releaseLock(); } catch { /* released */ }
      }
    }
  }

  async write(bytes) { await this.writer.write(bytes); }
  async setDTR(on) { await this.port.setSignals({ dataTerminalReady: on }); }

  finish(err) {
    if (this.closing) return;
    this.closing = true;
    if (this.onClose) this.onClose(err);
  }

  async close() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* fine */ }
    try { this.writer?.releaseLock(); } catch { /* fine */ }
    try { this.port.removeEventListener('disconnect', this.gone); } catch { /* fine */ }
    try { await this.port.close(); } catch { /* fine */ }
  }
}

// CP210x vendor requests (bmRequestType 0x41: host to device, vendor, interface).
const REQ = { IFC_ENABLE: 0x00, SET_LINE_CTL: 0x03, SET_MHS: 0x07, PURGE: 0x12, SET_FLOW: 0x13, SET_BAUDRATE: 0x1e };

export class Cp210xTransport {
  constructor(device) {
    this.kind = 'usb';
    this.device = device;
    this.onData = null;
    this.onClose = null;
    this.closing = false;
    this.dtr = false;
    this.rts = false;
    this.log = []; // control requests sent, for the device panel and the tests
  }

  static async choose() {
    const known = await navigator.usb.getDevices();
    const mine = known.find(d => d.vendorId === SILABS && d.productId === CP210X);
    if (mine) return new Cp210xTransport(mine);
    return new Cp210xTransport(await navigator.usb.requestDevice({ filters: [{ vendorId: SILABS, productId: CP210X }] }));
  }

  get label() { return 'USB, CP2102 driven by Sweep'; }

  ctrl(request, value, data) {
    this.log.push([request, value, data ? Array.from(new Uint8Array(data)) : null]);
    return this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request, value, index: this.iface }, data);
  }

  mhs() { return (this.dtr ? 0x0101 : 0x0100) | (this.rts ? 0x0202 : 0x0200); }

  async open() {
    const d = this.device;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    const iface = d.configuration.interfaces[0];
    this.iface = iface.interfaceNumber;
    await d.claimInterface(this.iface);
    const eps = iface.alternate.endpoints;
    this.epIn = eps.find(e => e.direction === 'in' && e.type === 'bulk');
    this.epOut = eps.find(e => e.direction === 'out' && e.type === 'bulk');
    if (!this.epIn || !this.epOut) throw new Error('This USB device has no serial endpoints');
    const baud = new DataView(new ArrayBuffer(4));
    baud.setUint32(0, BAUD, true);
    await this.ctrl(REQ.IFC_ENABLE, 0x0001);
    await this.ctrl(REQ.SET_BAUDRATE, 0, baud.buffer);
    await this.ctrl(REQ.SET_LINE_CTL, 0x0800); // 8 data bits, no parity, 1 stop bit
    await this.ctrl(REQ.SET_MHS, this.mhs());
    await this.ctrl(REQ.SET_FLOW, 0, this.flow());
    await this.ctrl(REQ.PURGE, 0x000f);
    this.gone = e => { if (e.device === d) this.finish(new Error('unplugged')); };
    navigator.usb.addEventListener('disconnect', this.gone);
    this.loop();
  }

  // No handshaking; DTR and RTS held at the levels Sweep sets.
  flow() {
    const f = new Uint8Array(16);
    if (this.dtr) f[0] |= 0x01;
    if (this.rts) f[4] |= 0x40;
    return f.buffer;
  }

  async loop() {
    const ep = this.epIn.endpointNumber;
    const size = 64 * 32;
    // Two reads in flight so no bytes wait while one is being handled. They complete in order. Each read's failure
    // comes back as a value, so the one still in flight when the adapter goes away doesn't fail unheard.
    const read = () => this.device.transferIn(ep, size).then(r => r, error => ({ error }));
    const inflight = [read(), read()];
    while (!this.closing) {
      const r = await inflight.shift();
      if (this.closing) return;
      if (r.error) { this.finish(r.error); return; }
      if (r.status === 'stall') {
        try { await this.device.clearHalt('in', ep); } catch (err) { this.finish(err); return; }
      } else if (r.data && r.data.byteLength && this.onData) {
        this.onData(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      }
      inflight.push(read());
    }
  }

  async write(bytes) { await this.device.transferOut(this.epOut.endpointNumber, bytes); }

  async setDTR(on) {
    this.dtr = on;
    await this.ctrl(REQ.SET_MHS, on ? 0x0101 : 0x0100);
  }

  finish(err) {
    if (this.closing) return;
    this.closing = true;
    if (this.onClose) this.onClose(err);
  }

  async close() {
    this.closing = true;
    try { navigator.usb.removeEventListener('disconnect', this.gone); } catch { /* fine */ }
    try { await this.ctrl(REQ.IFC_ENABLE, 0x0000); } catch { /* fine */ }
    try { await this.device.releaseInterface(this.iface); } catch { /* fine */ }
    try { await this.device.close(); } catch { /* fine */ }
  }
}

// The simulated lidar on a clock: real time in the demo, or stepped by hand in the tests.
export class SimTransport {
  constructor(sim, { realtime = true } = {}) {
    this.kind = 'demo';
    this.sim = sim;
    this.realtime = realtime;
    this.onData = null;
    this.onClose = null;
  }

  get label() { return 'Simulated lidar'; }

  async open() {
    this.sim.connect(bytes => { if (this.onData) this.onData(bytes); });
    if (this.realtime) {
      let last = performance.now();
      this.timer = setInterval(() => {
        const now = performance.now();
        this.sim.tick(Math.min(100, now - last));
        last = now;
      }, 15);
    }
  }

  async write(bytes) { this.sim.receive(bytes); }
  async setDTR(on) { this.sim.setMotor(!on); }
  hint(ev) { this.sim.hint(ev); }
  async close() { clearInterval(this.timer); this.sim.disconnect(); }
}
