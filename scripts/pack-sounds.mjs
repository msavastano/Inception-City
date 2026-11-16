// Builds the game's recorded sounds (src/fx/sounds/*.opus and manifest.ts) from
// public-domain recordings on OpenGameArt. Every source is CC0 and listed in ASSETS.md.
//
//   node scripts/pack-sounds.mjs [--cache folder] [--only name,name]
//
// Needs ffmpeg (with libopus) on the PATH, and for the two .7z packs one of
// 7z / 7zz / 7za / 7zr / bsdtar, or Python with py7zr. Downloads are kept in a cache
// folder (the system temp folder unless --cache says otherwise), so a second run is offline.
//
// What it makes:
//   - one loop per bed (rain, far traffic, birds, sea, room tone, crowd murmur). Each file
//     holds its loop plus a tail; the game folds the tail back over the start, so the seam
//     is made after decoding and no codec edge can click.
//   - steps.opus: every footstep, cut, levelled and laid end to end, with their places in
//     the manifest.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'fx', 'sounds');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const cache = flag('--cache') ?? join(tmpdir(), 'inception-city-assets', 'sounds');
const only = flag('--only')?.split(',');
const SR = 48000;
const OGA = 'https://opengameart.org/sites/default/files/';

/** Where each recording comes from. `inside` is the path within an archive. */
const SOURCES = {
  rain: { url: 'Rain%20OGG.zip', inside: '1.ogg' },
  rainHeavy: { url: 'Rain%20OGG.zip', inside: '2.ogg' },
  traffic: { url: 'gatve%20Varniu_2.ogg' },
  birds: { url: 'park_ambience_birds.wav' },
  river: { url: 'VistulaShort_0.mp3' },
  fridge: { url: 'legit_audio_-_the_shop_free_sfx_mp3.zip', inside: 'fridge_drone_2.mp3' },
  voices: { url: 'crowd_shouting_0.ogg' },
  fantozzi: { url: 'Fantozzi-footsteps.7z' },
  corsica: { url: 'corsica_s-walking_in_snow.7z' },
  sfx100: { url: 'sfx_100_v2.zip' },
  splash: { url: 'water-splash-slime-sfx.zip' },
  cloth: { url: 'footsteps.zip' },
  owlish: { url: 'Owlish%20Media%20Sound%20Effects.zip' },
};

/**
 * Beds. from/length in seconds of the source; tail is the extra the game crossfades back
 * over the start; af is an ffmpeg filter chain; level is the RMS the loop is brought to (dBFS).
 */
const BEDS = [
  // a quarter of a minute of steady rain, left channel only (the upload's stereo was made from one microphone)
  { name: 'rain', source: 'rain', from: 0.5, length: 22, tail: 2.5, af: 'pan=mono|c0=c0,highpass=f=90', level: -24, kbps: 48 },
  // heavier and lower: what the rain sounds like on an awning over your head
  { name: 'cover', source: 'rainHeavy', from: 1, length: 18, tail: 2.5, af: 'pan=mono|c0=c0,highpass=f=70,lowpass=f=5200', level: -24, kbps: 40 },
  // a busy road with everything above a low rumble taken off: a city somewhere beyond the rooftops
  { name: 'city', source: 'traffic', from: 4, length: 30, tail: 3, af: 'highpass=f=45,lowpass=f=420,lowpass=f=420', level: -24, kbps: 24 },
  // birds in a park, without the park's own rumble
  { name: 'birds', source: 'birds', from: 132, length: 24, tail: 2.5, af: 'highpass=f=1400,highpass=f=1400,lowpass=f=11000', level: -27, kbps: 40 },
  // river waves on a shore, for Limbo's sea
  { name: 'sea', source: 'river', from: 100, length: 28, tail: 3, af: 'highpass=f=60,lowpass=f=9000', level: -24, kbps: 40 },
  // a shop's refrigerator, for the hum of a hotel corridor
  { name: 'room', source: 'fridge', from: 0.4, length: 6.4, tail: 1.6, af: 'highpass=f=45,lowpass=f=3000', level: -24, kbps: 28 },
];

/** The crowd's murmur: one short recording of a few voices, layered until no word survives. */
const MURMUR = { name: 'murmur', source: 'voices', length: 20, tail: 2.5, layers: 14, af: 'highpass=f=140,lowpass=f=4200', level: -24, kbps: 32, seed: 20261116 };

/**
 * Footsteps. Each set lists [source, file inside it]; af is applied to every file in the set.
 * `max` caps a step's length in seconds.
 */
const fz = (n) => ['fantozzi', `flac/Fantozzi-${n}.flac`];
const snow = (n) => ['corsica', `Walking_on_snow_covered_gravel_${n}.flac`];
const STEPS = [
  { set: 'stone', af: 'highpass=f=70', max: 0.34, files: ['StoneL1', 'StoneR1', 'StoneL2', 'StoneR2', 'StoneL3', 'StoneR3'].map(fz) },
  { set: 'gravel', af: 'highpass=f=90', max: 0.4, files: ['SandL1', 'SandR1', 'SandL2', 'SandR2', 'SandL3', 'SandR3'].map(fz) },
  { set: 'grass', af: 'highpass=f=110', max: 0.4, files: ['gassy-footstep1', 'grassy-footstep2', 'grassy-footstep3', 'grassy-footstep4'].map((n) => ['owlish', `Footsteps/${n}.wav`]) },
  { set: 'snow', af: 'highpass=f=80', max: 0.5, files: ['05', '06', '07', '08', '09'].map(snow) },
  { set: 'wet', af: 'highpass=f=120', max: 0.36, files: ['01', '02', '03'].map((n) => ['sfx100', `sfx100v2_footstep_wet_${n}.ogg`]) },
  { set: 'water', af: 'highpass=f=100', max: 0.5, files: ['06', '10', '14', '15'].map((n) => ['splash', `splash_${n}.ogg`]) },
  { set: 'carpet', af: 'highpass=f=60,lowpass=f=6000', max: 0.24, files: ['1', '2', '3', '4'].map((n) => ['cloth', `footsteps/step_cloth${n}.ogg`]) },
  { set: 'wood', af: 'highpass=f=60', max: 0.34, files: ['01', '02', '03', '04'].map((n) => ['sfx100', `sfx100v2_footstep_wood_${n}.ogg`]) },
];
/** Steps are levelled to this (RMS of their loudest tenth of a second, dBFS), peaks kept under PEAK. */
const STEP_LEVEL = -20;
const PEAK = -2;
const STEP_GAP = 0.06;

// --- getting the recordings ---------------------------------------------------

mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });

async function download(name) {
  const path = join(cache, decodeURIComponent(name));
  if (!existsSync(path)) {
    console.log(`downloading ${OGA}${name}`);
    const res = await fetch(OGA + name);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${name}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return path;
}

/** Pull one file out of a zip (central directory, stored or deflated entries). */
function unzipOne(zip, suffix) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  let p = zip.readUInt32LE(eocd + 16);
  const n = zip.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name.endsWith(suffix)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${suffix} not found in the zip`);
}

function un7z(archive, dir) {
  const tries = [
    ['7z', ['x', '-y', `-o${dir}`, archive]],
    ['7zz', ['x', '-y', `-o${dir}`, archive]],
    ['7za', ['x', '-y', `-o${dir}`, archive]],
    ['7zr', ['x', '-y', `-o${dir}`, archive]],
    ['bsdtar', ['-xf', archive, '-C', dir]],
    ['python3', ['-m', 'py7zr', 'x', archive, dir]],
    ['python', ['-m', 'py7zr', 'x', archive, dir]],
  ];
  mkdirSync(dir, { recursive: true });
  for (const [cmd, a] of tries) {
    const r = spawnSync(cmd, a, { stdio: 'ignore' });
    if (r.status === 0) return;
  }
  rmSync(dir, { recursive: true, force: true });
  throw new Error(`could not unpack ${archive}: install 7-Zip (7z), bsdtar, or "pip install py7zr"`);
}

function findFile(dir, suffix) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, suffix);
      if (hit) return hit;
    } else if (p.replaceAll('\\', '/').endsWith(suffix)) return p;
  }
  return null;
}

/** A path on disk for a source (or for one file inside its archive). */
async function sourceFile(key, inside = SOURCES[key].inside) {
  const src = SOURCES[key];
  const archive = await download(src.url);
  if (!inside) return archive;
  const flat = join(cache, `${key}--${inside.replaceAll('/', '--')}`);
  if (existsSync(flat)) return flat;
  if (archive.endsWith('.zip')) {
    writeFileSync(flat, unzipOne(readFileSync(archive), inside));
    return flat;
  }
  const dir = archive + '.d';
  if (!existsSync(dir)) un7z(archive, dir);
  const hit = findFile(dir, inside);
  if (!hit) throw new Error(`${inside} not found in ${archive}`);
  return hit;
}

// --- sound ----------------------------------------------------------------------

/** Decode to mono 48 kHz floats, through an ffmpeg filter chain. */
function decode(path, { af, from, length } = {}) {
  const a = ['-v', 'error'];
  if (from !== undefined) a.push('-ss', String(from));
  if (length !== undefined) a.push('-t', String(length));
  a.push('-i', path, '-af', [af, 'aresample=48000'].filter(Boolean).join(','), '-ac', '1', '-f', 'f32le', '-');
  const raw = execFileSync('ffmpeg', a, { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2).slice();
}

function encode(samples, name, kbps) {
  const path = join(outDir, `${name}.opus`);
  const a = ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-'];
  a.push('-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-compression_level', '10', '-application', 'audio');
  a.push('-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', path);
  const r = spawnSync('ffmpeg', a, { input: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength) });
  if (r.status !== 0) throw new Error(`encoding ${name} failed: ${r.stderr}`);
  return statSync(path).size;
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const fromDb = (d) => 10 ** (d / 20);
const rms = (a, i0 = 0, i1 = a.length) => {
  let s = 0;
  for (let i = i0; i < i1; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
};
const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const scale = (a, k) => {
  for (let i = 0; i < a.length; i++) a[i] *= k;
  return a;
};

/** Bring a bed to its level, then round off whatever still pokes over the ceiling. */
function levelBed(a, level) {
  scale(a, fromDb(level) / rms(a));
  const ceil = fromDb(-6);
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > ceil * 0.7) a[i] = Math.sign(a[i]) * ceil * (0.7 + 0.3 * Math.tanh((v / ceil - 0.7) / 0.3));
  }
  return a;
}

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A murmur from a few voices: many copies of the recording, each slowed by a different
 * amount and started somewhere else, each drifting slowly in level. Slowing lowers the
 * voices and takes the urgency out of them; fourteen at once leave no word to follow.
 */
function murmur(voices, seconds, layers, seed) {
  const rand = mulberry(seed);
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const fade = Math.round(0.08 * SR);
  for (let l = 0; l < layers; l++) {
    const rate = 0.7 + 0.24 * rand();
    const gain = 0.6 + 0.4 * rand();
    const drift = 0.05 + 0.1 * rand();
    const phase = rand() * Math.PI * 2;
    let pos = rand() * (voices.length - 2);
    for (let i = 0; i < n; i++) {
      const j = Math.floor(pos);
      const f = pos - j;
      let v = voices[j] * (1 - f) + voices[j + 1] * f;
      // where the recording wraps round, dip through silence
      const edge = Math.min(j, voices.length - 2 - j);
      if (edge < fade) v *= edge / fade;
      out[i] += v * gain * (0.65 + 0.35 * Math.sin(phase + (i / SR) * drift * Math.PI * 2));
      pos += rate;
      if (pos >= voices.length - 2) pos -= voices.length - 2;
    }
  }
  return out;
}

/** Cut one footstep out of its file: from just before it starts to where it has died away. */
function cutStep(a, max) {
  const win = Math.round(0.004 * SR);
  const frames = Math.floor(a.length / win);
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) env[i] = rms(a, i * win, (i + 1) * win);
  let top = 0;
  for (let i = 1; i < frames; i++) if (env[i] > env[top]) top = i;
  let start = top;
  while (start > 0 && env[start - 1] > env[top] * fromDb(-26)) start--;
  let end = top;
  while (end < frames - 1 && (end - top) * win < 0.05 * SR) end++;
  while (end < frames - 1 && env[end] > env[top] * fromDb(-38)) end++;
  const i0 = Math.max(0, start * win - Math.round(0.006 * SR));
  const i1 = Math.min(a.length, (end + 1) * win, i0 + Math.round(max * SR));
  const s = a.slice(i0, i1);
  const fin = Math.round(0.002 * SR);
  const fout = Math.min(s.length >> 1, Math.round(0.03 * SR));
  for (let i = 0; i < fin; i++) s[i] *= i / fin;
  for (let i = 0; i < fout; i++) s[s.length - 1 - i] *= i / fout;
  // level by the loudest tenth of a second, then keep the peak under the ceiling
  const span = Math.min(s.length, Math.round(0.1 * SR));
  let loud = 0;
  for (let i = 0; i + span <= s.length; i += win) loud = Math.max(loud, rms(s, i, i + span));
  scale(s, fromDb(STEP_LEVEL) / loud);
  const p = peak(s);
  if (p > fromDb(PEAK)) scale(s, fromDb(PEAK) / p);
  return s;
}

// --- build ----------------------------------------------------------------------

const manifest = { beds: {}, steps: { file: 'steps.opus', sets: {} } };
const manifestPath = join(outDir, 'manifest.ts');
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8').match(/SOUNDS = (\{[\s\S]*\}) as const/)[1]) : null;
const wanted = (name) => !only || only.includes(name);
let total = 0;
const report = (name, bytes, note) => {
  total += bytes;
  console.log(`${name.padEnd(8)} ${(bytes / 1024).toFixed(0).padStart(5)} kB  ${note}`);
};

for (const bed of [...BEDS, MURMUR]) {
  const seconds = bed.length + bed.tail;
  if (!wanted(bed.name)) {
    manifest.beds[bed.name] = prior.beds[bed.name];
    total += statSync(join(outDir, `${bed.name}.opus`)).size;
    continue;
  }
  const file = await sourceFile(bed.source);
  let a;
  if (bed.layers) a = murmur(decode(file, { af: bed.af }), seconds, bed.layers, bed.seed);
  else a = decode(file, { af: bed.af, from: bed.from, length: seconds });
  if (a.length < seconds * SR - SR / 10) throw new Error(`${bed.name}: the source is too short`);
  // a moment of quiet at each end, so the codec's first and last frames carry nothing that matters
  const fade = Math.round(0.01 * SR);
  for (let i = 0; i < fade; i++) {
    a[i] *= i / fade;
    a[a.length - 1 - i] *= i / fade;
  }
  levelBed(a, bed.level);
  const bytes = encode(a, bed.name, bed.kbps);
  manifest.beds[bed.name] = { file: `${bed.name}.opus`, seconds: bed.length, tail: bed.tail };
  report(bed.name, bytes, `${bed.length}s loop + ${bed.tail}s tail, rms ${db(rms(a)).toFixed(1)} dB, peak ${db(peak(a)).toFixed(1)} dB`);
}

if (wanted('steps')) {
  const parts = [];
  let at = STEP_GAP;
  const gap = new Float32Array(Math.round(STEP_GAP * SR));
  parts.push(gap);
  for (const set of STEPS) {
    manifest.steps.sets[set.set] = [];
    for (const [source, inside] of set.files) {
      const s = cutStep(decode(await sourceFile(source, inside), { af: set.af }), set.max);
      manifest.steps.sets[set.set].push([Math.round(at * 1e4) / 1e4, Math.round((s.length / SR) * 1e4) / 1e4]);
      parts.push(s, gap);
      at += s.length / SR + STEP_GAP;
    }
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  manifest.steps.seconds = Math.round((all.length / SR) * 1e3) / 1e3;
  const bytes = encode(all, 'steps', 64);
  const count = Object.values(manifest.steps.sets).reduce((n, s) => n + s.length, 0);
  report('steps', bytes, `${count} footsteps on ${STEPS.length} surfaces, ${(all.length / SR).toFixed(1)}s`);
} else {
  manifest.steps = prior.steps;
  total += statSync(join(outDir, 'steps.opus')).size;
}

/** JSON, with one line for each bed and each set of footsteps. */
function compact(m) {
  const lines = (o) => Object.entries(o).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  return `{
  "beds": {
${lines(m.beds).replace(/^ {6}/gm, '    ')}
  },
  "steps": {
    "file": ${JSON.stringify(m.steps.file)},
    "seconds": ${m.steps.seconds},
    "sets": {
${lines(m.steps.sets)}
    }
  }
}`;
}

writeFileSync(
  manifestPath,
  `// Generated by scripts/pack-sounds.mjs from CC0 recordings (see ASSETS.md). Do not edit by hand.
// Beds: seconds of loop, then a tail the game crossfades back over the start.
// Steps: [start, length] in seconds within steps.opus.
export const SOUNDS = ${compact(manifest)} as const;
`,
);
console.log(`total    ${(total / 1024).toFixed(0).padStart(5)} kB`);
