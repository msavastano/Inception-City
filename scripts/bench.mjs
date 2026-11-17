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
// triangles and memory, and milliseconds only when asked:
//
//   node scripts/bench.mjs --gpu --time --channel msedge       on a machine with a graphics card
//
// --gpu asks for the real graphics card instead of the software renderer, --channel uses an
// installed browser (msedge, chrome) instead of Playwright's own, and --time draws each view
// forty more times and reports the average frame in milliseconds. Every row records which
// renderer drew it, so a time from the software renderer cannot be mistaken for a real one.
// A frame time moves from one page load to the next by more than a small change costs, so
// --repeat 3 loads each view three times and reports the middle time and the spread.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  { id: 'facade', extra: true, note: 'A sunlit Haussmann front from across the street', level: 1, at: [18, 58.5, 0.25, 0.22] },
  { id: 'windows', extra: true, note: 'Along a sunlit Haussmann front from its own sidewalk', level: 1, at: [5, 68, 1.05, 0.3] },
  { id: 'brick', extra: true, note: 'A sunlit old-town brick front', level: 1, at: [-86, 123, 0.2, 0.2] },
  { id: 'concrete', extra: true, note: 'A sunlit concrete front with ribbon windows', level: 1, at: [-290, -134, 0.2, 0.2] },
  { id: 'glass', extra: true, note: 'The foot of a glass tower', level: 1, at: [-150, 318, 0.15, 0.4] },
  { id: 'facade-night', extra: true, note: 'The same Haussmann front at midnight', level: 1, time: 1, at: [18, 58.5, 0.25, 0.22] },
  { id: 'roofline', extra: true, note: 'A cornice, a mansard and its dormers from across the street', level: 1, cam: { pos: [6, 30, 56], target: [22, 25, 74] } },
  { id: 'blast', extra: true, note: 'The café explosion, three seconds in', level: 1, at: [18, 58.5, 0.25, 0.22], blast: 1.5 },
  { id: 'third', extra: true, note: 'Behind the dreamer on a street', level: 1, third: true, at: [69.5, -120, 0, 0.06] },
  { id: 'behind-circus', extra: true, note: 'Behind the dreamer, crossing the Circus', level: 1, third: true, at: [-9, -62, 0.12, 0.16], keys: ['KeyW'], frames: 34, phase: 0.3 },
  {
    id: 'behind-curl',
    extra: true,
    note: 'Behind the dreamer, heading for the curl',
    level: 1,
    third: true,
    folds: [
      [0, 128, 0, 1, PI / 2, 60],
      [0, 448, 0, 1, PI / 2, 60],
    ],
    at: [5.5, 78, 0, 0.12],
    keys: ['KeyW'],
    frames: 40,
    phase: 3.4,
  },
  { id: 'run', extra: true, note: 'Behind the dreamer, running', level: 1, third: true, at: [69.5, -120, 0, 0.06], keys: ['KeyW'], frames: 50, phase: 0.3 },
  { id: 'sprint', extra: true, note: 'Behind the dreamer, sprinting', level: 1, third: true, at: [69.5, -120, 0, 0.06], keys: ['KeyW', 'ShiftLeft'], frames: 43, phase: 3.3 },
  { id: 'crowd', extra: true, note: 'Pedestrians at a busy crossing', level: 1, at: [69.5, -128, 0, -0.2], gather: 3, frames: 40 },
  { id: 'stares', extra: true, note: 'The dream unsteady: the crowd stops and stares', level: 1, at: [69.5, -128, 0, -0.2], gather: 3, unstable: 0.55, frames: 160, dt: 0.05 },
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
    time: a.includes('--time'),
    repeat: Math.max(1, Number(get('repeat', '1')) || 1),
    gpu: a.includes('--gpu'),
    channel: get('channel', ''),
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
function shoot([v, time]) {
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
  if (v.gather) {
    // bring the crowd in around the walker (they are spread over many blocks otherwise)
    d.crowd.opts.spread = v.gather;
    d.crowd.scatter(v.at[0], v.at[1], 5);
  }
  if (v.blast) {
    // stability hits zero: let the wave run for a while before the shot
    d.blowUp();
    d.step(Math.round(v.blast / 0.05), 0.05, false);
  }
  if (v.keys || v.gather) {
    // let things move: keys held down for the walker, time for the crowd, at a real frame rate
    for (const k of v.keys ?? []) d.walk.keys.add(k);
    const frames = v.frames ?? 45;
    for (let i = 0; i < frames; i++) {
      if (v.unstable) d.instability = v.unstable;
      // (a stride phase for the last frame, so the shot catches the dreamer mid-stride: a footfall every π)
      if (v.phase !== undefined && i === frames - 1) d.walk.stepPhase = v.phase;
      d.step(1, v.dt ?? 1 / 60, i === frames - 1);
    }
  } else {
    d.step(30);
  }
  // read the canvas back in the same task as the draw, before the browser clears it
  const out = { stats: d.stats(), image: document.getElementById('scene').toDataURL('image/jpeg', 0.92) };
  const gl = d.renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  out.stats.renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  if (time) {
    // the same frame again and again, with the clock stopped; reading a pixel back makes the browser wait for the GPU to finish
    const px = new Uint8Array(4);
    const draw = () => {
      d.step(1, 0, true);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    for (let i = 0; i < 5; i++) draw();
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) draw();
    out.stats.ms = Math.round(((performance.now() - t0) / 40) * 100) / 100;
  }
  return out;
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
  const launch = () =>
    chromium.launch({
      ...(o.channel ? { channel: o.channel } : {}),
      args: o.gpu ? ['--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl'] : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    });
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
      return await page.evaluate(shoot, [v, o.time]);
    } finally {
      await context.close().catch(() => {});
    }
  };
  for (const tier of o.tiers) {
    for (const v of views) {
      const t0 = Date.now();
      const attempt = async () => {
        try {
          return await shot(tier, v);
        } catch (e) {
          // a software renderer sometimes loses its GPU process under a heavy view: start the browser again and try once more
          console.error(`  [${tier}/${v.id}] ${String(e.message).split('\n')[0]}; trying again`);
          await browser.close().catch(() => {});
          browser = await launch();
          return await shot(tier, v);
        }
      };
      const result = await attempt();
      if (o.time && o.repeat > 1) {
        const times = [result.stats.ms];
        for (let r = 1; r < o.repeat; r++) times.push((await attempt()).stats.ms);
        times.sort((x, y) => x - y);
        result.stats.ms = times[Math.floor(times.length / 2)];
        result.stats.runs = times;
      }
      const { stats, image } = result;
      const file = `${v.id}-${tier}.jpg`;
      writeFileSync(join(o.out, file), Buffer.from(image.split(',')[1], 'base64'));
      rows.push({ view: v.id, ...stats, file });
      save(); // after every shot, so a run that is cut short keeps what it has
      console.log(
        `${v.id.padEnd(11)} ${tier.padEnd(7)} ${String(stats.calls).padStart(3)} calls  ${String(Math.round(stats.triangles / 1000)).padStart(5)}k tris  ` +
          `${String(stats.textures).padStart(3)} textures  ${String(stats.targetMB).padStart(6)} MB targets  ${String(stats.programs).padStart(2)} programs  ` +
          `${stats.ms !== undefined ? `${stats.ms.toFixed(2).padStart(7)} ms a frame  ` : ''}` +
          `${stats.runs ? `(${stats.runs.map((t) => t.toFixed(1)).join(' / ')})  ` : ''}(${((Date.now() - t0) / 1000).toFixed(0)} s)`,
      );
    }
  }
  await browser.close();
  server.close();
  console.log(`\n${rows.length} shots in ${o.out}, drawn by ${rows[0]?.renderer ?? 'nothing'}`);
}

/** Side-by-side sheets from two runs, one image per view and tier, the first run on the left. */
async function compare(o) {
  const [a, b] = o.compare;
  const ja = JSON.parse(readFileSync(join(a, 'bench.json'), 'utf8'));
  const jb = JSON.parse(readFileSync(join(b, 'bench.json'), 'utf8'));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(o.channel ? { channel: o.channel } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 500 }, deviceScaleFactor: 1 });
  mkdirSync(o.out, { recursive: true });
  for (const rb of jb.rows) {
    const ra = ja.rows.find((r) => r.view === rb.view && r.quality === rb.quality);
    if (!ra) continue;
    const label = (r) => `${r.calls} calls · ${Math.round(r.triangles / 1000)}k triangles · ${r.targetMB} MB targets${r.ms !== undefined ? ` · ${r.ms} ms a frame` : ''}`;
    await page.setContent(`<body style="margin:0;background:#111;color:#ddd;font:14px system-ui">
      <div style="display:flex;gap:6px;padding:6px">
        ${[
          [a, ra, 'before'],
          [b, rb, 'after'],
        ]
          .map(([dir, r, name]) => `<div style="flex:1"><img src="data:image/jpeg;base64,${readFileSync(join(dir, r.file)).toString('base64')}" style="width:100%;display:block"><div style="padding:4px 2px">${rb.view} · ${rb.quality} · ${name} · ${label(r)}</div></div>`)
          .join('')}
      </div></body>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await page.locator('body > div').screenshot({ path: join(o.out, `${rb.view}-${rb.quality}.jpg`), type: 'jpeg', quality: 90 });
  }
  await browser.close();
  console.log(`sheets in ${o.out}`);
}

const o = args();
await (o.compare ? compare(o) : run(o));
