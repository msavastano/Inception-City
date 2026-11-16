// Packs the skeleton and a handful of clips from Quaternius's Universal Animation
// Library (CC0, see ASSETS.md) into src/people/rigdata.ts: 22 bones, quantised
// rotations, about 60 kB. The game ships only that file; the 14 MB pack is not kept.
//
//   node scripts/pack-people.mjs [path/to/AnimationLibrary_Godot_Standard.glb | pack.zip]
//
// With no argument the pack is downloaded from OpenGameArt into a cache folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import * as THREE from 'three';

const PACK_URL = 'https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip';
const GLB_IN_ZIP = 'Godot/AnimationLibrary_Godot_Standard.glb';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The bones the game keeps, parents first. Fingers are dropped (hands are mittens). */
const BONES = [
  'DEF-hips',
  'DEF-spine.001',
  'DEF-spine.002',
  'DEF-spine.003',
  'DEF-neck',
  'DEF-head',
  'DEF-shoulder.L',
  'DEF-upper_arm.L',
  'DEF-forearm.L',
  'DEF-hand.L',
  'DEF-shoulder.R',
  'DEF-upper_arm.R',
  'DEF-forearm.R',
  'DEF-hand.R',
  'DEF-thigh.L',
  'DEF-shin.L',
  'DEF-foot.L',
  'DEF-toe.L',
  'DEF-thigh.R',
  'DEF-shin.R',
  'DEF-foot.R',
  'DEF-toe.R',
];
const short = (n) => n.replace('DEF-', '').replace('spine.00', 'spine').replace('.L', 'L').replace('.R', 'R').replace('_', '');

/** Clips to keep: [name in the pack, name in the game, frames per second, loops, moves along the street]. */
const CLIPS = [
  ['Idle_Loop', 'idle', 15, true, false],
  ['Idle_Talking_Loop', 'talk', 15, true, false],
  ['Walk_Loop', 'walk', 30, true, true],
  ['Walk_Formal_Loop', 'stroll', 30, true, true],
  ['Jog_Fwd_Loop', 'jog', 30, true, true],
  ['Sprint_Loop', 'sprint', 30, true, true],
  ['Jump_Loop', 'air', 15, true, false],
  ['Jump_Land', 'land', 20, false, false],
  ['Hit_Chest', 'hit', 30, false, false],
  ['PickUp_Table', 'pick', 20, false, false],
  ['Punch_Jab', 'jab', 20, false, false],
];

// --- read the pack ----------------------------------------------------------

async function loadGlb(arg) {
  let path = arg;
  if (!path) {
    const cache = join(tmpdir(), 'inception-city-assets');
    mkdirSync(cache, { recursive: true });
    path = join(cache, 'ual-standard.zip');
    if (!existsSync(path)) {
      console.log(`downloading ${PACK_URL}`);
      const res = await fetch(PACK_URL);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
  }
  const buf = readFileSync(path);
  return buf.readUInt32LE(0) === 0x04034b50 ? unzipOne(buf, GLB_IN_ZIP) : buf;
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

const glb = await loadGlb(process.argv[2]);
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const bin = glb.subarray(20 + jsonLen + 8);

function accessor(i) {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  if (a.componentType !== 5126 || !n) throw new Error('unexpected accessor type');
  const out = new Float32Array(a.count * n);
  const dv = new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0));
  const stride = bv.byteStride || n * 4;
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv.getFloat32(k * stride + c * 4, true);
  return out;
}

const nodeIndex = new Map(gltf.nodes.map((n, i) => [n.name, i]));
const parentOf = new Map();
gltf.nodes.forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));
const restT = (n) => new THREE.Vector3(...(n.translation || [0, 0, 0]));
const restQ = (n) => new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1]));

// The armature's root only turns Blender's z-up into y-up: fold it into the hips.
const rootNode = gltf.nodes[nodeIndex.get('root')];
const rootQ = restQ(rootNode);
if (restT(rootNode).length() > 1e-6) throw new Error('root is not at the origin');

const bones = BONES.map((name) => {
  const i = nodeIndex.get(name);
  if (i === undefined) throw new Error(`bone ${name} missing`);
  const node = gltf.nodes[i];
  const parentName = gltf.nodes[parentOf.get(i)].name;
  const parent = BONES.indexOf(parentName);
  if (parent < 0 && parentName !== 'root') throw new Error(`${name}: parent ${parentName} is not kept`);
  const t = restT(node);
  const q = restQ(node);
  if (parent < 0) {
    t.applyQuaternion(rootQ);
    q.premultiply(rootQ);
  }
  return { name: short(name), node: i, parent, t, q };
});

// --- sample the clips -------------------------------------------------------

function track(anim, node, path) {
  const ch = anim.channels.find((c) => c.target.node === node && c.target.path === path);
  if (!ch) return null;
  const s = anim.samplers[ch.sampler];
  if (s.interpolation !== 'LINEAR') throw new Error('only LINEAR tracks are handled');
  return { times: accessor(s.input), values: accessor(s.output) };
}

function sampleQ(tr, t, out) {
  const { times, values } = tr;
  let i = 0;
  while (i < times.length - 2 && times[i + 1] <= t) i++;
  const span = times[i + 1] - times[i];
  const k = span > 0 ? THREE.MathUtils.clamp((t - times[i]) / span, 0, 1) : 0;
  const a = new THREE.Quaternion().fromArray(values, i * 4);
  const b = new THREE.Quaternion().fromArray(values, (i + 1) * 4);
  return out.copy(a).slerp(b, k);
}

function sampleV(tr, t, out) {
  const { times, values } = tr;
  let i = 0;
  while (i < times.length - 2 && times[i + 1] <= t) i++;
  const span = times[i + 1] - times[i];
  const k = span > 0 ? THREE.MathUtils.clamp((t - times[i]) / span, 0, 1) : 0;
  return out.fromArray(values, i * 3).lerp(new THREE.Vector3().fromArray(values, (i + 1) * 3), k);
}

/** World positions of every kept bone for one pose (local rotations + hips position). */
function worldPositions(quats, hips) {
  const mats = [];
  return bones.map((b, i) => {
    const m = new THREE.Matrix4().compose(i === 0 ? hips : b.t, quats[i], new THREE.Vector3(1, 1, 1));
    if (b.parent >= 0) m.premultiply(mats[b.parent]);
    mats[i] = m;
    return new THREE.Vector3().setFromMatrixPosition(m);
  });
}

const HIPS_SCALE = 8192; // int16 per metre: ±4 m, 0.12 mm steps
const packed = [];
const clipMeta = [];
let offset = 0;

for (const [source, name, fps, loop, travels] of CLIPS) {
  const anim = gltf.animations.find((a) => a.name === source);
  if (!anim) throw new Error(`clip ${source} missing`);
  const duration = Math.max(...anim.samplers.map((s) => gltf.accessors[s.input].max[0]));
  // a loop's last key repeats its first, so it is left out; a one-shot keeps its last pose
  const frames = loop ? Math.round(duration * fps) : Math.round(duration * fps) + 1;
  const tracks = bones.map((b) => ({ q: track(anim, b.node, 'rotation'), t: track(anim, b.node, 'translation') }));
  const poses = [];
  const data = new Int16Array(frames * (3 + bones.length * 4));
  let p = 0;
  const prev = bones.map(() => new THREE.Quaternion());
  for (let f = 0; f < frames; f++) {
    const time = Math.min(duration, (f / (loop ? frames : frames - 1)) * duration);
    const hips = tracks[0].t ? sampleV(tracks[0].t, time, new THREE.Vector3()) : gltf.nodes[bones[0].node].translation;
    hips.applyQuaternion(rootQ);
    for (const c of [hips.x, hips.y, hips.z]) data[p++] = Math.round(c * HIPS_SCALE);
    const quats = bones.map((b, i) => {
      const q = tracks[i].q ? sampleQ(tracks[i].q, time, new THREE.Quaternion()) : restQ(gltf.nodes[b.node]);
      if (b.parent < 0) q.premultiply(rootQ);
      q.normalize();
      // keep each bone on one side of the sphere so neighbouring frames blend the short way
      if (f > 0 && q.dot(prev[i]) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev[i].copy(q);
      for (const c of [q.x, q.y, q.z, q.w]) data[p++] = Math.round(c * 32767);
      return q;
    });
    poses.push(worldPositions(quats, hips));
  }
  const meta = { name, fps, frames, loop, offset, duration: +duration.toFixed(4) };
  if (travels) Object.assign(meta, measureGait(poses, duration));
  clipMeta.push(meta);
  packed.push(data);
  offset += data.length;
}

/**
 * How far a cycle carries the walker, and where in the cycle the left foot lands.
 * The clips walk on the spot, so a planted foot slides backwards at walking speed.
 */
function measureGait(poses, duration) {
  const n = poses.length;
  const foot = [BONES.indexOf('DEF-foot.L'), BONES.indexOf('DEF-foot.R')];
  const toe = [BONES.indexOf('DEF-toe.L'), BONES.indexOf('DEF-toe.R')];
  const low = (b) => Math.min(...poses.map((pose) => pose[b].y));
  let slide = 0;
  let count = 0;
  for (let s = 0; s < 2; s++) {
    const toeLow = low(toe[s]);
    for (let f = 0; f < n; f++) {
      const a = poses[f][toe[s]];
      const b = poses[(f + 1) % n][toe[s]];
      // the ball of the foot is on the ground at both ends of this frame
      if (a.y < toeLow + 0.012 && b.y < toeLow + 0.012) {
        slide += a.z - b.z;
        count++;
      }
    }
  }
  const speed = (slide / count) * (n / duration);
  // the left foot lands on the first frame its heel or its toe is down
  const down = (f) => Math.min(poses[f][foot[0]].y - low(foot[0]), poses[f][toe[0]].y - low(toe[0])) < 0.015;
  let strike = 0;
  for (let f = 0; f < n; f++) if (down(f) && !down((f + n - 1) % n) && poses[f][foot[0]].z > poses[f][0].z) strike = f;
  return { speed: +speed.toFixed(3), stride: +(speed * duration).toFixed(3), strike: +(strike / n).toFixed(4) };
}

// --- write ------------------------------------------------------------------

const all = new Int16Array(offset);
let at = 0;
for (const d of packed) {
  all.set(d, at);
  at += d.length;
}
const b64 = Buffer.from(all.buffer).toString('base64');
const num = (v) => +v.toFixed(5);
const lines = [
  '// GENERATED by scripts/pack-people.mjs. Do not edit by hand.',
  '// Skeleton and clips from the Universal Animation Library by Quaternius (CC0), see ASSETS.md.',
  '',
  '/** Bones, parents first: name, parent index, rest translation and rotation (in the parent). */',
  `export const RIG_BONES: [string, number, number[], number[]][] = [`,
  ...bones.map((b) => `  [${JSON.stringify(b.name)}, ${b.parent}, [${b.t.toArray().map(num)}], [${b.q.toArray().map(num)}]],`),
  '];',
  '',
  '/** One clip: frames of (hips x, y, z, then a quaternion per bone) as int16, starting at `offset`. */',
  'export interface ClipInfo {',
  '  name: string;',
  '  fps: number;',
  '  frames: number;',
  '  loop: boolean;',
  '  offset: number;',
  '  duration: number;',
  '  /** Walking clips: the speed the clip was animated for (m/s), metres per cycle, and the phase at which the left foot lands. */',
  '  speed?: number;',
  '  stride?: number;',
  '  strike?: number;',
  '}',
  `export const RIG_CLIPS: ClipInfo[] = ${JSON.stringify(clipMeta, null, 2)};`,
  '',
  `export const RIG_HIPS_SCALE = ${HIPS_SCALE};`,
  '',
  '/** The frames, little-endian int16, base64. */',
  `export const RIG_FRAMES =`,
  ...b64.match(/.{1,120}/g).map((s, i, a) => `  '${s}'${i === a.length - 1 ? ';' : ' +'}`),
  '',
];
const out = join(root, 'src', 'people', 'rigdata.ts');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n'));
console.log(`${out}: ${bones.length} bones, ${clipMeta.length} clips, ${(all.byteLength / 1024).toFixed(0)} kB of frames`);
for (const c of clipMeta) console.log(`  ${c.name.padEnd(7)} ${String(c.frames).padStart(3)} frames @${c.fps}  ${c.speed ? `${c.speed} m/s, stride ${c.stride} m, strike ${c.strike}` : ''}`);
