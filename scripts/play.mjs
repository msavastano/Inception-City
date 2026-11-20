// The play bench: Dream Walk in real time, from where it starts, at the quality the game picks for itself.
//
//   npm run build
//   node scripts/play.mjs --gpu --channel msedge                      on a machine with a graphics card
//   node scripts/play.mjs --dist dist-main --out play-main ...        the same walk on another build
//
// The screenshot bench (bench.mjs) poses the camera, stops the clock and forces a quality tier, which is
// right for judging a look but is not how anyone plays. This opens the game with no tier in the link (so
// automatic quality is on, as it is for a player), clicks Dream Walk, and walks a fixed route from the start
// (north into the Circus, round it and out along a street) at a real frame rate, holding W, and Shift on
// some legs. Every second it records the frame rate, the tier automatic quality has chosen, the draw calls
// and triangles of the last frame, how many pieces of the street life kit are drawn and where the dreamer is;
// every few seconds it takes a screenshot. It writes play.json and the shots into --out (default play/).
//
// --seconds scales the route (default 60 s in all). Pointer lock is refused, as in the bench, so the run
// never takes the real mouse. Needs Playwright, like the bench.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 4242;

/** The route: each leg turns the dreamer to a heading (radians, 0 is +z, the way Dream Walk starts) and walks or runs for a share of the time. */
const ROUTE = [
  { note: 'from the start towards the Circus', yaw: 0, share: 0.15, run: false },
  { note: 'into the Circus, bearing right', yaw: 0.7, share: 0.12, run: false },
  { note: 'round the Circus', yaw: 1.9, share: 0.13, run: true },
  { note: 'on round it', yaw: 3.3, share: 0.12, run: true },
  { note: 'out down a street', yaw: Math.PI, share: 0.16, run: true },
  { note: 'along the cross street', yaw: Math.PI / 2, share: 0.16, run: false },
  { note: 'turned round, looking back', yaw: -Math.PI / 2, share: 0.16, run: false },
];

function args() {
  const a = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? a[i + 1] : fallback;
  };
  return {
    out: resolve(get('out', join(root, 'play'))),
    dist: resolve(get('dist', join(root, 'dist'))),
    size: get('size', '1280x720').split('x').map(Number),
    seconds: Math.max(10, Number(get('seconds', '60')) || 60),
    shots: Math.max(1, Number(get('shots', '6')) || 6),
    hash: get('hash', ''),
    gpu: a.includes('--gpu'),
    channel: get('channel', ''),
  };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.opus': 'audio/ogg' };

function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(dir, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

/** Runs in the page, once a second: what the frame looks like now. */
function sample() {
  const d = window.dream;
  const info = d.renderer.info;
  const kit = d.streamer.kit?.drawn?.();
  const sum = (a) => (a ? a.reduce((s, n) => s + n, 0) : null);
  return {
    t: Math.round(performance.now()) / 1000,
    fps: d.fps,
    quality: d.quality,
    auto: d.autoQuality,
    calls: info.render.calls,
    triangles: info.render.triangles,
    kitNear: sum(kit?.near),
    kitFar: sum(kit?.far),
    // the cars, near and far versions (ids 12 to 14), when the build has the kit
    cars: kit ? kit.near.slice(12).reduce((s, n) => s + n, 0) + kit.far.slice(12).reduce((s, n) => s + n, 0) : null,
    x: Math.round(d.walk.x * 10) / 10,
    z: Math.round(d.walk.z * 10) / 10,
  };
}

async function main() {
  const o = args();
  if (!existsSync(join(o.dist, 'index.html'))) {
    console.error(`No build in ${o.dist}. Run "npm run build" first.`);
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('The play bench needs Playwright: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  const server = await serve(o.dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({
    ...(o.channel ? { channel: o.channel } : {}),
    args: o.gpu ? ['--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl'] : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  mkdirSync(o.out, { recursive: true });
  const context = await browser.newContext({ viewport: { width: o.size[0], height: o.size[1] }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const log = [];
  page.on('pageerror', (e) => log.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text().slice(0, 400)}`);
  });
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {}
    // never take the mouse (see bench.mjs)
    Element.prototype.requestPointerLock = function () {
      return Promise.reject(new Error('the play bench does not lock the pointer'));
    };
  });
  await page.goto(`${base}#s=${SEED}${o.hash ? `&${o.hash}` : ''}`);
  await page.waitForFunction(() => window.dream, null, { timeout: 120000 });
  const cdp = await context.newCDPSession(page);
  const shoot = async (name) => {
    // (page.screenshot waits for web fonts, which a headless browser may never report as loaded)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    writeFileSync(join(o.out, name), Buffer.from(data, 'base64'));
  };
  // a few seconds on the title screen, as a player would have, then into Dream Walk the way a player goes in
  await page.waitForTimeout(4000);
  const rows = [];
  rows.push({ leg: 'title', ...(await page.evaluate(sample)) });
  // (the button's own handler, as a click runs it; a headless page can be too busy drawing to pass Playwright's checks on it)
  await page.evaluate(() => document.getElementById('go-walk').click());
  await page.waitForTimeout(1500);
  await shoot('start.jpg');
  rows.push({ leg: 'start', ...(await page.evaluate(sample)) });
  await page.keyboard.down('KeyW');
  const every = (o.seconds * 1000) / o.shots;
  let nextShot = every;
  let elapsed = 0;
  let shot = 0;
  for (const leg of ROUTE) {
    await page.evaluate((yaw) => {
      const w = window.dream.walk;
      w.yaw = yaw;
      w.bodyYaw = yaw;
      w.pitch = 0.05;
    }, leg.yaw);
    if (leg.run) await page.keyboard.down('ShiftLeft');
    const end = elapsed + leg.share * o.seconds * 1000;
    while (elapsed < end) {
      await page.waitForTimeout(1000);
      elapsed += 1000;
      rows.push({ leg: leg.note, ...(await page.evaluate(sample)) });
      if (elapsed >= nextShot) {
        nextShot += every;
        await shoot(`walk-${++shot}.jpg`);
      }
    }
    if (leg.run) await page.keyboard.up('ShiftLeft');
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1500);
  await shoot('end.jpg');
  rows.push({ leg: 'end', ...(await page.evaluate(sample)) });
  const gl = await page.evaluate(() => {
    const g = window.dream.renderer.getContext();
    const i = g.getExtension('WEBGL_debug_renderer_info');
    return i ? String(g.getParameter(i.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  await browser.close();
  server.close();

  const walking = rows.filter((r) => !['title', 'start', 'end'].includes(r.leg));
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  const tiers = {};
  for (const r of walking) tiers[r.quality] = (tiers[r.quality] ?? 0) + 1;
  const summary = {
    renderer: gl,
    seconds: walking.length,
    fps: { median: median(walking.map((r) => r.fps)), min: Math.min(...walking.map((r) => r.fps)) },
    tiers,
    calls: median(walking.map((r) => r.calls)),
    triangles: median(walking.map((r) => r.triangles)),
    kit: walking[0]?.kitNear === null ? null : { near: median(walking.map((r) => r.kitNear)), far: median(walking.map((r) => r.kitFar)), cars: median(walking.map((r) => r.cars)) },
  };
  writeFileSync(join(o.out, 'play.json'), JSON.stringify({ seed: SEED, size: o.size, summary, rows, log }, null, 2));
  for (const r of rows) {
    console.log(
      `${String(r.t.toFixed(0)).padStart(4)} s  ${r.leg.padEnd(34)} ${String(r.fps).padStart(3)} fps  ${r.quality.padEnd(6)} ${String(r.calls).padStart(3)} calls ${String(Math.round(r.triangles / 1000)).padStart(5)}k tris` +
        `${r.kitNear === null ? '' : `  kit ${r.kitNear} near, ${r.kitFar} far, ${r.cars} cars`}  at ${r.x}, ${r.z}`,
    );
  }
  console.log(`\n${JSON.stringify(summary)}`);
  if (log.length) console.log(`\n${log.length} console lines (in play.json); the first: ${log[0]}`);
  console.log(`\nShots and play.json in ${o.out}, drawn by ${gl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
