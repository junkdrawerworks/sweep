// Uses Sweep in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// The sample room, then a lidar on WebUSB and one on Web Serial (stand-ins for the hardware from test/unit/fakes.mjs,
// with the simulated lidar behind them), then the house kit's checks: no errors, nothing leaves the site, nothing
// scrolls sideways, offline, a stalled connection, a new release, and the service worker's FILES.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it). With `release` set it serves the next release (see the end).
let net = 'up', release = false;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const base = `http://localhost:${server.address().port}/`;
// Waits for ok() to come true, for up to ms, or fails saying what didn't happen.
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await new Promise(r => setTimeout(r, 100)); }
};
let checks = 0;
const check = (ok, what) => { assert.ok(ok, what); checks++; };

// "15′ 0″ × 19′ 0″" -> [180, 228] inches; "4.57 m × 5.79 m" -> [4.57, 5.79]
const inches = s => s.split('×').map(p => { const m = p.match(/(\d+)′\s*(\d+)″/); return m ? +m[1] * 12 + +m[2] : NaN; });
const metres = s => s.split('×').map(p => parseFloat(p));

const browser = await pw.chromium.launch();
const seedRandom = seed => {
  let a = seed; // mulberry32, so the sample room comes out the same every run
  Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
};

function watch(page, problems) {
  page.on('pageerror', e => problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('requestfailed', r => problems.push('failed: ' + r.url()));
  page.on('request', r => { if (!r.url().startsWith(base) && !/^(blob|data):/.test(r.url())) problems.push('left the site: ' + r.url()); });
}

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
await ctx.addInitScript(seedRandom, 7);
const page = await ctx.newPage();
const problems = [];
watch(page, problems);
const text = sel => page.locator(sel).innerText();
const screen = () => page.evaluate(() => document.body.dataset.screen);
const toast = () => page.locator('#toast').textContent();
// The toast keeps its last words after it fades, so wait for the new ones.
const toastSays = (want, what) => until(async () => { const t = await toast(); return typeof want === 'string' ? t === want : want.test(t); }, 3000, what).then(() => checks++);

await page.goto(base);
await page.evaluate(() => document.fonts.ready);

// ---------- home ----------
check(await page.title() === 'Sweep', 'title');
await until(() => page.locator('#hero-plan svg').count().then(n => n === 1), 3000, 'the home screen should draw a sample plan');
check((await text('#support')).length > 20, 'the home screen says how to connect');
check(await page.locator('#rooms-empty').isVisible(), 'no rooms yet');

// Installable: Chrome finds a manifest with no errors, and nothing that stops it installing.
const cdp = await ctx.newCDPSession(page);
const manifest = await cdp.send('Page.getAppManifest');
check(manifest.errors.length === 0 && JSON.parse(manifest.data).name === 'Sweep', `manifest: ${JSON.stringify(manifest.errors)}`);
await until(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.length === 0, 8000,
  'Chrome would not install it: ' + JSON.stringify((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors));
checks++;

// Settings: no countdown, two-second looks, feet.
await page.click('#open-settings');
await page.selectOption('#set-countdown', '0');
await page.selectOption('#set-seconds', '2');
await page.check('input[name="units"][value="ft"]');
await page.click('#settings button[value="close"]');
check(!(await page.locator('#settings').evaluate(d => d.open)), 'settings close');

// ---------- the sample room: live view ----------
await page.click('#demo');
check(await screen() === 'scan', 'Try a sample room opens the live view');
check(await page.locator('#demo-badge').isVisible(), 'the live view says it is simulated');
await until(async () => (await text('#device-name')) === 'RPLIDAR A1M8', 3000, 'the lidar should report its model');
await until(async () => { const v = parseFloat(await text('#spin')); return v > 5 && v < 7.5; }, 4000, 'turns a second should settle between 5 and 7.5');
await until(async () => { const v = parseFloat((await text('#sps')).replace(',', '')); return v > 1700 && v < 2300; }, 4000, 'about 2,000 points a second');
check((await text('#health')) === 'Good', 'health reads Good');
await page.click('#device summary');
const details = await page.locator('#device-list').evaluate(dl => Object.fromEntries([...dl.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])));
check(details.Model === 'RPLIDAR A1M8' && details.Firmware === '1.29' && details.Hardware === '7' && details.Health === 'Good', `lidar details: ${JSON.stringify(details)}`);
check(details['Standard scan'] === '2,000 samples a second' && details.Connection === 'Simulated lidar', 'scan rate and connection');
check(await page.evaluate(() => { const c = document.getElementById('radar'); return c.width > 300 && c.height > 300; }), 'the live view is drawn');
check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the live view fits a phone');

// The motor stops and starts.
await page.click('#motor');
check((await text('#motor')) === 'Start the motor', 'motor button flips');
await until(async () => (await text('#spin')) === 'Stopped', 4000, 'turns a second should read Stopped');
await until(() => page.locator('#motor-note').isVisible(), 4000, 'a note after stopping the motor');
check((await text('#motor-note')) === 'Motor stopped. Capture starts it again.', 'motor note');
await page.click('#motor');
await until(async () => parseFloat(await text('#spin')) > 5, 4000, 'the motor should spin up again');

// ---------- capture ----------
await page.click('#capture');
await until(async () => (await screen()) === 'plan', 8000, 'a capture should end on the plan');
let size = inches(await text('#size'));
check(Math.abs(size[0] - 180) <= 1 && Math.abs(size[1] - 228) <= 1, `the living room is 15′ 0″ × 19′ 0″, got ${await text('#size')}`);
check(Math.abs(parseInt(await text('#area')) - 285) <= 2, `about 285 sq ft, got ${await text('#area')}`);
check((await text('#looks')).startsWith('1 look, '), 'one look');
check(await page.locator('#notice').isVisible() && /blocked \d+° of its view, probably you/.test(await text('#notice')), 'the simulated person blocks part of the view');
check(await page.locator('#walls li').count() === 4, 'four walls');
check(await page.locator('#plan-svg svg text[data-run]').count() === 4, 'four wall labels on the drawing');
check(await page.locator('#second').isVisible(), 'Second look is offered');
check((await text('#plan-back')) === 'Lidar', 'the back button goes to the lidar');
check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the plan fits a phone');

// A second look from the other side adds to the same room.
await page.click('#second');
await until(async () => (await screen()) === 'plan' && (await text('#looks')).startsWith('2 looks, '), 9000, 'a second look should add to the plan');
size = inches(await text('#size'));
check(Math.abs(size[0] - 180) <= 1 && Math.abs(size[1] - 228) <= 1, `still 15′ 0″ × 19′ 0″, got ${await text('#size')}`);

// Leaving an unsaved room asks first.
await page.click('#plan-back');
await toastSays('This room isn’t saved. Tap Lidar again to leave it.', 'unsaved room warning');
check(await screen() === 'plan', 'still on the plan after the warning');

// Save and rename.
await page.click('#save');
check((await text('#save')) === 'Saved' && await page.locator('#save').isDisabled(), 'Save room becomes Saved');
await toastSays('Saved Living room (sample).', 'saved toast');
check(await page.locator('#delete').isVisible(), 'a saved room can be deleted');
await page.fill('#room-name', 'Front room');
await page.locator('#room-name').press('Enter');
await page.locator('#room-name').blur();

// Back to the lidar, then home: the room is listed.
await page.click('#plan-back');
check(await screen() === 'scan', 'back to the live view');
await page.click('#scan .back');
check(await screen() === 'home', 'home');
check((await text('#connect')) === 'Back to the lidar', 'the lidar is still running');
check(await page.locator('#room-list li').count() === 1, 'one saved room');
check((await text('#room-list .room-name')) === 'Front room', 'renamed');
check(/^15′ 0″ × 19′ 0″, 28\d sq ft$/.test(await text('#room-list .room-meta')), `room summary: ${await text('#room-list .room-meta')}`);

// ---------- a saved room ----------
await page.click('#room-list a');
check(await screen() === 'plan' && (await text('#plan-back')) === 'Rooms', 'a saved room opens with Rooms as its back button');
check(!(await page.locator('#second').isVisible()), 'no second look for a room from the list');

// Exports.
const saveAs = async which => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-export="${which}"]`)]);
  return { name: dl.suggestedFilename(), body: await readFile(await dl.path()) };
};
const png = await saveAs('png');
check(png.name === 'front-room.png', `png name ${png.name}`);
check(png.body.subarray(1, 4).toString() === 'PNG' && png.body.readUInt32BE(16) === 1600 && png.body.readUInt32BE(20) === 1200, 'a 1600 x 1200 PNG');
const svg = await saveAs('svg');
const svgText = svg.body.toString();
check(svg.name === 'front-room.svg' && svgText.startsWith('<svg') && svgText.includes('Front room') && svgText.includes('Measured with Sweep') && svgText.includes('@font-face'), 'the drawing has its title, date line and font');
const cad = await saveAs('dxf');
check(cad.name === 'front-room.dxf' && cad.body.toString().startsWith('0\r\nSECTION\r\n2\r\nHEADER') && cad.body.toString().includes('OUTLINE'), 'a DXF');

// Metres.
await page.click('#open-settings');
await page.check('input[name="units"][value="m"]');
await page.click('#settings button[value="close"]');
const m = metres(await text('#size'));
check(Math.abs(m[0] - 4.57) <= 0.011 && Math.abs(m[1] - 5.79) <= 0.011, `4.57 m × 5.79 m, got ${await text('#size')}`);
check(/^\d+\.\d m²$/.test(await text('#area')), 'area in square metres');
await page.click('#open-settings');
await page.check('input[name="units"][value="ft"]');
await page.click('#settings button[value="close"]');

// Check a wall against a tape measure: 4 inches longer than Sweep's figure.
await page.click('#walls li:first-child button');
check(await page.locator('#calibrate').evaluate(d => d.open), 'tapping a wall opens Check a wall');
const measured = inches(await text('#cal-measured'))[0];
const tape = measured + 4;
await page.fill('#cal-tape', `${Math.floor(tape / 12)}' ${tape % 12}"`);
const pct = ((tape / measured - 1) * 100).toFixed(1);
check((await text('#cal-result')).startsWith(`Sweep reads ${pct}% short.`), `calibration says ${pct}% short: ${await text('#cal-result')}`);
await page.click('#cal-apply');
await toastSays(/^Distance correction set: \+\d\.\d%\.$/, 'correction toast');
const corrected = inches(await text('#size'));
check(Math.abs(corrected[0] - tape) <= 1, `wall 1 now reads the tape's length: ${await text('#size')}`);
await page.click('#open-settings');
check(/^\+\d\.\d%$/.test(await text('#set-correction')), 'settings show the correction');
await page.click('#reset-correction');
check((await text('#set-correction')) === 'None', 'correction removed');
await page.click('#settings button[value="close"]');
check(Math.abs(inches(await text('#size'))[0] - 180) <= 1, 'back to 15′ 0″');

// Back up, delete, restore.
await page.click('#open-settings');
const [bdl] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
const backupFile = await bdl.path();
const backupDoc = JSON.parse(await readFile(backupFile, 'utf8'));
check(/^sweep-backup-\d{4}-\d{2}-\d{2}\.json$/.test(bdl.suggestedFilename()) && backupDoc.rooms.length === 1 && backupDoc.rooms[0].name === 'Front room', 'backup holds the room');
await page.click('#settings button[value="close"]');
await page.click('#delete');
check((await text('#delete')) === 'Tap again to delete', 'delete asks twice');
await page.click('#delete');
check(await screen() === 'home' && await page.locator('#rooms-empty').isVisible(), 'deleted');
await page.click('#open-settings');
await page.setInputFiles('#restore', backupFile);
await toastSays('Restored 1 room.', 'restore toast');
await page.click('#settings button[value="close"]');
check(await page.locator('#room-list li').count() === 1 && (await text('#room-list .room-name')) === 'Front room', 'restored');

// Disconnect.
await page.click('#connect');
check(await screen() === 'scan', 'Back to the lidar');
await page.click('#disconnect');
await until(async () => (await screen()) === 'home' && (await text('#connect')) === 'Connect lidar', 3000, 'disconnected');

// Settings survive a reload.
await page.reload();
await page.click('#open-settings');
check(await page.inputValue('#set-countdown') === '0' && await page.inputValue('#set-seconds') === '2', 'settings kept');
await page.click('#settings button[value="close"]');

// ---------- a lidar on WebUSB and on Web Serial ----------
// The app talks to these exactly as it would to the hardware; only navigator.usb and navigator.serial are stand-ins.
for (const method of ['usb', 'serial']) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await c.addInitScript(m => {
    localStorage.setItem('sweep.v1.settings', JSON.stringify({ method: m, countdown: 0, seconds: 2, units: 'ft' }));
    const ready = import('/test/unit/fakes.mjs').then(f => {
      if (m === 'usb') { const dev = new f.FakeCp2102(); window.fakeDevice = dev; return f.fakeUsb(dev); }
      const port = new f.FakeSerialPort();
      window.fakeDevice = port;
      return { getPorts: async () => [], requestPort: async () => port };
    });
    const proxy = new Proxy({}, { get: (t, k) => (...a) => ready.then(x => x[k](...a)) });
    Object.defineProperty(navigator, m, { configurable: true, value: proxy });
  }, method);
  const p = await c.newPage();
  const probs = [];
  watch(p, probs);
  await p.goto(base);
  await p.click('#connect');
  await until(async () => (await p.locator('#device-name').innerText()) === 'RPLIDAR A1M8', 5000, `${method}: the lidar should connect`);
  await until(async () => parseFloat(await p.locator('#spin').innerText()) > 5, 5000, `${method}: the lidar should spin`);
  await p.click('#device summary');
  const conn = await p.locator('#device-list').evaluate(dl => [...dl.querySelectorAll('dt')].find(dt => dt.textContent === 'Connection').nextElementSibling.textContent);
  check(conn === (method === 'usb' ? 'USB, CP2102 driven by Sweep' : 'USB serial, CP2102'), `${method}: connection reads ${conn}`);
  if (method === 'usb') {
    const reqs = await p.evaluate(() => window.fakeDevice.requests.map(r => r.request));
    check(JSON.stringify(reqs.slice(0, 6)) === JSON.stringify([0x00, 0x1e, 0x03, 0x07, 0x13, 0x12]), `usb: CP2102 setup ${reqs}`);
  }
  await p.click('#motor');
  if (method === 'usb') check(await p.evaluate(() => window.fakeDevice.dtr) === true, 'usb: Stop the motor sets DTR');
  else check(await p.evaluate(() => window.fakeDevice.signals.at(-1).dataTerminalReady) === true, 'serial: Stop the motor sets DTR');
  await p.click('#capture'); // starts the motor again, then looks
  await until(async () => (await p.evaluate(() => document.body.dataset.screen)) === 'plan', 9000, `${method}: capture should end on the plan`);
  const s = inches(await p.locator('#size').innerText());
  check(Math.abs(s[0] - 180) <= 1 && Math.abs(s[1] - 228) <= 1, `${method}: 15′ 0″ × 19′ 0″, got ${await p.locator('#size').innerText()}`);
  await p.click('#plan-back');
  await p.click('#plan-back');
  await p.click('#disconnect');
  if (method === 'usb') { await until(() => p.evaluate(() => window.fakeDevice.requests.at(-1).request === 0x00 && window.fakeDevice.requests.at(-1).value === 0), 3000, 'usb: Disconnect turns the CP2102 interface off'); checks++; }
  check(probs.length === 0, `${method}: problems ${probs}`);
  await c.close();
}

// ---------- the house kit's checks ----------
// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

// Works offline once it has been opened. The server goes down as well as the browser: in some Chromium builds the
// browser's offline switch alone doesn't stop the service worker's own requests, and this passed with no copy at all.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
const title = await page.title();
net = 'down';
await ctx.setOffline(true);
await page.reload();
assert.equal(await page.title(), title, 'the page did not open offline');
// And the sample room works offline.
await page.click('#demo');
await until(async () => (await page.locator('#device-name').innerText()) === 'RPLIDAR A1M8', 3000, 'the sample room should run offline');
await page.click('#disconnect');
await ctx.setOffline(false);

// On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
// the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
net = 'stalled';
const t0 = Date.now();
await page.reload({ timeout: 10000 }).catch(() => {});
const took = Date.now() - t0;
assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
net = 'up';
for (const [req, res] of held.splice(0)) serve(req, res);

// A new release: every file in the new copy comes from the server, though the browser still has its own copies of
// the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
release = true;
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await until(() => page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
  10000, "the new release's offline copy kept the old index.html");
release = false;

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while using it');
await browser.close();
server.close();

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const all = createHash('sha1');
for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
console.log(`all good: ${checks} checks in the browser, then offline, a stalled connection, a new release and FILES`);
