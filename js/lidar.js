// Talks to an RPLIDAR A1 through a transport (Web Serial, WebUSB, or the simulator).
// A transport has open(), write(bytes), setDTR(on), close(), and calls onData(bytes) and onClose(err).
//
// The motor: on the A1's own USB adapter, DTR switches the motor. DTR off lets it spin; DTR on stops it, which is
// what Slamtec's SDK does for the A1. Some adapters tie the motor on regardless, so Sweep never relies on stopping it.

import { CMD, TYPE, LENGTH, Parser, command, parseInfo, parseHealth, parseSampleRate } from './protocol.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

function timeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(what)), ms); }),
  ]).finally(() => clearTimeout(t));
}

export class Lidar {
  constructor(transport) {
    this.t = transport;
    this.parser = new Parser();
    this.info = null;
    this.health = null;
    this.rate = null;
    this.scanning = false;
    this.motorOn = true;
    this.onNodes = null; // (nodes[]) => void while scanning
    this.onClose = null;
    this.t.onData = bytes => this.parser.push(bytes);
    this.t.onClose = err => {
      this.scanning = false;
      this.parser.reset('disconnected');
      if (this.onClose) this.onClose(err);
    };
    this.parser.onNodes = nodes => { if (this.onNodes) this.onNodes(nodes); };
  }

  get kind() { return this.t.kind; }

  async ask(cmd, type, length, ms = 800) {
    const answer = this.parser.expect(type, length);
    await this.t.write(command(cmd));
    return timeout(answer, ms, 'no answer');
  }

  // Ask twice before giving up: the first request after opening a port is sometimes lost.
  async askTwice(cmd, type, length) {
    try { return await this.ask(cmd, type, length); } catch {
      await this.stop();
      return this.ask(cmd, type, length, 1500);
    }
  }

  async open() {
    await this.t.open();
    await this.setMotor(true);
    await this.stop();
    await wait(30);
    this.info = parseInfo(await this.askTwice(CMD.GET_INFO, TYPE.INFO, LENGTH.INFO));
    this.health = parseHealth(await this.askTwice(CMD.GET_HEALTH, TYPE.HEALTH, LENGTH.HEALTH));
    try {
      this.rate = parseSampleRate(await this.ask(CMD.GET_SAMPLERATE, TYPE.SAMPLERATE, LENGTH.SAMPLERATE));
    } catch { this.rate = null; } // older firmware doesn't know this one
    return this.info;
  }

  async refreshHealth() {
    const was = this.scanning;
    if (was) await this.stop();
    this.health = parseHealth(await this.askTwice(CMD.GET_HEALTH, TYPE.HEALTH, LENGTH.HEALTH));
    if (was) await this.startScan();
    return this.health;
  }

  async startScan() {
    await this.stop();
    await wait(20);
    const started = this.parser.expect(TYPE.SCAN, LENGTH.SCAN);
    await this.t.write(command(CMD.SCAN));
    await timeout(started, 2000, 'the scan did not start');
    this.scanning = true;
  }

  async stop() {
    this.scanning = false;
    this.parser.reset('stopped');
    await this.t.write(command(CMD.STOP));
    await wait(10);
    this.parser.reset('stopped');
  }

  // A reset reboots the scan core; it prints a banner (ignored) and needs about a second.
  async reset() {
    this.scanning = false;
    this.parser.reset('reset');
    await this.t.write(command(CMD.RESET));
    await wait(1000);
    this.parser.reset('reset');
  }

  async setMotor(on) {
    await this.t.setDTR(!on);
    this.motorOn = on;
  }

  async close() {
    try { if (this.scanning) await this.stop(); } catch { /* already gone */ }
    this.parser.reset('closed');
    await this.t.close();
  }
}
