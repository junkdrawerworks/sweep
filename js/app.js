// Sweep: connect a lidar, look at a room, get a measured floor plan.

import { Lidar } from './lidar.js';
import { SerialTransport, Cp210xTransport, SimTransport, pickMethod, isAndroid, supports } from './transports.js';
import { Revolutions, makeLook, encodeLook, decodeLook } from './capture.js';
import { makePlan } from './plan.js';
import { SimLidar, SAMPLE_ROOMS, simulateLooks } from './sim.js';
import { planSvg, drawRadar, SCREEN } from './render.js';
import { fmtLength, fmtArea, fmtSize, parseLength } from './units.js';
import { loadSettings, saveSettings, listRooms, loadRoom, saveRoom, deleteRoom, newId } from './store.js';
import { imageBlob, drawingSvg, dxf, backup, readBackup, fileName, download } from './export.js';

const $ = id => document.getElementById(id);
const settings = loadSettings();
// The one-file copy made for the Artifact viewer (npm run build): it runs the sample rooms, but a framed page can't
// reach USB devices or start downloads, so those point at the site instead.
const single = 'single' in document.documentElement.dataset;

const state = {
  lidar: null,
  demo: false,
  revs: null,
  live: [], // the last few revolutions, for the live view
  range: 4,
  capture: null, // { phase, revs, timer }
  room: null, // the room on the plan screen: { id?, name, created, looks: [decoded], straighten, device }
  saved: false,
  session: null, // the room this connection is looking at, so a second look adds to it
  planFrom: 'home', // where the plan screen's back button goes: 'scan' after a capture, 'home' for a saved room
  plan: null,
  highlight: -1,
  sample: 0,
  discardArmed: 0,
};

// ---------- small helpers ----------

let toastTimer;
function toast(text, ms = 3200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
  if (id === 'home') renderHome();
  if (id === 'scan') sizeRadar();
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let palette = null;
function radarColors() {
  if (!palette) palette = { ink: css('--ink'), soft: css('--ink-2'), mark: css('--mark'), grid: css('--rule'), paper: css('--panel'), beamFade: css('--beam-fade') };
  return palette;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { palette = null; if (state.plan) renderPlan(); renderHero(); });

const units = () => settings.units;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const store = () => { saveSettings(settings); };

// ---------- home ----------

function supportText() {
  if (single) return 'This copy runs the sample rooms. To connect a lidar, open Sweep at <a href="https://sweep.junkdrawer.works/" target="_blank" rel="noopener">sweep.junkdrawer.works</a> in Chrome.';
  const m = pickMethod(settings.method);
  if (!m) return '<strong>This browser can’t reach USB devices.</strong> Use Chrome or Edge on a computer, or Chrome on Android. The sample room works anywhere.';
  if (m === 'usb') return 'Plug the lidar’s USB adapter into this phone with a USB-C to micro-USB data cable, then tap Connect lidar.';
  return 'Plug the lidar’s USB adapter into this computer, then tap Connect lidar and pick its port (CP2102).';
}

function thumb(outline) {
  if (!outline || outline.length < 3) return '';
  const xs = outline.map(p => p[0]), ys = outline.map(p => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const s = Math.min(68 / (maxx - minx || 1), 52 / (maxy - miny || 1));
  const ox = (76 - (maxx - minx) * s) / 2, oy = (60 - (maxy - miny) * s) / 2;
  const pts = outline.map(p => `${(ox + (p[0] - minx) * s).toFixed(1)},${(oy + (maxy - p[1]) * s).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 76 60" aria-hidden="true"><polygon points="${pts}" style="fill:var(--room);stroke:var(--ink);stroke-width:2.5;stroke-linejoin:miter"/></svg>`;
}

function renderHome() {
  // A real lidar still connected keeps its place; a sample room left running doesn't stand in the way of a real one.
  const real = !!state.lidar && !state.demo;
  $('support').innerHTML = real ? 'The lidar is still connected.' : supportText();
  $('connect').disabled = !real && !pickMethod(settings.method);
  $('connect').hidden = single && !real;
  $('connect').textContent = real ? 'Back to the lidar' : 'Connect lidar';
  $('demo').textContent = state.lidar && state.demo ? 'Back to the sample room' : 'Try a sample room';
  const rooms = listRooms();
  const list = $('room-list');
  list.innerHTML = '';
  for (const r of rooms) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#room=${r.id}`;
    a.innerHTML = `<span class="thumb">${thumb(r.outline)}</span><span><span class="room-name"></span><span class="room-meta"></span></span>`;
    a.querySelector('.room-name').textContent = r.name;
    a.querySelector('.room-meta').textContent = `${fmtSize(r.w, r.h, units())}, ${fmtArea(r.area, units())}`;
    a.addEventListener('click', e => { e.preventDefault(); openRoom(r.id); });
    li.append(a);
    list.append(li);
  }
  $('rooms-empty').hidden = rooms.length > 0;
  const total = rooms.reduce((s, r) => s + (r.area || 0), 0);
  $('rooms-total').hidden = rooms.length < 2;
  $('rooms-total').textContent = `${plural(rooms.length, 'room', 'rooms')}, ${fmtArea(total, units())} in all`;
}

let heroPlan = null;
function renderHero() {
  const el = $('hero-plan');
  if (!heroPlan) {
    // a real Sweep plan of the sample living room, made by the simulator at load
    const spec = { ...SAMPLE_ROOMS[0], person: [] };
    heroPlan = makePlan(simulateLooks(spec, { seconds: 2.5, seed: 11 }));
  }
  const w = Math.max(280, Math.round(el.clientWidth || 480));
  el.innerHTML = planSvg(heroPlan, { width: w, height: Math.round(w * 0.75), units: units(), colors: { ...SCREEN, paper: 'var(--paper)', room: 'var(--paper)' } });
}

// ---------- connecting ----------

function explain(err) {
  const m = String(err && (err.message || err)) || '';
  if (/no answer|did not start/.test(m)) return 'The port opened but the lidar didn’t answer. Check the cable between the lidar and its USB adapter is pushed in, then unplug the adapter, plug it back in and try again.';
  if (/Failed to open|already open|busy|Access denied/i.test(m)) return 'Chrome couldn’t open the port. Close anything else using it (the Arduino IDE’s serial monitor, another Sweep tab), then try again.';
  if (/claim/i.test(m)) return 'Android wouldn’t hand the adapter to Chrome. Unplug it, plug it back in, and try again.';
  return `Couldn’t connect: ${m}`;
}

async function connect() {
  if (state.lidar && !state.demo) { show('scan'); return; }
  const method = pickMethod(settings.method);
  if (!method) { toast('This browser can’t reach USB devices.'); return; }
  let t;
  try {
    t = method === 'serial' ? await SerialTransport.choose() : await Cp210xTransport.choose();
  } catch (err) {
    if (err && err.name === 'NotFoundError') toast(method === 'usb' ? 'No lidar chosen. Is the adapter plugged into the phone?' : 'No port chosen.');
    else toast(explain(err), 6000);
    return;
  }
  await start(t, false);
}

function startDemo() {
  const spec = SAMPLE_ROOMS[state.sample % SAMPLE_ROOMS.length];
  state.sample++;
  const sim = new SimLidar(spec, { seed: Math.floor(Math.random() * 1e6), chunk: 48 });
  start(new SimTransport(sim), true, spec.name);
}

async function start(transport, demo, sampleName) {
  await stopLidar(true);
  state.demo = demo;
  state.sampleName = sampleName || null;
  $('device-name').textContent = 'Connecting…';
  $('capture').disabled = true;
  $('demo-badge').hidden = !demo;
  $('motor-note').hidden = true;
  show('scan');
  const lidar = new Lidar(transport);
  try {
    await lidar.open();
  } catch (err) {
    try { await lidar.close(); } catch { /* fine */ }
    show('home');
    toast(explain(err), 7000);
    return;
  }
  state.lidar = lidar;
  state.session = null;
  state.live = [];
  state.revs = new Revolutions(onRevolution);
  lidar.onNodes = nodes => state.revs.push(nodes);
  lidar.onClose = () => {
    state.lidar = null;
    cancelCapture();
    if (!demo) toast('The lidar was disconnected.');
    if (document.body.dataset.screen === 'scan') show('home');
  };
  $('device-name').textContent = lidar.info.name;
  renderDevice();
  try {
    await lidar.startScan();
  } catch (err) {
    toast(explain(err), 7000);
  }
  $('capture').disabled = false;
  loop();
}

async function stopLidar(quiet) {
  cancelCapture();
  const l = state.lidar;
  state.lidar = null;
  if (l) { l.onClose = null; try { await l.close(); } catch { /* gone */ } }
  if (l && !quiet && !state.demo) toast('Disconnected. If the lidar keeps spinning, unplug it.');
}

function onRevolution(rev) {
  state.live.push(rev);
  if (state.live.length > 5) state.live.shift();
  const c = state.capture;
  if (c && c.phase === 'look') c.revs.push(rev);
}

const canSecondLook = () => !!state.lidar && !!state.room && state.session === state.room;
const planBack = () => (state.planFrom === 'scan' && state.lidar ? 'scan' : 'home');

function spinRate() {
  const r = state.revs;
  if (!r || !r.starts.length || Date.now() - r.starts.at(-1) > 1500) return 0;
  return r.hz;
}

let raf = 0;
function loop() {
  cancelAnimationFrame(raf);
  let lastText = 0;
  const frame = now => {
    if (!state.lidar) return;
    if (document.body.dataset.screen === 'scan') {
      const c = $('radar');
      const rev = state.live.at(-1);
      if (rev) {
        const d = rev.q2.filter((x, i) => x > 0 && rev.q[i] > 0).map(x => x / 4000).sort((a, b) => a - b);
        const target = Math.max(2, Math.min(12, (d[Math.floor(d.length * 0.92)] || 4) * 1.12));
        state.range += (target - state.range) * 0.08;
      }
      drawRadar(c.getContext('2d'), c.width, c.height, {
        revs: state.live, angle: spinRate() > 0 ? state.revs.angle : NaN, range: state.range, units: units(), colors: radarColors(),
      });
      if (now - lastText > 400) {
        lastText = now;
        const hz = spinRate();
        $('spin').textContent = hz ? hz.toFixed(1) : 'Stopped';
        $('sps').textContent = hz ? Math.round(state.revs.sps).toLocaleString('en-US') : '–';
        $('health').textContent = state.lidar.health ? state.lidar.health.text : '–';
      }
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

function sizeRadar() {
  const c = $('radar');
  const r = c.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
}

function renderDevice() {
  const l = state.lidar;
  const dl = $('device-list');
  if (!l) { dl.innerHTML = ''; return; }
  const rows = [
    ['Model', l.info.name],
    ['Firmware', l.info.firmware],
    ['Hardware', String(l.info.hardware)],
    ['Serial', l.info.serial],
    ['Health', l.health ? `${l.health.text}${l.health.error ? `, code ${l.health.error}` : ''}` : '–'],
    ['Standard scan', l.rate ? `${l.rate.standard.toLocaleString('en-US')} samples a second` : 'not reported'],
    ['Connection', l.t.label],
  ];
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}

// ---------- capturing ----------

function setCaptureButton(text) { $('capture').textContent = text; }

function cancelCapture() {
  const c = state.capture;
  if (!c) return;
  clearInterval(c.timer);
  clearTimeout(c.stall);
  state.capture = null;
  $('countdown').hidden = true;
  setCaptureButton('Capture');
}

async function capture(second = false) {
  if (state.capture) { cancelCapture(); toast('Capture cancelled.'); return; }
  if (!state.lidar) return;
  if (!state.lidar.motorOn) await setMotor(true);
  if (!state.lidar.scanning) { try { await state.lidar.startScan(); } catch (err) { toast(explain(err), 6000); return; } }
  const c = { phase: 'countdown', revs: [], second };
  state.capture = c;
  setCaptureButton('Cancel');
  const overlay = $('countdown');
  let n = settings.countdown;
  const look = () => {
    c.phase = 'look';
    c.revs = [];
    c.started = Date.now();
    $('count-text').textContent = 'Looking. Stay below the beam.';
    clearTimeout(c.stall);
    c.stall = setTimeout(() => {
      if (state.capture === c && !c.revs.length) { cancelCapture(); toast('The lidar isn’t sending a scan. Is it spinning? Try Restart the lidar.', 7000); }
    }, 3000);
    c.timer = setInterval(() => {
      const t = (Date.now() - c.started) / 1000;
      $('count-num').textContent = `${Math.min(t, settings.seconds).toFixed(1)}`;
      if (t >= settings.seconds && c.revs.length >= 5) finishLook(c);
    }, 100);
  };
  overlay.hidden = false;
  if (n > 0) {
    $('count-num').textContent = String(n);
    $('count-text').textContent = second ? 'Move to the other side of the lidar, below the beam' : 'Get below the beam, or step out of the room';
    c.timer = setInterval(() => {
      n--;
      if (n > 0) $('count-num').textContent = String(n);
      else { clearInterval(c.timer); look(); }
    }, 1000);
  } else look();
}

function finishLook(c) {
  clearInterval(c.timer);
  clearTimeout(c.stall);
  state.capture = null;
  $('countdown').hidden = true;
  setCaptureButton('Capture');
  const look = makeLook(c.revs, { hz: spinRate() });
  state.lidar?.t.hint?.('captured');
  if (c.second && canSecondLook()) {
    state.room.looks.push(look);
    computePlan();
    if (state.saved) persist();
  } else {
    const n = listRooms().length + 1;
    state.room = {
      id: null, name: state.sampleName ? `${state.sampleName} (sample)` : `Room ${n}`, created: Date.now(),
      looks: [look], straighten: settings.straighten, device: { ...state.lidar?.info },
    };
    state.saved = false;
    state.session = state.room;
    computePlan();
  }
  state.planFrom = 'scan';
  show('plan');
  renderPlan();
}

// ---------- the plan ----------

function computePlan() {
  const r = state.room;
  state.plan = makePlan(r.looks, { correction: settings.correction, straighten: r.straighten !== false });
  state.highlight = -1;
}

function noticeText(plan, looks) {
  const out = [];
  if (plan.rough) out.push('Sweep couldn’t find enough straight walls, so this outline follows the points themselves. Check the lidar sits above the furniture, at about chest height.');
  if (plan.blocked.length) {
    const deg = plan.blocked.reduce((s, b) => s + b.width, 0);
    out.push(looks < 2
      ? `Something close to the lidar blocked ${deg}° of its view, probably you. Move to the other side of the lidar and tap Second look.`
      : `Something close to the lidar still blocks ${deg}° of its view. If it’s furniture, move the lidar and capture again; if not, carry on.`);
  } else if (!plan.rough && plan.seenShare < 0.6) {
    out.push('Sweep had to guess some of the walls (the dashed lines). Stand the lidar where it can see more of the room, or take a second look.');
  }
  return out;
}

function renderPlan() {
  const r = state.room, p = state.plan;
  if (!r || !p) return;
  if (document.activeElement !== $('room-name')) $('room-name').value = r.name;
  $('size').textContent = fmtSize(p.box.w, p.box.h, units());
  $('area').textContent = fmtArea(p.area, units());
  const turns = r.looks.reduce((s, l) => s + l.revs, 0);
  $('looks').textContent = `${plural(r.looks.length, 'look', 'looks')}, ${plural(turns, 'turn', 'turns')} of the lidar. Perimeter ${fmtLength(p.perimeter, units())}; ${Math.round(p.seenShare * 100)}% of it seen, the rest inferred.`;
  const notes = noticeText(p, r.looks.length);
  $('notice').hidden = !notes.length;
  $('notice').innerHTML = notes.map(t => `<p>${t}</p>`).join('');
  const box = $('plan-svg');
  const w = Math.max(280, Math.round(box.clientWidth || 360));
  box.innerHTML = planSvg(p, { width: w, height: w, units: units(), points: settings.points, highlight: state.highlight });
  // walls
  const walls = $('walls');
  walls.innerHTML = '';
  p.runs.forEach((run, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === state.highlight));
    const seen = run.len ? run.seen / run.len : 0;
    const bits = [];
    if (run.openings.length) bits.push(run.openings.length === 1 ? 'with an opening' : `with ${run.openings.length} openings`);
    if (seen < 0.5) bits.push('mostly hidden from the lidar');
    b.innerHTML = `<span><span>Wall ${i + 1}</span> <span class="sub"></span></span><span class="len"></span>`;
    b.querySelector('.sub').textContent = bits.join(', ');
    b.querySelector('.len').textContent = fmtLength(run.len, units());
    b.addEventListener('click', () => {
      state.highlight = state.highlight === i ? -1 : i;
      renderPlan();
      if (state.highlight === i) openCalibrate(i);
    });
    li.append(b);
    walls.append(li);
  });
  const ops = $('openings');
  ops.innerHTML = '';
  p.runs.forEach((run, i) => run.openings.forEach(o => {
    const li = document.createElement('li');
    li.className = 'static';
    li.innerHTML = `<span>In wall ${i + 1}</span><span class="len"></span>`;
    li.querySelector('.len').textContent = fmtLength(o.width, units());
    ops.append(li);
  }));
  $('openings-sec').hidden = !p.openings.length;
  // actions
  $('plan-back').textContent = planBack() === 'scan' ? 'Lidar' : 'Rooms';
  $('second').hidden = !canSecondLook();
  $('second').textContent = r.looks.length > 1 ? 'Another look' : 'Second look';
  $('save').textContent = state.saved ? 'Saved' : 'Save room';
  $('save').disabled = state.saved;
  $('delete').hidden = !state.saved;
  $('show-points').checked = !!settings.points;
  $('straighten').checked = r.straighten !== false;
  $('share').hidden = single || !(navigator.canShare && navigator.share);
  $('export-sec').hidden = single;
}

function summaryOf(plan) {
  const r3 = v => Math.round(v * 1000) / 1000;
  return { w: r3(plan.box.w), h: r3(plan.box.h), area: r3(plan.area), outline: plan.outline.map(p => [r3(p[0]), r3(p[1])]) };
}

function persist() {
  const r = state.room;
  if (!r.id) r.id = newId();
  r.updated = Date.now();
  const record = { id: r.id, name: r.name, created: r.created, updated: r.updated, straighten: r.straighten !== false, device: r.device, looks: r.looks.map(encodeLook) };
  try {
    saveRoom(record, summaryOf(state.plan));
    state.saved = true;
    return true;
  } catch (err) {
    toast(err.message === 'full' ? 'This browser’s storage is full. Back up your rooms in Settings, then delete some.' : 'Couldn’t save the room.', 7000);
    return false;
  }
}

function openRoom(id) {
  const rec = loadRoom(id);
  if (!rec) { toast('That room is missing.'); return; }
  try {
    state.room = { ...rec, looks: rec.looks.map(decodeLook) };
  } catch {
    toast('That room’s data is damaged.');
    return;
  }
  state.saved = true;
  state.planFrom = 'home';
  computePlan();
  show('plan');
  renderPlan();
}

// ---------- calibrating against a tape ----------

let calRun = -1;
function openCalibrate(i) {
  calRun = i;
  const run = state.plan.runs[i];
  $('cal-h').textContent = `Check wall ${i + 1}`;
  $('cal-measured').textContent = fmtLength(run.len, units());
  $('cal-tape').value = '';
  $('cal-result').textContent = '';
  $('cal-apply').disabled = true;
  $('calibrate').showModal();
  $('cal-tape').focus();
}

function calFactor() {
  const run = state.plan.runs[calRun];
  const tape = parseLength($('cal-tape').value, units());
  if (!run || !tape) return null;
  return tape / run.len;
}

$('cal-tape').addEventListener('input', () => {
  const f = calFactor();
  const out = $('cal-result');
  if (!f) { out.textContent = 'Type a length like 12\' 4" or 3.76 m.'; $('cal-apply').disabled = true; return; }
  const pct = (f - 1) * 100;
  if (Math.abs(pct) > 10) { out.textContent = 'That’s more than 10% off. Measure the same wall, corner to corner.'; $('cal-apply').disabled = true; return; }
  out.textContent = Math.abs(pct) < 0.3
    ? 'Within 0.3%: nothing to correct.'
    : `Sweep reads ${Math.abs(pct).toFixed(1)}% ${pct > 0 ? 'short' : 'long'}. Use it, and every room gets that correction.`;
  $('cal-apply').disabled = Math.abs(pct) < 0.3;
});

$('calibrate').addEventListener('close', () => {
  if ($('calibrate').returnValue !== 'apply') return;
  const f = calFactor();
  if (!f) return;
  settings.correction = Math.round(settings.correction * f * 10000) / 10000;
  store();
  computePlan();
  renderPlan();
  if (state.saved) persist();
  toast(`Distance correction set: ${correctionText()}.`);
});

function correctionText() {
  const pct = (settings.correction - 1) * 100;
  return Math.abs(pct) < 0.05 ? 'None' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

// ---------- motor ----------

async function setMotor(on) {
  if (!state.lidar) return;
  const lidar = state.lidar;
  await lidar.setMotor(on);
  $('motor').textContent = on ? 'Stop the motor' : 'Start the motor';
  if (!on) {
    setTimeout(() => {
      if (!state.lidar || state.lidar.motorOn) return;
      const note = $('motor-note');
      note.hidden = false;
      note.textContent = spinRate() > 1
        ? 'This adapter keeps the motor running whatever Sweep asks. That’s fine: Sweep works the same. Unplug the lidar to stop it.'
        : 'Motor stopped. Capture starts it again.';
    }, 2500);
    return;
  }
  $('motor-note').hidden = true;
  // An A1 can stop measuring while its motor is stopped, so once the motor has had a moment to spin up, start the
  // scan again (a fresh STOP and SCAN, which does no harm if it never stopped).
  await new Promise(r => setTimeout(r, 600));
  if (state.lidar !== lidar || !lidar.motorOn) return;
  try { await lidar.startScan(); } catch (err) { toast(explain(err), 6000); }
}

// ---------- wiring up ----------

$('connect').addEventListener('click', connect);
$('demo').addEventListener('click', () => { if (state.lidar && state.demo) show('scan'); else startDemo(); });
$('capture').addEventListener('click', () => capture(false));
$('disconnect').addEventListener('click', async () => { await stopLidar(false); show('home'); });
$('motor').addEventListener('click', () => setMotor(!state.lidar?.motorOn));
$('health-check').addEventListener('click', async () => {
  if (!state.lidar) return;
  try { await state.lidar.refreshHealth(); renderDevice(); toast(`Health: ${state.lidar.health.text}`); } catch (err) { toast(explain(err), 6000); }
});
$('reset').addEventListener('click', async () => {
  if (!state.lidar) return;
  toast('Restarting the lidar…');
  try {
    await state.lidar.reset();
    await state.lidar.setMotor(true);
    await state.lidar.refreshHealth();
    await state.lidar.startScan();
    renderDevice();
    toast('Restarted.');
  } catch (err) { toast(explain(err), 6000); }
});

for (const b of document.querySelectorAll('[data-go]')) {
  b.addEventListener('click', () => {
    const onPlan = document.body.dataset.screen === 'plan';
    const to = onPlan ? planBack() : b.dataset.go;
    if (onPlan && !state.saved && state.room) {
      if (Date.now() - state.discardArmed > 4000) {
        state.discardArmed = Date.now();
        toast(`This room isn’t saved. Tap ${b.textContent} again to leave it.`, 4000);
        return;
      }
      state.discardArmed = 0;
      state.room = null;
    }
    show(to);
  });
}

$('second').addEventListener('click', () => {
  if (!state.lidar) return;
  show('scan');
  capture(true);
});
$('save').addEventListener('click', () => {
  if (persist()) { renderPlan(); toast(`Saved ${state.room.name}.`); }
});
$('room-name').addEventListener('change', () => {
  const v = $('room-name').value.trim();
  if (!state.room) return;
  state.room.name = v || state.room.name;
  $('room-name').value = state.room.name;
  if (state.saved) persist();
});
$('show-points').addEventListener('change', e => { settings.points = e.target.checked; store(); renderPlan(); });
$('straighten').addEventListener('change', e => {
  if (!state.room) return;
  state.room.straighten = e.target.checked;
  computePlan();
  renderPlan();
  if (state.saved) persist();
});
$('delete').addEventListener('click', e => {
  const b = e.currentTarget;
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = 'Tap again to delete';
    setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Delete room'; }, 4000);
    return;
  }
  b.dataset.armed = '';
  b.textContent = 'Delete room';
  deleteRoom(state.room.id);
  toast(`Deleted ${state.room.name}.`);
  state.room = null;
  state.saved = false;
  show('home');
});

for (const b of document.querySelectorAll('[data-export]')) {
  b.addEventListener('click', async () => {
    const r = state.room, p = state.plan;
    if (!r || !p) return;
    const kind = b.dataset.export;
    try {
      if (kind === 'png') download(await imageBlob(r, p, units()), fileName(r, 'png'));
      else if (kind === 'svg') download(new Blob([await drawingSvg(r, p, units())], { type: 'image/svg+xml' }), fileName(r, 'svg'));
      else if (kind === 'dxf') download(new Blob([dxf(p)], { type: 'application/dxf' }), fileName(r, 'dxf'));
      else if (kind === 'share') {
        const file = new File([await imageBlob(r, p, units())], fileName(r, 'png'), { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: r.name, text: `${r.name}: ${fmtSize(p.box.w, p.box.h, units())}, ${fmtArea(p.area, units())}` });
        else download(file, file.name);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      toast('Couldn’t export that here. Open Sweep at sweep.junkdrawer.works to export.', 6000);
    }
  });
}

// settings
function fillSettings() {
  for (const r of document.querySelectorAll('input[name="units"]')) r.checked = r.value === settings.units;
  $('set-seconds').value = String(settings.seconds);
  $('set-countdown').value = String(settings.countdown);
  $('set-method').value = settings.method;
  $('set-correction').textContent = correctionText();
  $('reset-correction').hidden = Math.abs(settings.correction - 1) < 0.0005;
}
$('open-settings').addEventListener('click', () => { fillSettings(); $('settings').showModal(); });
for (const r of document.querySelectorAll('input[name="units"]')) {
  r.addEventListener('change', () => { settings.units = r.value; store(); refresh(); });
}
$('set-seconds').addEventListener('change', e => { settings.seconds = +e.target.value; store(); });
$('set-countdown').addEventListener('change', e => { settings.countdown = +e.target.value; store(); });
$('set-method').addEventListener('change', e => { settings.method = e.target.value; store(); refresh(); });
$('reset-correction').addEventListener('click', () => {
  settings.correction = 1;
  store();
  fillSettings();
  if (state.room) { computePlan(); if (state.saved) persist(); }
  refresh();
});
$('backup').addEventListener('click', () => {
  const rooms = listRooms().map(r => loadRoom(r.id)).filter(Boolean);
  if (!rooms.length) { toast('No saved rooms to back up yet.'); return; }
  download(new Blob([backup(rooms)], { type: 'application/json' }), `sweep-backup-${new Date().toISOString().slice(0, 10)}.json`);
});
$('restore').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const rooms = readBackup(await file.text());
    let n = 0;
    for (const rec of rooms) {
      const plan = makePlan(rec.looks.map(decodeLook), { correction: settings.correction, straighten: rec.straighten !== false });
      saveRoom(rec, summaryOf(plan));
      n++;
    }
    toast(`Restored ${plural(n, 'room', 'rooms')}.`);
    refresh();
  } catch (err) { toast(err.message || 'Couldn’t read that backup.', 6000); }
});

function refresh() {
  const s = document.body.dataset.screen;
  if (s === 'home') { renderHome(); renderHero(); }
  if (s === 'plan') renderPlan();
}

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (document.body.dataset.screen === 'scan') sizeRadar();
    refresh();
  }, 150);
});

$('backup-field').hidden = single;
show('home');
setTimeout(renderHero, 30);
if (!single && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

// for the tests and screenshots
window.sweep = { state, settings, startDemo, makePlan, capture, renderPlan };
