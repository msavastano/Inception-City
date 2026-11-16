import { ClipInfo, RIG_BONES, RIG_CLIPS, RIG_FRAMES, RIG_HIPS_SCALE } from './rigdata';

/**
 * The skeleton everyone in the dream shares, and the clips that move it.
 *
 * 22 bones (no fingers), rest pose a T with the arms along ±x, +y up, facing +z,
 * feet at the origin, about 1.83 m tall. Clips are frames of local rotations plus
 * the hips' position; walking clips walk on the spot and start as the left foot
 * lands. Everything here is plain arrays and has no dependency on three.js, so the
 * same code poses the dreamer's bones each frame and bakes the crowd's bone texture.
 *
 * Matrices are 3 x 4 (rotation and translation), stored row by row in 12 floats.
 */

export const BONE_NAMES = RIG_BONES.map((b) => b[0]);
export const BONE_COUNT = RIG_BONES.length;
export const BONE_PARENT = RIG_BONES.map((b) => b[1]);
const REST_T = RIG_BONES.map((b) => b[2]);
const REST_Q = RIG_BONES.map((b) => b[3]);

export type BoneName =
  | 'hips'
  | 'spine1'
  | 'spine2'
  | 'spine3'
  | 'neck'
  | 'head'
  | 'shoulderL'
  | 'upperarmL'
  | 'forearmL'
  | 'handL'
  | 'shoulderR'
  | 'upperarmR'
  | 'forearmR'
  | 'handR'
  | 'thighL'
  | 'shinL'
  | 'footL'
  | 'toeL'
  | 'thighR'
  | 'shinR'
  | 'footR'
  | 'toeR';

export function bone(name: BoneName): number {
  const i = BONE_NAMES.indexOf(name);
  if (i < 0) throw new Error(`no bone called ${name}`);
  return i;
}

export type ClipName = 'idle' | 'talk' | 'walk' | 'stroll' | 'jog' | 'sprint' | 'air' | 'land' | 'hit' | 'pick' | 'jab';

export function clip(name: ClipName): ClipInfo {
  const c = RIG_CLIPS.find((k) => k.name === name);
  if (!c) throw new Error(`no clip called ${name}`);
  return c;
}

export const CLIPS = RIG_CLIPS;

/** A pose: one local rotation per bone and where the hips are. */
export interface Pose {
  q: Float32Array;
  hips: Float32Array;
}

export function newPose(): Pose {
  return { q: new Float32Array(BONE_COUNT * 4), hips: new Float32Array(3) };
}

export function restPose(out = newPose()): Pose {
  for (let b = 0; b < BONE_COUNT; b++) out.q.set(REST_Q[b], b * 4);
  out.hips.set(REST_T[0]);
  return out;
}

let frames: Int16Array | null = null;
function frameData(): Int16Array {
  if (frames) return frames;
  const bin = atob(RIG_FRAMES);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  frames = new Int16Array(bytes.buffer);
  return frames;
}

const PER_FRAME = 3 + BONE_COUNT * 4;

/**
 * Sample a clip. `u` is the phase of a loop (any number; it wraps) or how far
 * through a one-shot (clamped to 0..1). Neighbouring frames are blended.
 */
export function samplePose(c: ClipInfo, u: number, out: Pose): Pose {
  const data = frameData();
  let f: number;
  let i0: number;
  let i1: number;
  if (c.loop) {
    f = (u - Math.floor(u)) * c.frames;
    i0 = Math.floor(f) % c.frames;
    i1 = (i0 + 1) % c.frames;
  } else {
    f = Math.min(1, Math.max(0, u)) * (c.frames - 1);
    i0 = Math.min(c.frames - 1, Math.floor(f));
    i1 = Math.min(c.frames - 1, i0 + 1);
  }
  const k = f - Math.floor(f);
  const a = c.offset + i0 * PER_FRAME;
  const b = c.offset + i1 * PER_FRAME;
  for (let j = 0; j < 3; j++) out.hips[j] = (data[a + j] + (data[b + j] - data[a + j]) * k) / RIG_HIPS_SCALE;
  const q = out.q;
  for (let n = 0; n < BONE_COUNT; n++) {
    const pa = a + 3 + n * 4;
    const pb = b + 3 + n * 4;
    let dot = 0;
    for (let j = 0; j < 4; j++) dot += data[pa + j] * data[pb + j];
    const s = dot < 0 ? -k : k;
    let len = 0;
    for (let j = 0; j < 4; j++) {
      const v = data[pa + j] * (1 - k) + data[pb + j] * s;
      q[n * 4 + j] = v;
      len += v * v;
    }
    len = 1 / Math.sqrt(len);
    for (let j = 0; j < 4; j++) q[n * 4 + j] *= len;
  }
  return out;
}

/** Move a pose towards another by w (0 keeps `into`, 1 takes `other`). Bones blend the short way round. */
export function blendPose(into: Pose, other: Pose, w: number): Pose {
  if (w <= 0) return into;
  const a = into.q;
  const b = other.q;
  for (let n = 0; n < BONE_COUNT; n++) {
    const o = n * 4;
    const dot = a[o] * b[o] + a[o + 1] * b[o + 1] + a[o + 2] * b[o + 2] + a[o + 3] * b[o + 3];
    const s = dot < 0 ? -w : w;
    let len = 0;
    for (let j = 0; j < 4; j++) {
      const v = a[o + j] * (1 - w) + b[o + j] * s;
      a[o + j] = v;
      len += v * v;
    }
    len = 1 / Math.sqrt(len);
    for (let j = 0; j < 4; j++) a[o + j] *= len;
  }
  for (let j = 0; j < 3; j++) into.hips[j] += (other.hips[j] - into.hips[j]) * w;
  return into;
}

/** Turn one bone by an extra rotation (a quaternion x, y, z, w) in its parent's frame, as a head turns on a neck. */
export function turnBone(pose: Pose, b: number, x: number, y: number, z: number, w: number): void {
  const q = pose.q;
  const o = b * 4;
  const bx = q[o];
  const by = q[o + 1];
  const bz = q[o + 2];
  const bw = q[o + 3];
  q[o] = w * bx + x * bw + y * bz - z * by;
  q[o + 1] = w * by - x * bz + y * bw + z * bx;
  q[o + 2] = w * bz + x * by - y * bx + z * bw;
  q[o + 3] = w * bw - x * bx - y * by - z * bz;
}

/**
 * Turn one bone by a rotation given in the body's own frame (+y up, +z ahead),
 * whatever way the bones above it are pointing: the way to turn a head to look left.
 */
export function turnInBody(pose: Pose, b: number, x: number, y: number, z: number, w: number): void {
  // the parent's rotation in the body's frame: the chain of rotations above this bone
  const chain: number[] = [];
  for (let p = BONE_PARENT[b]; p >= 0; p = BONE_PARENT[p]) chain.unshift(p);
  let px = 0;
  let py = 0;
  let pz = 0;
  let pw = 1;
  const q = pose.q;
  for (const n of chain) {
    const o = n * 4;
    const [ax, ay, az, aw] = [px, py, pz, pw];
    const [bx, by, bz, bw] = [q[o], q[o + 1], q[o + 2], q[o + 3]];
    px = aw * bx + ax * bw + ay * bz - az * by;
    py = aw * by - ax * bz + ay * bw + az * bx;
    pz = aw * bz + ax * by - ay * bx + az * bw;
    pw = aw * bw - ax * bx - ay * by - az * bz;
  }
  // P^-1 R P, the same turn seen from the parent's frame
  const mul = (a: number[], c: number[]): number[] => [
    a[3] * c[0] + a[0] * c[3] + a[1] * c[2] - a[2] * c[1],
    a[3] * c[1] - a[0] * c[2] + a[1] * c[3] + a[2] * c[0],
    a[3] * c[2] + a[0] * c[1] - a[1] * c[0] + a[2] * c[3],
    a[3] * c[3] - a[0] * c[0] - a[1] * c[1] - a[2] * c[2],
  ];
  const r = mul(mul([-px, -py, -pz, pw], [x, y, z, w]), [px, py, pz, pw]);
  turnBone(pose, b, r[0], r[1], r[2], r[3]);
}

/** Each bone's matrix in the body's frame (12 floats a bone), from a pose. */
export function worldMatrices(pose: Pose, out: Float32Array): Float32Array {
  for (let b = 0; b < BONE_COUNT; b++) {
    const o = b * 4;
    const x = pose.q[o];
    const y = pose.q[o + 1];
    const z = pose.q[o + 2];
    const w = pose.q[o + 3];
    const t = b === 0 ? pose.hips : REST_T[b];
    // local matrix rows
    const l0 = 1 - 2 * (y * y + z * z);
    const l1 = 2 * (x * y - z * w);
    const l2 = 2 * (x * z + y * w);
    const l4 = 2 * (x * y + z * w);
    const l5 = 1 - 2 * (x * x + z * z);
    const l6 = 2 * (y * z - x * w);
    const l8 = 2 * (x * z - y * w);
    const l9 = 2 * (y * z + x * w);
    const l10 = 1 - 2 * (x * x + y * y);
    const m = b * 12;
    const p = BONE_PARENT[b];
    if (p < 0) {
      out[m] = l0;
      out[m + 1] = l1;
      out[m + 2] = l2;
      out[m + 3] = t[0];
      out[m + 4] = l4;
      out[m + 5] = l5;
      out[m + 6] = l6;
      out[m + 7] = t[1];
      out[m + 8] = l8;
      out[m + 9] = l9;
      out[m + 10] = l10;
      out[m + 11] = t[2];
      continue;
    }
    const pm = p * 12;
    for (let r = 0; r < 3; r++) {
      const a = out[pm + r * 4];
      const bb = out[pm + r * 4 + 1];
      const c = out[pm + r * 4 + 2];
      out[m + r * 4] = a * l0 + bb * l4 + c * l8;
      out[m + r * 4 + 1] = a * l1 + bb * l5 + c * l9;
      out[m + r * 4 + 2] = a * l2 + bb * l6 + c * l10;
      out[m + r * 4 + 3] = a * t[0] + bb * t[1] + c * t[2] + out[pm + r * 4 + 3];
    }
  }
  return out;
}

const REST_WORLD = worldMatrices(restPose(), new Float32Array(BONE_COUNT * 12));

/** Where each joint is in the rest pose (x, y, z). */
export function restJoint(name: BoneName): [number, number, number] {
  const m = bone(name) * 12;
  return [REST_WORLD[m + 3], REST_WORLD[m + 7], REST_WORLD[m + 11]];
}

/** The rest pose's bone matrices (the bind pose), 12 floats a bone. */
export function restMatrices(): Float32Array {
  return REST_WORLD;
}

/** Inverse of the rest matrices: takes a rest-pose point into each bone's own frame. */
const REST_INVERSE = (() => {
  const inv = new Float32Array(BONE_COUNT * 12);
  for (let b = 0; b < BONE_COUNT; b++) {
    const m = b * 12;
    // rigid: inverse rotation is the transpose
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) inv[m + r * 4 + c] = REST_WORLD[m + c * 4 + r];
    for (let r = 0; r < 3; r++) {
      inv[m + r * 4 + 3] = -(inv[m + r * 4] * REST_WORLD[m + 3] + inv[m + r * 4 + 1] * REST_WORLD[m + 7] + inv[m + r * 4 + 2] * REST_WORLD[m + 11]);
    }
  }
  return inv;
})();

/**
 * Skinning matrices: where a rest-pose point attached to each bone ends up in
 * this pose. `world` comes from worldMatrices(); 12 floats a bone.
 */
export function skinMatrices(world: Float32Array, out: Float32Array): Float32Array {
  for (let b = 0; b < BONE_COUNT; b++) {
    const m = b * 12;
    for (let r = 0; r < 3; r++) {
      const a = world[m + r * 4];
      const bb = world[m + r * 4 + 1];
      const c = world[m + r * 4 + 2];
      out[m + r * 4] = a * REST_INVERSE[m] + bb * REST_INVERSE[m + 4] + c * REST_INVERSE[m + 8];
      out[m + r * 4 + 1] = a * REST_INVERSE[m + 1] + bb * REST_INVERSE[m + 5] + c * REST_INVERSE[m + 9];
      out[m + r * 4 + 2] = a * REST_INVERSE[m + 2] + bb * REST_INVERSE[m + 6] + c * REST_INVERSE[m + 10];
      out[m + r * 4 + 3] = a * REST_INVERSE[m + 3] + bb * REST_INVERSE[m + 7] + c * REST_INVERSE[m + 11] + world[m + r * 4 + 3];
    }
  }
  return out;
}

/** The rest translation of a bone in its parent, and its rest rotation (for building three.js bones). */
export function restLocal(b: number): { t: number[]; q: number[] } {
  return { t: REST_T[b], q: REST_Q[b] };
}

// --- gait ---------------------------------------------------------------------

/** The walking clips, slowest first, with the ground speed each was animated for. */
const GAITS = (['stroll', 'jog', 'sprint'] as ClipName[]).map((n) => clip(n));

/**
 * Metres covered by one cycle (two steps) at a ground speed. Below the stroll's
 * own pace the steps stay the stroll's length; between clips the stride is the
 * blend of theirs; past the sprint it lengthens a little more.
 */
export function strideAt(speed: number): number {
  const g = GAITS;
  if (speed <= g[0].speed!) return g[0].stride!;
  for (let i = 0; i < g.length - 1; i++) {
    if (speed <= g[i + 1].speed!) {
      const k = (speed - g[i].speed!) / (g[i + 1].speed! - g[i].speed!);
      return g[i].stride! + (g[i + 1].stride! - g[i].stride!) * k;
    }
  }
  const last = g[g.length - 1];
  return last.stride! + (speed - last.speed!) * 0.3;
}

/**
 * Which walking clips to mix at a ground speed, and how much of each:
 * [stroll, jog, sprint], adding up to one. All three share a phase (they all
 * start as the left foot lands), so they can be blended frame for frame.
 */
export function gaitWeights(speed: number): [number, number, number] {
  const g = GAITS;
  if (speed <= g[0].speed!) return [1, 0, 0];
  if (speed <= g[1].speed!) {
    // out of the stroll early: by 3.5 m/s it is all jog (a walk stretched to a run looks like a march)
    const k = Math.min(1, (speed - g[0].speed!) / (3.5 - g[0].speed!));
    const e = k * k * (3 - 2 * k);
    return [1 - e, e, 0];
  }
  const k = Math.min(1, (speed - g[1].speed!) / (g[2].speed! - g[1].speed!));
  return [0, 1 - k, k];
}

export const GAIT_CLIPS = GAITS;
