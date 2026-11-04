// Renders the README screenshots (docs/*.png) and the link preview (og.png):  node tools/screenshots.mjs
// Math.random is seeded, so the sample rooms come out nearly the same every time (the simulated lidar runs in real
// time, so a look can catch a turn more or less).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
const SEED = 4; // change it until the pictures look good
const browser = await pw.chromium.launch();
await mkdir(join(root, 'docs'), { recursive: true });

async function open(viewport, deviceScaleFactor) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: true, serviceWorkers: 'block', colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.addInitScript(seed => {
    let a = seed; // mulberry32
    Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    if (!localStorage.getItem('sweep.v1.settings')) localStorage.setItem('sweep.v1.settings', JSON.stringify({ units: 'ft', countdown: 0, seconds: 2 }));
  }, SEED);
  await page.goto(base);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const until = async (page, fn, ms = 10000) => page.waitForFunction(fn, null, { timeout: ms });
const screen = id => `document.body.dataset.screen === '${id}'`;

// Starts the sample room `i` (0 living room, 1 kitchen, 2 bedroom) from the home screen and waits for it to spin.
async function sample(page, i) {
  await page.evaluate(n => { window.sweep.state.sample = n; }, i);
  await page.click('#demo');
  await until(page, () => { const s = window.sweep.state; return s.lidar && s.lidar.scanning && s.revs && s.revs.hz > 5; });
}

// Two looks, as you would take them, then a name. Leaves the plan screen up.
async function measure(page, name) {
  await page.click('#capture');
  await until(page, screen('plan'));
  await page.click('#second');
  await until(page, () => document.body.dataset.screen === 'plan' && document.getElementById('looks').textContent.startsWith('2 looks'));
  await page.fill('#room-name', name);
  await page.locator('#room-name').dispatchEvent('change');
}

async function home(page) {
  await page.click('#plan-back');
  if (await page.evaluate(() => document.body.dataset.screen === 'plan')) await page.click('#plan-back');
  if (await page.evaluate(() => document.body.dataset.screen === 'scan')) await page.click('#scan .back');
  await until(page, screen('home'));
}

// Phone screenshots for the README: the live view, a plan, and the list of rooms.
let planSvgForCard, sizeText, areaText;
{
  const page = await open({ width: 390, height: 844 }, 2);
  await sample(page, 1);
  await page.waitForTimeout(1600); // a few turns on the live view
  await page.screenshot({ path: join(root, 'docs/phone-live.png') });
  await measure(page, 'Kitchen');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(root, 'docs/phone-plan.png') });
  // The card's drawing: the same plan, drawn by the app's own renderer in the card's colours.
  ({ planSvgForCard, sizeText, areaText } = await page.evaluate(async () => {
    const { planSvg } = await import('./js/render.js');
    const colors = { paper: '#f3f6f4', room: '#e9eeeb', wall: '#1e2638', soft: '#5b6577', mark: '#c8261b', object: '#dfe5e2', points: '#8a93a3', tape: '#f5c400', tapeInk: '#15130a' };
    return {
      planSvgForCard: planSvg(window.sweep.state.plan, { width: 560, height: 500, units: 'ft', colors, fontSize: 19 }),
      sizeText: document.getElementById('size').textContent,
      areaText: document.getElementById('area').textContent,
    };
  }));
  await page.click('#save');
  await home(page);
  await sample(page, 0);
  await measure(page, 'Living room');
  await page.click('#save');
  await home(page);
  await sample(page, 2);
  await measure(page, 'Bedroom');
  await page.click('#save');
  await home(page);
  await page.click('#connect'); // back to the lidar, to disconnect it
  await page.click('#disconnect');
  await until(page, screen('home'));
  await page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'), null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.rooms').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(root, 'docs/phone-rooms.png') });
  await page.context().close();
}

// Link preview, 1200 x 630: a card with the name and one line on the left, the app's real plan on the right.
{
  const page = await open({ width: 1200, height: 630 }, 1);
  const font = async (file, family, weight) => `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${(await readFile(join(root, 'fonts', file))).toString('base64')}) format('woff2')}`;
  const fonts = (await font('barlow-500.woff2', 'Barlow', 500)) + (await font('barlow-semi-condensed-600.woff2', 'Barlow Semi Condensed', 600)) + (await font('barlow-semi-condensed-700.woff2', 'Barlow Semi Condensed', 700));
  await page.setContent(`<!doctype html><html><head><style>${fonts}
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; overflow: hidden; color: #1e2638; font-family: 'Barlow', sans-serif;
      background: #f3f6f4 linear-gradient(#dde5e1 1px, transparent 1px) -1px -1px / 30px 30px, #f3f6f4 linear-gradient(90deg, #dde5e1 1px, transparent 1px) -1px -1px / 30px 30px; }
    .tape { height: 34px; background-color: #f5c400; box-shadow: inset 0 -1px 0 rgba(0,0,0,.18);
      background-image: repeating-linear-gradient(90deg, transparent 0 95px, rgba(200,38,27,.9) 95px 98px, transparent 98px 192px),
        repeating-linear-gradient(90deg, #15130a 0 2px, transparent 2px 96px), repeating-linear-gradient(90deg, #15130a 0 1.5px, transparent 1.5px 24px),
        repeating-linear-gradient(90deg, #15130a 0 1px, transparent 1px 12px);
      background-size: 100% 100%, 100% 22px, 100% 14px, 100% 9px; background-repeat: repeat-x; }
    .wrap { display: grid; grid-template-columns: 540px 1fr; gap: 20px; padding: 56px 60px 0 72px; align-items: center; height: 596px; }
    h1 { font: 700 150px/0.9 'Barlow Semi Condensed'; letter-spacing: -.01em; }
    p { font: 500 40px/1.2 'Barlow'; margin-top: 26px; max-width: 13em; }
    .size { display: flex; align-items: center; gap: 18px; margin-top: 40px; }
    .chip { background: #f5c400; border: 3px solid #15130a; border-radius: 10px; padding: 8px 18px 9px; font: 700 40px/1 'Barlow Semi Condensed'; font-variant-numeric: tabular-nums; }
    .area { font: 600 34px/1 'Barlow Semi Condensed'; }
    .plan { background: #fbfcfb; border: 2px solid #c9d2cf; border-radius: 12px; padding: 6px; justify-self: end; margin-bottom: 30px; }
    .plan svg { display: block; }
  </style></head><body><div class="tape"></div><div class="wrap">
    <div><h1>Sweep</h1><p>A measured floor plan from one spin of a lidar.</p>
      <div class="size"><span class="chip">${sizeText}</span><span class="area">${areaText}</span></div></div>
    <div class="plan">${planSvgForCard}</div>
  </div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(root, 'og.png') });
  await page.context().close();
}

await browser.close();
server.close();
console.log('screenshots written');
