import * as THREE from 'three';
import { COLLAPSE_RADIUS } from '../core/config';
import { rng } from '../core/rng';
import { Style } from '../city/generator';
import { shardGeometry } from '../city/geometry';
import { U, foldedDepthMaterial, foldedMaterial } from '../city/materials';
import type { BuildingBox } from '../city/streamer';

/**
 * THE CAFÉ EXPLOSION
 *
 * When stability hits zero the dream comes apart around the dreamer, the way
 * the café street does in the film: a blast wave runs out through the walls,
 * cracking them into cells and blowing pieces outward, and then everything
 * hangs in the air in slow motion until the kick arrives.
 *
 * Two halves, kept in step by the same numbers:
 * - the building shader (blastWall() in src/city/shaders.ts) cracks the walls
 *   and opens the blown-out cells onto the rooms behind them;
 * - this file throws instanced shards off the same walls, at the same moments.
 *
 * Shards live on their own clock, which runs at the dream's slowed speed. The
 * dreamer keeps real time, so you can walk among the debris while it hangs there.
 */

/** Real seconds from the blast to the kick. */
export const KICK_AT = 4.2;
/** How fast the dream runs while the city hangs in the air (1 is real time). */
export const SLOW_MOTION = 0.16;
/** How fast the blast runs out through the walls, in metres per second of shard clock. */
export const WAVE_SPEED = 140;
/** After the kick: how long the shards take to vanish and the walls to heal (real seconds). */
export const HEAL = 1.2;
/** Gravity on the shards, per second of shard clock. */
export const GRAVITY = 9.8;
/** Walls above this height shed no shards: from the street nobody would see them. */
export const SHARD_CEILING = 48;

/** The dream's speed t real seconds after the blast: a moment at full speed, then slow motion. */
export function slowMotion(t: number): number {
  return 1 + (SLOW_MOTION - 1) * THREE.MathUtils.smoothstep(t, 0.12, 0.7);
}

/** Chance that a cell of wall this far from the blast is blown out (blastWall() uses the same curve). */
export function breakChance(dist: number): number {
  return 0.45 * (1 - THREE.MathUtils.smoothstep(dist, COLLAPSE_RADIUS * 0.4, COLLAPSE_RADIUS));
}

/** Instance attributes and their sizes, as SHARD_VERT_HEAD declares them. */
const ATTRS = { aOrigin: 4, aVel: 4, aSpin: 4, aShape: 4, aTint: 4, aSink: 1 } as const;
type AttrName = keyof typeof ATTRS;

export type ShardPlan = { count: number } & Record<AttrName, Float32Array>;

/** Share of the pieces that are window glass, by facade style. */
const GLASS_SHARE: Partial<Record<Style, number>> = {
  [Style.Haussmann]: 0.28,
  [Style.Glass]: 0.75,
  [Style.Concrete]: 0.35,
  [Style.Brick]: 0.22,
};
/** Shopfront awnings (the café level of a Haussmann block), as the facade shader paints them. */
const AWNINGS: [number, number, number][] = [
  [0.55, 0.12, 0.1],
  [0.1, 0.3, 0.2],
  [0.12, 0.16, 0.32],
];
const SHOP_HEIGHT = 4.6;

interface Wall {
  b: BuildingBox;
  /** Outward normal and the direction along the wall. */
  nx: number;
  nz: number;
  tx: number;
  tz: number;
  /** Centre of the wall's base line, its length and the band of height that sheds shards. */
  px: number;
  pz: number;
  len: number;
  y0: number;
  y1: number;
  /** Break chance at the wall's nearest point to the blast (the most any point of it gets). */
  chance: number;
}

/**
 * Choose up to `budget` pieces of wall around (cx, cz) to blow out, spread like
 * the shader's holes: denser near the blast, on walls that face it, and never
 * from a wall pressed against a neighbour. Pure, so it can be tested.
 */
export function planShards(buildings: readonly BuildingBox[], cx: number, cz: number, budget: number, seed: number): ShardPlan {
  const R = COLLAPSE_RADIUS;
  const plan = { count: 0 } as ShardPlan;
  for (const [name, size] of Object.entries(ATTRS)) plan[name as AttrName] = new Float32Array(budget * size);
  const rand = rng(seed);

  // Exposure test: a point just outside a wall must not be inside another building.
  const CELL = 16;
  const grid = new Map<string, number[]>();
  buildings.forEach((b, i) => {
    for (let gx = Math.floor((b.x - b.w / 2) / CELL); gx <= Math.floor((b.x + b.w / 2) / CELL); gx++) {
      for (let gz = Math.floor((b.z - b.d / 2) / CELL); gz <= Math.floor((b.z + b.d / 2) / CELL); gz++) {
        const k = `${gx},${gz}`;
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  });
  const blocked = (x: number, y: number, z: number): boolean => {
    for (const i of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
      const b = buildings[i];
      if (Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2 && y >= b.y0 && y < b.y1) return true;
    }
    return false;
  };

  const walls: Wall[] = [];
  const weights: number[] = [];
  let total = 0;
  for (const b of buildings) {
    const y0 = b.y0;
    const y1 = Math.min(b.y1, SHARD_CEILING);
    if (y1 - y0 < 0.5) continue;
    for (const [nx, nz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const tx = -nz;
      const tz = nx;
      const px = b.x + (nx * b.w) / 2;
      const pz = b.z + (nz * b.d) / 2;
      const len = nx !== 0 ? b.d : b.w;
      const along = THREE.MathUtils.clamp((cx - px) * tx + (cz - pz) * tz, -len / 2, len / 2);
      const qx = px + tx * along - cx;
      const qz = pz + tz * along - cz;
      const dist = Math.hypot(qx, qz);
      const chance = breakChance(dist);
      if (chance <= 0) continue;
      // walls facing the blast (and the street it is in) get most of the pieces
      const facing = -(qx * nx + qz * nz) > 0 ? 1 : 0.25;
      walls.push({ b, nx, nz, tx, tz, px, pz, len, y0, y1, chance });
      total += len * (y1 - y0) * facing * chance;
      weights.push(total);
    }
  }
  if (total <= 0) return plan;

  let n = 0;
  for (let tries = 0; n < budget && tries < budget * 8; tries++) {
    const pick = rand() * total;
    let lo = 0;
    let hi = weights.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (weights[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    const w = walls[lo];
    const along = (rand() - 0.5) * w.len;
    const y = w.y0 + rand() * (w.y1 - w.y0);
    const x = w.px + w.tx * along;
    const z = w.pz + w.tz * along;
    const dist = Math.hypot(x - cx, z - cz);
    const chance = breakChance(dist);
    // thin out with distance exactly as the holes do
    if (rand() * w.chance >= chance) continue;
    if (blocked(x + w.nx * 0.6, y, z + w.nz * 0.6)) continue;

    const b = w.b;
    const glass = rand() < (GLASS_SHARE[b.style] ?? 0.25) ? 1 : 0;
    const r = rand();
    const size = glass ? 0.15 + 0.6 * Math.pow(r, 1.5) : 0.25 + 1.25 * Math.pow(r, 2.2);
    const sx = size * (0.75 + 0.5 * rand());
    const sy = size * (0.6 + 0.5 * rand());
    const sz = glass ? 0.035 : size * (0.22 + 0.2 * rand());

    // A cell's hash decides both whether it breaks (below the chance) and how
    // late the wave reaches it, so the shards leave as the holes open.
    const h = rand() * chance;
    const t0 = (dist + h * 10) / WAVE_SPEED;

    const speed = 5 + 14 * rand();
    const side = (rand() - 0.5) * 6;
    const lift = -1 + 7 * rand();
    const push = (3 * (1 - dist / R)) / Math.max(dist, 1);
    let ax = rand() * 2 - 1;
    let ay = rand() * 2 - 1;
    let az = rand() * 2 - 1;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const spin = (0.5 + 4.5 * rand()) * (rand() < 0.5 ? -1 : 1);

    let tint: [number, number, number] = b.color;
    const k = 0.85 + 0.25 * rand();
    if (b.style === Style.Haussmann && y < SHOP_HEIGHT && rand() < 0.35) tint = AWNINGS[Math.floor(rand() * AWNINGS.length) % AWNINGS.length];
    else if (b.style === Style.Glass) tint = [b.color[0] * 0.55, b.color[1] * 0.55, b.color[2] * 0.55];
    else tint = [Math.min(1, tint[0] * k), Math.min(1, tint[1] * k), Math.min(1, tint[2] * k)];

    plan.aOrigin.set([x + w.nx * (sz / 2 + 0.05), y, z + w.nz * (sz / 2 + 0.05), t0], n * 4);
    plan.aVel.set(
      [w.nx * speed + w.tx * side + (x - cx) * push, lift, w.nz * speed + w.tz * side + (z - cz) * push, spin],
      n * 4,
    );
    plan.aSpin.set([ax, ay, az, Math.atan2(w.nx, w.nz)], n * 4);
    plan.aShape.set([sx, sy, sz, glass], n * 4);
    plan.aTint.set([tint[0], tint[1], tint[2], b.seed], n * 4);
    plan.aSink[n] = b.sink;
    n++;
  }
  plan.count = n;
  return plan;
}

type Phase = 'idle' | 'blast' | 'release';

/**
 * Runs one collapse: the blast, the slow motion and, after the kick, the shards
 * vanishing and the walls healing. The app asks it for the dream's time scale
 * each frame, and kicks when update() says so.
 */
export class Collapse {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.InstancedBufferGeometry();
  private attrs = {} as Record<AttrName, THREE.InstancedBufferAttribute>;
  private phase: Phase = 'idle';
  /** Real seconds since the blast, and since the kick. */
  private t = 0;
  private rt = 0;
  /** The shards' clock: runs at the dream's speed. */
  private clock = 0;
  private releasedAt = 1;
  /** How fast the dream runs this frame (1 is real time). */
  timeScale = 1;

  constructor(readonly capacity: number) {
    const base = shardGeometry();
    for (const [name, attr] of Object.entries(base.attributes)) this.geometry.setAttribute(name, attr);
    for (const [name, size] of Object.entries(ATTRS)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      this.attrs[name as AttrName] = a;
      this.geometry.setAttribute(name, a);
    }
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, foldedMaterial('shard'));
    this.mesh.customDepthMaterial = foldedDepthMaterial('shard');
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Anything showing (the blast, or the healing after the kick). */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** Between the blast and the kick. */
  get blasting(): boolean {
    return this.phase === 'blast';
  }

  /** Blow the walls out around fabric point (x, z). */
  start(x: number, z: number, plan: ShardPlan): void {
    const count = Math.min(plan.count, this.capacity);
    for (const [name, size] of Object.entries(ATTRS)) {
      const a = this.attrs[name as AttrName];
      (a.array as Float32Array).set(plan[name as AttrName].subarray(0, count * size));
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * size);
      a.needsUpdate = true;
    }
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    this.phase = 'blast';
    this.t = 0;
    this.rt = 0;
    this.clock = 0;
    U.uBlast.value.set(x, z, 0, 1);
    U.uShatter.value.set(0, 1, GRAVITY, 0);
  }

  /** The kick has come: let the debris go and the walls heal. */
  release(): void {
    if (this.phase !== 'blast') return;
    this.phase = 'release';
    this.rt = 0;
    this.releasedAt = this.timeScale;
  }

  /** Gone at once (a new city). */
  stop(): void {
    this.phase = 'idle';
    this.timeScale = 1;
    this.mesh.visible = false;
    this.geometry.instanceCount = 0;
    U.uBlast.value.w = 0;
    U.uShatter.value.y = 0;
  }

  /** Advance by dt real seconds. Returns true when it is time for the kick. */
  update(dt: number): boolean {
    if (this.phase === 'idle') {
      this.timeScale = 1;
      return false;
    }
    let kick = false;
    if (this.phase === 'blast') {
      this.t += dt;
      this.timeScale = slowMotion(this.t);
      kick = this.t >= KICK_AT;
    } else {
      this.rt += dt;
      if (this.rt >= HEAL) {
        this.stop();
        return false;
      }
      this.timeScale = THREE.MathUtils.lerp(this.releasedAt, 1, THREE.MathUtils.smoothstep(this.rt, 0, 0.5));
      U.uBlast.value.w = 1 - THREE.MathUtils.smoothstep(this.rt, 0.1, HEAL);
      U.uShatter.value.y = 1 - THREE.MathUtils.smoothstep(this.rt, 0.2, HEAL);
    }
    this.clock += dt * this.timeScale;
    U.uShatter.value.x = this.clock;
    U.uBlast.value.z = WAVE_SPEED * this.clock;
    return kick;
  }
}
