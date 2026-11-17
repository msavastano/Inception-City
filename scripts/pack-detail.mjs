// Builds the close-up surface detail (src/city/detail/*.webp and manifest.ts) from
// public-domain scanned textures on Poly Haven. Every source is CC0 and listed in ASSETS.md.
//
//   node scripts/pack-detail.mjs [--src folder] [--cache folder] [--quality 0..100, default 60]
//
// Needs ffmpeg (with libwebp) on the PATH. The sources are Poly Haven's 1k maps: the normal
// map (OpenGL), roughness and ambient occlusion of each texture. They are downloaded into a
// cache folder (the system temp folder unless --cache says otherwise), so a second run is
// offline; --src points at a folder that already holds them as <id>/<id>_nor_gl_1k.png,
// <id>/<id>_rough_1k.jpg and <id>/<id>_ao_1k.jpg (the layout Poly Haven's own downloads use).
//
// Only the shape of each surface is kept, never its colour: the game paints its colours itself.
// What it makes, for each layer: one grey WebP holding four 512 x 512 tiles, each with a
// 16-pixel border of the tile wrapped round, so no edge of one tile can bleed into another:
//
//   top left:     the relief, how much the surface leans along u   (normal x, times `relief`)
//   top right:    the relief, how much it leans along v            (normal y, times `relief`)
//   bottom left:  roughness, as a change from the texture's own average (0.5 = no change)
//   bottom right: the cavities (ambient occlusion), scaled so the texture's average is 0.75
//
// The game puts the four back together into one texture array (src/city/detail.ts).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'city', 'detail');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const src = flag('--src');
const cache = flag('--cache') ?? join(tmpdir(), 'inception-city-assets', 'detail');
const QUALITY = Number(flag('--quality') ?? 60);

const SOURCE = 1024;
const TILE = 512;
const GUTTER = 16;
const CELL = TILE + 2 * GUTTER;
const SIDE = 2 * CELL;
const AO_MEAN = 0.75;

/**
 * The layers, in the order the texture array holds them (the shaders name them by these names).
 * `id` is the Poly Haven texture; `metres` the width of ground one tile covers (Poly Haven's own
 * measurement); `relief` multiplies the normal's lean (a gentle surface is lifted so 8 bits hold
 * it); `rough` multiplies the roughness's spread; `cavity` how much of the occlusion is kept.
 */
const LAYERS = [
  { name: 'asphalt', id: 'asphalt_01', metres: 2.08, relief: 1.6, rough: 1.5, cavity: 0.8, use: 'roads' },
  { name: 'aggregate', id: 'gravel_embedded_concrete', metres: 2, relief: 1.1, rough: 1.5, cavity: 0.7, use: 'pavements, and the faces of bricks' },
  { name: 'setts', id: 'cobblestone_floor_08', metres: 2, relief: 1, rough: 1, cavity: 1, use: 'the gutters along the kerbs, and the courtyards' },
  { name: 'fan', id: 'floor_pattern_02', metres: 1.2, relief: 1, rough: 0.8, cavity: 1, use: 'the setts laid in fans round the monument and in the squares' },
  { name: 'gravel', id: 'rocky_trail', metres: 2, relief: 0.8, rough: 1, cavity: 0.8, use: 'the paths in the parks' },
  { name: 'stone', id: 'concrete_floor_02', metres: 2, relief: 2.6, rough: 2, cavity: 1, use: 'limestone walls, kerbs, flagstones and concrete yards' },
  { name: 'boards', id: 'concrete_layers_02', metres: 2, relief: 3, rough: 2, cavity: 1, use: 'concrete walls cast against boards' },
];

const MAPS = { normal: (id) => `${id}_nor_gl_1k.png`, rough: (id) => `${id}_rough_1k.jpg`, ao: (id) => `${id}_ao_1k.jpg` };
const API_KEYS = { normal: ['nor_gl', 'png'], rough: ['Rough', 'jpg'], ao: ['AO', 'jpg'] };

async function source(id, map) {
  const file = MAPS[map](id);
  if (src) {
    const path = join(src, id, file);
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    return path;
  }
  const path = join(cache, id, file);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
    const [key, format] = API_KEYS[map];
    const url = files[key]?.['1k']?.[format]?.url;
    if (!url) throw new Error(`Poly Haven lists no 1k ${key} ${format} for ${id}`);
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return path;
}

/** Decode an image to raw pixels at 1024 x 1024 (rgb24 or gray). */
function decode(path, fmt) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${SOURCE}:${SOURCE}:flags=area`, '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 1 << 26 });
  const want = SOURCE * SOURCE * (fmt === 'gray' ? 1 : 3);
  if (raw.length !== want) throw new Error(`${path}: decoded ${raw.length} bytes, expected ${want}`);
  return raw;
}

/** Halve a 1024 channel to 512 by averaging each 2 x 2 (channel c of n per pixel), as floats. */
function halve(raw, n, c, map = (v) => v / 255) {
  const out = new Float32Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const i = (2 * y * SOURCE + 2 * x) * n + c;
      out[y * TILE + x] = 0.25 * (map(raw[i]) + map(raw[i + n]) + map(raw[i + SOURCE * n]) + map(raw[i + SOURCE * n + n]));
    }
  }
  return out;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

async function pack(layer) {
  const nrm = decode(await source(layer.id, 'normal'), 'rgb24');
  const rough = halve(decode(await source(layer.id, 'rough'), 'gray'), 1, 0);
  const ao = halve(decode(await source(layer.id, 'ao'), 'gray'), 1, 0);
  const nx = halve(nrm, 3, 0, (v) => v / 127.5 - 1);
  const ny = halve(nrm, 3, 1, (v) => v / 127.5 - 1);
  const rMean = mean(rough);
  const aMean = mean(ao);
  // the four tiles, as bytes
  const tiles = [
    nx.map((v) => 0.5 + 0.5 * Math.max(-1, Math.min(1, v * layer.relief))),
    ny.map((v) => 0.5 + 0.5 * Math.max(-1, Math.min(1, v * layer.relief))),
    rough.map((v) => 0.5 + (v - rMean) * layer.rough),
    ao.map((v) => AO_MEAN * (1 + (v / aMean - 1) * layer.cavity)),
  ];
  let clipped = 0;
  const img = Buffer.alloc(SIDE * SIDE);
  tiles.forEach((tile, t) => {
    const ox = (t & 1) * CELL;
    const oy = (t >> 1) * CELL;
    for (let y = -GUTTER; y < TILE + GUTTER; y++) {
      const sy = (y + TILE) % TILE;
      for (let x = -GUTTER; x < TILE + GUTTER; x++) {
        const v = tile[sy * TILE + ((x + TILE) % TILE)];
        if (v < 0 || v > 1) clipped++;
        img[(oy + GUTTER + y) * SIDE + ox + GUTTER + x] = byte(v);
      }
    }
  });
  const file = `${layer.name}.webp`;
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${SIDE}x${SIDE}`, '-i', '-', '-c:v', 'libwebp', '-quality', String(QUALITY), '-compression_level', '6', '-pix_fmt', 'yuv420p', join(outDir, file)],
    { input: img },
  );
  const lean = mean(nx.map((v, i) => Math.hypot(v, ny[i]))) * layer.relief;
  const bytes = statSync(join(outDir, file)).size;
  console.log(`${layer.name.padEnd(10)} ${layer.id.padEnd(26)} ${(bytes / 1024).toFixed(0).padStart(4)} kB  lean ${lean.toFixed(2)}  roughness ${rMean.toFixed(2)}  occlusion ${aMean.toFixed(2)}${clipped ? `  (${clipped} values clipped)` : ''}`);
  return { file, bytes };
}

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.webp')) rmSync(join(outDir, f));
let total = 0;
for (const layer of LAYERS) total += (await pack(layer)).bytes;

const ident = (name) => `${name}Url`;
const manifest = `// Generated by scripts/pack-detail.mjs from CC0 textures on Poly Haven (see ASSETS.md). Do not edit by hand.
${LAYERS.map((l) => `import ${ident(l.name)} from './${l.name}.webp?url';`).join('\n')}

/** One layer of the detail texture array: the shape of a surface, never its colour. */
export interface DetailLayer {
  /** What the shaders call it. */
  name: string;
  /** The packed file: four ${TILE}-pixel tiles (relief along u, relief along v, roughness, cavities), each with a ${GUTTER}-pixel wrapped border. */
  url: string;
  /** Metres of surface one tile covers. */
  metres: number;
  /** Where it came from: the texture's name on Poly Haven. */
  source: string;
}

export const DETAIL = {
  tile: ${TILE},
  gutter: ${GUTTER},
  /** The cavities are stored so that a texture's average reads as this; the shaders divide by it. */
  aoMean: ${AO_MEAN},
  layers: [
${LAYERS.map((l) => `    { name: '${l.name}', url: ${ident(l.name)}, metres: ${l.metres}, source: '${l.id}' },`).join('\n')}
  ] as DetailLayer[],
};
`;
writeFileSync(join(outDir, 'manifest.ts'), manifest);
console.log(`\n${LAYERS.length} layers, ${(total / 1024).toFixed(0)} kB in ${outDir}`);
