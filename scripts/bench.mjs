// The screenshot bench: the same seeded views at each quality tier, and what each frame costs.
//
//   npm run build
//   node scripts/bench.mjs                          eight views x low, medium, high into bench/
//   node scripts/bench.mjs --tiers medium --views street,night --out /tmp/shots
//   node scripts/bench.mjs --compare before after --out compare     side-by-side sheets from two earlier runs
//
// A look cannot be judged from a diff, so run this before and after any change to the
// lighting, the shaders or the post chain and put the two sets side by side. It needs
// Playwright (npm i -D playwright && npx playwright install chromium); it is not a
// dependency of the game. Without a GPU, Chromium falls back to a software renderer:
// the pictures are the same, the frame times are not, so the bench reports draw calls,
// triangles and memory, never milliseconds.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PI = Math.PI;
const SEED = 4242;

/**
 * The views. `level` is 1 to 4, `time` 0 (noon) to 1 (midnight), `folds` are hinge x, z, normal x, z,
 * angle, radius. A walker stands at `at` (fabric x, z, heading, pitch); an architect's camera sits at
 * `cam.pos` and looks at `cam.target`. The first eight are the standard set; `extra` views only run when
 * asked for by name or with --all.
 */
const PARIS = [[0, 192, 0, 1, PI, 110]];
const VIEWS = [
  { id: 'street', note: 'Level 1, on the sidewalk of an ordinary street', level: 1, at: [66.5, -120, 0.06, 0.05] },
  { id: 'circus', note: 'Level 1, crossing the Circus towards the monument', level: 1, at: [-9, -62, 0.12, 0.16] },
  { id: 'paris', note: 'The Paris Fold from the architect\'s desk', level: 1, folds: PARIS, cam: { pos: [0, 22, -150], target: [0, 78, 250] } },
  {
    id: 'scroll',
    note: 'Inside the Scroll, looking up at the city rolled overhead',
    level: 1,
    folds: [
      [0, 128, 0, 1, PI / 2, 60],
      [0, 448, 0, 1, PI / 2, 60],
      [0, 704, 0, 1, PI / 2, 55],
      [0, 896, 0, 1, PI / 2, 50],
    ],
    at: [10.2, -30, 0, 0.62],
  },
  { id: 'night', note: 'Level 1 at midnight, a street under the lamps', level: 1, time: 1, at: [66.5, -120, 0.06, 0.05] },
  { id: 'rain', note: 'Level 2, a boulevard at dusk in the rain', level: 2, at: [10.2, -150, 0, 0.04] },
  { id: 'snow', note: 'Level 3 from above', level: 3, cam: { pos: [330, 190, -300], target: [0, 20, 0] } },
  { id: 'limbo', note: 'Limbo, the city sinking into the sea', level: 4, cam: { pos: [-240, 120, -330], target: [120, 10, 260] } },
  { id: 'overhead', extra: true, note: 'Under the Paris Fold, looking up at its far edge', level: 1, folds: PARIS, at: [10.2, 60, 0, 0.75] },
  { id: 'night-fold', extra: true, note: 'The Paris Fold at night', level: 1, time: 1, folds: PARIS, cam: { pos: [0, 22, -150], target: [0, 78, 250] } },
  { id: 'courtyard', extra: true, note: 'Level 1, looking down into the blocks', level: 1, cam: { pos: [150, 120, -40], target: [96, 0, 60] } },
  { id: 'third', extra: true, note: 'Behind the dreamer on a street', level: 1, third: true, at: [69.5, -120, 0, 0.06] },
];

function args() {
  const a = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? a[i + 1] : fallback;
  };
  const compare = a.indexOf('--compare');
  return {
    out: resolve(get('out', join(root, 'bench'))),
    dist: resolve(get('dist', join(root, 'dist'))),
    tiers: get('tiers', 'low,medium,high').split(','),
    views: get('views', ''),
    all: a.includes('--all'),
    size: get('size', '1280x720').split('x').map(Number),
    phone: a.includes('--phone'),
    hash: get('hash', ''),
    compare: compare >= 0 ? [resolve(a[compare + 1]), resolve(a[compare + 2])] : null,
  };
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    console.error('The bench needs Playwright: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };

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

/** Runs in the page: set the view up, fast-forward until the city has streamed in, draw one frame. */
function shoot(v) {
  const d = window.dream;
  d.audio.start = () => {};
  d.start(v.at ? 'walk' : 'architect');
  d.pendingPreset = null;
  for (const f of v.folds ?? []) d.folds.add(f[0], f[1], f[2], f[3], f[4], f[5], 2.4);
  const place = () => {
    if (v.at) {
      if (v.third !== undefined && (d.walk.view === 'third') !== v.third) d.toggleView();
      d.walk.teleport(v.at[0], v.at[1], v.at[2]);
      d.walk.pitch = v.at[3];
    } else {
      d.architect.finishFlight();
      d.camera.position.set(...v.cam.pos);
      d.architect.controls.target.set(...v.cam.target);
      d.camera.lookAt(...v.cam.target);
    }
  };
  place();
  // stream the city in around the new view, let it finish growing, then hold still for the shot
  for (let i = 0; i < 4; i++) {
    d.settle();
    place();
    d.instability = 0;
    d.step(12, 0.05, false);
  }
  d.settle();
  d.instability = 0;
  d.flash = 0;
  d.step(30);
  // read the canvas back in the same task as the draw, before the browser clears it
  return { stats: d.stats(), image: document.getElementById('scene').toDataURL('image/jpeg', 0.92) };
}

async function run(o) {
  if (!existsSync(join(o.dist, 'index.html'))) {
    console.error(`No build in ${o.dist}. Run "npm run build" first.`);
    process.exit(1);
  }
  const names = o.views ? o.views.split(',') : null;
  const views = VIEWS.filter((v) => (names ? names.includes(v.id) : o.all || !v.extra));
  const { chromium } = loadPlaywright();
  const server = await serve(o.dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const launch = () => chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  let browser = await launch();
  mkdirSync(o.out, { recursive: true });
  const rows = [];
  const save = () => writeFileSync(join(o.out, 'bench.json'), JSON.stringify({ seed: SEED, size: o.size, views: views.map(({ id, note }) => ({ id, note })), rows }, null, 2));
  const shot = async (tier, v) => {
    const context = await browser.newContext({
      viewport: { width: o.size[0], height: o.size[1] },
      deviceScaleFactor: 1,
      hasTouch: o.phone,
      isMobile: o.phone,
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error(`  [${tier}/${v.id}] ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' || /shader|WebGL|GLSL/i.test(m.text())) console.error(`  [${tier}/${v.id}] ${m.text().slice(0, 600)}`);
      });
      // the same dream every run: seeded randomness and no saved settings
      await page.addInitScript(() => {
        let s = 1234567;
        Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
        try {
          localStorage.clear();
        } catch {}
      });
      const hash = `s=${SEED}&q=${tier}&l=${v.level}${v.time !== undefined ? `&t=${v.time}` : ''}${o.hash ? `&${o.hash}` : ''}`;
      await page.goto(`${base}#${hash}`);
      await page.waitForFunction(() => window.dream, null, { timeout: 120000 });
      return await page.evaluate(shoot, v);
    } finally {
      await context.close().catch(() => {});
    }
  };
  for (const tier of o.tiers) {
    for (const v of views) {
      const t0 = Date.now();
      let result;
      try {
        result = await shot(tier, v);
      } catch (e) {
        // a software renderer sometimes loses its GPU process under a heavy view: start the browser again and try once more
        console.error(`  [${tier}/${v.id}] ${String(e.message).split('\n')[0]}; trying again`);
        await browser.close().catch(() => {});
        browser = await launch();
        result = await shot(tier, v);
      }
      const { stats, image } = result;
      const file = `${v.id}-${tier}.jpg`;
      writeFileSync(join(o.out, file), Buffer.from(image.split(',')[1], 'base64'));
      rows.push({ view: v.id, ...stats, file });
      save(); // after every shot, so a run that is cut short keeps what it has
      console.log(
        `${v.id.padEnd(11)} ${tier.padEnd(7)} ${String(stats.calls).padStart(3)} calls  ${String(Math.round(stats.triangles / 1000)).padStart(5)}k tris  ` +
          `${String(stats.textures).padStart(3)} textures  ${String(stats.targetMB).padStart(6)} MB targets  ${String(stats.programs).padStart(2)} programs  (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
      );
    }
  }
  await browser.close();
  server.close();
  console.log(`\n${rows.length} shots in ${o.out}`);
}

/** Side-by-side sheets from two runs, one image per view and tier, the first run on the left. */
async function compare(o) {
  const [a, b] = o.compare;
  const ja = JSON.parse(readFileSync(join(a, 'bench.json'), 'utf8'));
  const jb = JSON.parse(readFileSync(join(b, 'bench.json'), 'utf8'));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 500 }, deviceScaleFactor: 1 });
  mkdirSync(o.out, { recursive: true });
  for (const rb of jb.rows) {
    const ra = ja.rows.find((r) => r.view === rb.view && r.quality === rb.quality);
    if (!ra) continue;
    const label = (r) => `${r.calls} calls · ${Math.round(r.triangles / 1000)}k triangles · ${r.targetMB} MB targets`;
    await page.setContent(`<body style="margin:0;background:#111;color:#ddd;font:14px system-ui">
      <div style="display:flex;gap:6px;padding:6px">
        ${[
          [a, ra, 'before'],
          [b, rb, 'after'],
        ]
          .map(([dir, r, name]) => `<div style="flex:1"><img src="${pathToFileURL(join(dir, r.file))}" style="width:100%;display:block"><div style="padding:4px 2px">${rb.view} · ${rb.quality} · ${name} · ${label(r)}</div></div>`)
          .join('')}
      </div></body>`);
    await page.waitForLoadState('networkidle');
    await page.locator('body > div').screenshot({ path: join(o.out, `${rb.view}-${rb.quality}.jpg`), type: 'jpeg', quality: 90 });
  }
  await browser.close();
  console.log(`sheets in ${o.out}`);
}

const o = args();
await (o.compare ? compare(o) : run(o));
