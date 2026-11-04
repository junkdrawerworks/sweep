// The RPLIDAR serial protocol, as the A1M8 speaks it: 115200 baud, 8 data bits, no parity, 1 stop bit.
// Every request is 0xA5 then a command byte. Answers start with a 7-byte descriptor (0xA5 0x5A, a 30-bit length,
// a 2-bit mode, a type byte), then the data. A scan answers once, then streams 5-byte measurements until STOP.
// References: Slamtec's RPLIDAR interface protocol and SDK (rplidar_cmd.h), and two drivers tested on the A1
// (SkoltechRobotics/rplidar for Python, @tsofist/rplidar for Web Serial).

export const SYNC1 = 0xa5;
export const SYNC2 = 0x5a;

export const CMD = {
  STOP: 0x25, // no answer; the lidar stops streaming
  RESET: 0x40, // no answer; it reboots and prints a short text banner
  SCAN: 0x20,
  FORCE_SCAN: 0x21,
  GET_INFO: 0x50,
  GET_HEALTH: 0x52,
  GET_SAMPLERATE: 0x59,
};

export const TYPE = { INFO: 0x04, HEALTH: 0x06, SAMPLERATE: 0x15, SCAN: 0x81 };
export const LENGTH = { INFO: 20, HEALTH: 3, SAMPLERATE: 4, SCAN: 5 };

export const HEALTH = ['Good', 'Warning', 'Error'];

export function command(cmd) {
  return new Uint8Array([SYNC1, cmd]);
}

// The 7-byte answer descriptor that starts at b[i].
export function descriptor(type, length, multiple = false) {
  const v = (length & 0x3fffffff) | ((multiple ? 1 : 0) << 30);
  return new Uint8Array([SYNC1, SYNC2, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff, type]);
}

export function parseDescriptor(b, i = 0) {
  if (b[i] !== SYNC1 || b[i + 1] !== SYNC2) return null;
  const v = (b[i + 2] | (b[i + 3] << 8) | (b[i + 4] << 16) | (b[i + 5] << 24)) >>> 0;
  return { length: v & 0x3fffffff, multiple: (v >>> 30) === 1, type: b[i + 6] };
}

// One measurement: quality (6 bits) and the start-of-revolution flag S with its inverse,
// the angle in 1/64 degree with a check bit that is always 1, and the distance in 1/4 mm.
// Returns null when the check bits are wrong, which means the stream is out of step.
export function decodeNode(b, i = 0) {
  const b0 = b[i];
  const b1 = b[i + 1];
  const s = b0 & 1;
  if (s === ((b0 >> 1) & 1)) return null;
  if ((b1 & 1) !== 1) return null;
  const q6 = (b1 >> 1) | (b[i + 2] << 7);
  const q2 = b[i + 3] | (b[i + 4] << 8);
  return { start: s === 1, quality: b0 >> 2, q6, q2 };
}

export function encodeNode(start, quality, q6, q2) {
  const s = start ? 1 : 0;
  return [((quality & 0x3f) << 2) | ((s ^ 1) << 1) | s, ((q6 & 0x7f) << 1) | 1, (q6 >> 7) & 0xff, q2 & 0xff, (q2 >> 8) & 0xff];
}

// A-series model bytes read as A<major>M<minor>: 0x18 is an A1M8.
export function modelName(model) {
  const major = model >> 4;
  const minor = model & 0x0f;
  if (major >= 1 && major <= 3) return `RPLIDAR A${major}M${minor}`;
  return `RPLIDAR, model 0x${model.toString(16).padStart(2, '0').toUpperCase()}`;
}

export function parseInfo(d) {
  const serial = Array.from(d.slice(4, 20), x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return {
    model: d[0],
    name: modelName(d[0]),
    firmware: `${d[2]}.${String(d[1]).padStart(2, '0')}`,
    hardware: d[3],
    serial,
  };
}

export function parseHealth(d) {
  return { status: d[0], text: HEALTH[d[0]] || `Unknown (${d[0]})`, error: d[1] | (d[2] << 8) };
}

export function parseSampleRate(d) {
  const standard = d[0] | (d[1] << 8);
  const express = d[2] | (d[3] << 8);
  return { standardUs: standard, expressUs: express, standard: standard ? Math.round(1e6 / standard) : 0 };
}

// In a scan, each measurement's angle follows the last one's by about a degree. A measurement read from misaligned
// bytes passes the two check bits one time in four, but lands at a random angle, so the angle has to follow on too:
// up to 10 degrees on, or 2 back (the A1's reported angle jitters).
const AHEAD = 10 * 64;
const BACK = 2 * 64;
function follows(prev, q6) {
  const d = (q6 - prev + 23040) % 23040;
  return d <= AHEAD || d >= 23040 - BACK;
}

// A streaming parser. The transport hands it bytes in whatever chunks they arrive in; it finds descriptors,
// collects single answers, and in scan mode turns the stream into measurements, finding its step again if a byte
// is lost.
export class Parser {
  constructor() {
    this.buf = new Uint8Array(1 << 15);
    this.len = 0;
    this.mode = 'idle';
    this.want = null; // { type, length, resolve, reject }
    this.onNodes = null; // (nodes[]) => void, in scan mode
    this.dropped = 0; // bytes skipped to get back in step
    this.nodes = 0;
  }

  // Throw away everything buffered and stop waiting.
  reset(reason = 'reset') {
    this.len = 0;
    this.mode = 'idle';
    if (this.want) this.want.reject(new Error(reason));
    this.want = null;
  }

  // Wait for one answer of this type. Resolves with its data bytes (or, for a scan, once streaming starts).
  expect(type, length) {
    if (this.want) this.want.reject(new Error('superseded'));
    this.len = 0;
    this.mode = 'descriptor';
    return new Promise((resolve, reject) => { this.want = { type, length, resolve, reject }; });
  }

  push(bytes) {
    if (this.mode === 'idle') return; // banners, stale answers: nobody asked
    if (this.len + bytes.length > this.buf.length) {
      const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.len + bytes.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    this.process();
  }

  process() {
    let i = 0;
    const b = this.buf;
    for (;;) {
      if (this.mode === 'descriptor') {
        while (i + 1 < this.len && !(b[i] === SYNC1 && b[i + 1] === SYNC2)) i++;
        if (i + 7 > this.len) break;
        const d = parseDescriptor(b, i);
        if (d.type !== this.want.type || d.length !== this.want.length) { i += 2; continue; }
        i += 7;
        if (d.multiple) {
          this.mode = 'scan';
          const want = this.want;
          this.want = null;
          want.resolve(null);
        } else {
          this.mode = 'data';
        }
      } else if (this.mode === 'data') {
        if (i + this.want.length > this.len) break;
        const data = b.slice(i, i + this.want.length);
        i += this.want.length;
        const want = this.want;
        this.want = null;
        this.mode = 'idle';
        want.resolve(data);
        i = this.len; // anything after a single answer is nothing we asked for
        break;
      } else if (this.mode === 'scan') {
        const out = [];
        // A measurement counts only when the next one also passes its checks and its angle follows on. That also
        // drops the one measurement whose distance a lost byte would have spoiled (its angle still looks right).
        while (i + 10 <= this.len) {
          const n = decodeNode(b, i);
          const next = n && decodeNode(b, i + 5);
          if (next && follows(n.q6, next.q6)) {
            out.push(n);
            i += 5;
          } else {
            this.dropped++;
            i++;
          }
        }
        if (out.length) {
          this.nodes += out.length;
          if (this.onNodes) this.onNodes(out);
        }
        break;
      } else {
        i = this.len;
        break;
      }
    }
    if (i >= this.len) this.len = 0;
    else if (i > 0) {
      this.buf.copyWithin(0, i, this.len);
      this.len -= i;
    }
  }
}
