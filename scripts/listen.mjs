// The listening bench: plays the game through a set of scenes in a headless browser and
// records what comes out of the speakers, so a change to the sound can be heard (and
// measured) before and after.
//
//   npm run build
//   node scripts/listen.mjs                      every scene into listen/reel.webm, with a table of levels
//   node scripts/listen.mjs --scenes rain,hall --out /tmp/listen
//   node scripts/listen.mjs --no-drone           the recordings without the drone under them
//
// Needs Playwright, like the screenshot bench. Nothing is drawn (sound does not need the
// picture), so it runs in real time on a machine with no graphics card. With ffmpeg on
// the PATH each scene is also cut out to its own .mp3.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 4242;

/** What each scene is, for the table. What it does is in play() below, under the same id. */
const SCENES = [
  { id: 'city', note: 'Level 1 by day: standing on a street, then walking down it' },
  { id: 'circus', note: 'Level 1: across the Circus (road, lawn, paving)' },
  { id: 'night', note: 'Level 1 at midnight, walking' },
  { id: 'crowd', note: 'Level 1: a crowd close by, which then stops and stares' },
  { id: 'rain', note: 'Level 2: in the open road, then walking under the awnings' },
  { id: 'snow', note: 'Level 3: standing, then walking in the snow' },
  { id: 'limbo', note: 'Limbo: wading where the sea has come in' },
  { id: 'hall', note: 'The rotating hallway' },
  { id: 'above', note: "The Architect's camera, high over the city, then coming down" },
];

function args() {
  const a = process.argv.slice(2);
  const get = (name, fallback) => (a.includes(`--${name}`) ? a[a.indexOf(`--${name}`) + 1] : fallback);
  return { out: resolve(get('out', join(root, 'listen'))), dist: resolve(get('dist', join(root, 'dist'))), scenes: get('scenes', ''), hash: get('hash', ''), noDrone: a.includes('--no-drone') };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.opus': 'audio/ogg' };

function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(dir, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

/** Runs in the page: play the scenes one after another, recording the output and metering it. */
async function play({ ids, noDrone }) {
  const d = window.dream;
  const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
  // sound does not need the picture
  d.renderer.render = () => {};
  d.post.render = () => {};
  d.start('walk');
  d.pendingPreset = null;
  d.autoQuality = false;
  const ctx = d.audio.context;
  if (!ctx) throw new Error('no audio here');
  await ctx.resume();
  for (let i = 0; i < 100 && !d.audio.recorded; i++) await sleep(0.1);
  const out = d.audio.output;
  if (noDrone) {
    // the recordings on their own, without the drone under them
    d.audio.droneGain.gain.cancelScheduledValues(0);
    d.audio.droneGain.gain.value = 0;
  }
  const dest = ctx.createMediaStreamDestination();
  out.connect(dest);
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  out.connect(meter);
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 160000 });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);

  const walk = d.walk;
  const keys = (...k) => {
    walk.keys.clear();
    for (const key of k) walk.keys.add(key);
  };
  const level = (i, time) => {
    d.setLevel(i, time);
    d.env.applyInstant();
    d.instability = 0;
  };
  const stand = (x, z, yaw = 0) => {
    keys();
    if (d.mode !== 'walk') d.setMode('walk');
    walk.teleport(x, z, yaw);
  };
  const gather = (spread) => {
    d.crowd.opts.spread = spread;
    d.crowd.scatter(walk.x, walk.z, 4);
  };
  // each scene: steps of [seconds, what to do at their start]
  const scenes = {
    city: [[4, () => (level(0, 0.18), stand(66.5, -120)), 'standing'], [5, () => keys('KeyW'), 'walking'], [3, () => keys('KeyW', 'ShiftLeft'), 'sprinting']],
    circus: [[7, () => (level(0, 0.18), stand(0, -45), keys('KeyW')), 'walking in']],
    night: [[3, () => (level(0, 1), stand(66.5, -120)), 'standing'], [4, () => keys('KeyW'), 'walking']],
    crowd: [[7, () => (level(0, 0.18), stand(69.5, -128), gather(3)), 'among them'], [7, () => (d.instability = 0.62), 'they stare']],
    rain: [[4, () => (level(1), stand(0, -150)), 'open road'], [4, () => keys('KeyW'), 'walking'], [5, () => (stand(11.4, -150), keys('KeyW')), 'under the awnings']],
    snow: [[4, () => (level(2), stand(66.5, -120)), 'standing'], [5, () => keys('KeyW'), 'walking']],
    limbo: [[4, () => (level(3), stand(66.5, -120)), 'in the city'], [6, () => (stand(4, -690), keys('KeyW')), 'in the sea']],
    hall: [[4, () => (level(0, 0.18), stand(66.5, -120), walk.toggleHallway()), 'inside'], [6, () => keys('KeyW'), 'walking']],
    above: [
      [5, () => (level(0, 0.18), keys(), d.setMode('architect'), d.architect.finishFlight?.(), d.camera.position.set(330, 420, -300), d.architect.controls.target.set(0, 20, 0)), 'high'],
      [5, () => d.camera.position.set(60, 40, -60), 'low'],
    ],
  };

  const rows = [];
  const buf = new Float32Array(meter.fftSize);
  rec.start();
  const t0 = ctx.currentTime;
  for (const id of ids) {
    for (const [seconds, begin, part] of scenes[id]) {
      begin();
      // let the beds load and come up before measuring
      await sleep(Math.min(1.2, seconds / 3));
      let sum = 0;
      let n = 0;
      let peak = 0;
      const until = ctx.currentTime + seconds - Math.min(1.2, seconds / 3);
      const from = ctx.currentTime - t0;
      while (ctx.currentTime < until) {
        meter.getFloatTimeDomainData(buf);
        for (const v of buf) {
          sum += v * v;
          peak = Math.max(peak, Math.abs(v));
        }
        n += buf.length;
        await sleep(0.04);
      }
      const dB = (v) => Math.round(200 * Math.log10(Math.max(v, 1e-6))) / 10;
      rows.push({ id, part, at: Math.round((from - Math.min(1.2, seconds / 3)) * 100) / 100, seconds, rms: dB(Math.sqrt(sum / n)), peak: dB(peak), beds: d.audio.playing.join(' ') });
    }
    keys();
    d.instability = 0;
  }
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { rows, webm: btoa(bin), recorded: d.audio.recorded, rate: ctx.sampleRate };
}

const o = args();
if (!existsSync(join(o.dist, 'index.html'))) {
  console.error(`No build in ${o.dist}. Run "npm run build" first.`);
  process.exit(1);
}
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('The listening bench needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
const ids = o.scenes ? o.scenes.split(',') : SCENES.map((s) => s.id);
const server = await serve(o.dist);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error(`  ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.error(`  ${m.text().slice(0, 300)}`);
});
await page.goto(`http://127.0.0.1:${server.address().port}/#s=${SEED}&q=medium${o.hash ? `&${o.hash}` : ''}`);
await page.waitForFunction(() => window.dream, null, { timeout: 120000 });
const { rows, webm, recorded, rate } = await page.evaluate(play, { ids, noDrone: o.noDrone });
await browser.close();
server.close();

mkdirSync(o.out, { recursive: true });
const reel = join(o.out, 'reel.webm');
writeFileSync(reel, Buffer.from(webm, 'base64'));
writeFileSync(join(o.out, 'listen.json'), JSON.stringify({ seed: SEED, rate, recorded, scenes: SCENES.filter((s) => ids.includes(s.id)), rows }, null, 2));
console.log(recorded ? `Recordings decoded. ${rate} Hz.` : 'The recordings did NOT decode here: this is the fallback sound.');
for (const r of rows) console.log(`${r.id.padEnd(7)} ${r.part.padEnd(18)} ${String(r.rms).padStart(6)} dB rms  ${String(r.peak).padStart(6)} dB peak   ${r.beds}`);
// one file per scene, if ffmpeg is here
if (spawnSync('ffmpeg', ['-version']).status === 0) {
  for (const id of ids) {
    const parts = rows.filter((r) => r.id === id);
    const from = parts[0].at;
    const length = parts.reduce((n, r) => n + r.seconds, 0);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(from), '-t', String(length), '-i', reel, '-c:a', 'libmp3lame', '-b:a', '160k', join(o.out, `${id}.mp3`)]);
  }
}
console.log(`\n${reel}`);
