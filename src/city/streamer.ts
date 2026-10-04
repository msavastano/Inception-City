import * as THREE from 'three';
import { CHUNK, GROUND_COARSE_SEGMENTS, GROUND_FINE_SEGMENTS, SLAB } from '../core/config';
import { Fold, FoldShape, foldPoint } from '../core/fold';
import { hash3 } from '../core/rng';
import { ChunkData, generateChunk } from './generator';
import { buildingGeometry, groundGeometry, lampGeometry, treeGeometry } from './geometry';
import { foldedDepthMaterial, foldedMaterial, pickMaterial } from './materials';
import { SlabPool } from './pool';

interface LoadedChunk {
  key: string;
  cx: number;
  cz: number;
  slot: number;
  data: ChunkData;
  fine: boolean;
  /** Detail ring: trees and street furniture are only kept on nearby chunks. */
  props: boolean;
  born: number;
}

const key = (cx: number, cz: number) => `${cx},${cz}`;

/**
 * Streams chunks in and out around the viewer.
 *
 * The trick: candidates are enumerated in *fabric* space, but whether a chunk
 * is needed is decided in *world* space, after folding. A flap of city hanging
 * overhead is far away on the sheet yet close to your eyes, and gets streamed in.
 */
export class CityStreamer {
  readonly group = new THREE.Group();
  readonly pickGroup = new THREE.Group();
  readonly buildingMaterial = foldedMaterial('building', { roughness: 0.88 });
  readonly groundMaterial = foldedMaterial('ground', { side: THREE.DoubleSide });
  readonly propMaterial = foldedMaterial('prop');
  readonly propDepth = foldedDepthMaterial('prop');

  readonly buildings: SlabPool;
  readonly roofs: SlabPool;
  readonly trees: SlabPool;
  readonly lamps: SlabPool;
  readonly groundFine: SlabPool;
  readonly groundCoarse: SlabPool;

  readonly loaded = new Map<string, LoadedChunk>();
  private cache = new Map<string, ChunkData>();
  /** Architect brush edits: building height multipliers, keyed "cx,cz,index". */
  readonly edits = new Map<string, number>();
  private lastUpdate = -1;
  /** Runtime cap on streamed chunks (quality setting), at most maxChunks. */
  limit = Infinity;

  constructor(
    public seed: number,
    readonly maxChunks: number,
  ) {
    const bDepth = foldedDepthMaterial('building');
    const gDepth = foldedDepthMaterial('ground');
    const bAttrs = { iPos: 4, iSize: 4, iColor: 4, iAnim: 2 };
    const pAttrs = { iPosYaw: 4, iParam: 4, iState: 4 };
    const gAttrs = { iChunk: 4, iKinds: 4 };

    this.buildings = new SlabPool(buildingGeometry(6), bAttrs, SLAB.building, maxChunks, this.buildingMaterial);
    this.roofs = new SlabPool(buildingGeometry(1), bAttrs, SLAB.roof, maxChunks, this.buildingMaterial);
    this.trees = new SlabPool(treeGeometry(), pAttrs, SLAB.tree, maxChunks, this.propMaterial);
    this.lamps = new SlabPool(lampGeometry(), pAttrs, SLAB.lamp, maxChunks, this.propMaterial);
    this.groundFine = new SlabPool(groundGeometry(GROUND_FINE_SEGMENTS), gAttrs, 1, maxChunks, this.groundMaterial);
    this.groundCoarse = new SlabPool(groundGeometry(GROUND_COARSE_SEGMENTS), gAttrs, 1, maxChunks, this.groundMaterial);

    for (const [pool, depth, cast] of [
      [this.buildings, bDepth, true],
      [this.roofs, bDepth, true],
      [this.trees, this.propDepth, true],
      [this.lamps, this.propDepth, false],
      [this.groundFine, gDepth, true],
      [this.groundCoarse, gDepth, true],
    ] as const) {
      pool.mesh.customDepthMaterial = depth;
      pool.mesh.castShadow = cast;
      pool.mesh.receiveShadow = true;
      this.group.add(pool.mesh);
    }

    const bPick = pickMaterial('building', 2);
    const gPick = pickMaterial('ground', 1);
    for (const [pool, mat] of [
      [this.buildings, bPick],
      [this.roofs, bPick],
      [this.groundFine, gPick],
      [this.groundCoarse, gPick],
    ] as const) {
      const proxy = new THREE.Mesh(pool.geometry, mat);
      proxy.frustumCulled = false;
      this.pickGroup.add(proxy);
    }
  }

  get buildingCount(): number {
    let n = 0;
    for (const c of this.loaded.values()) n += c.data.buildings.length + c.data.roofs.length;
    return n;
  }

  /** Chunk data, from the live set or regenerated on demand (it is a pure function). */
  chunkData(cx: number, cz: number): ChunkData {
    const k = key(cx, cz);
    const live = this.loaded.get(k);
    if (live) return live.data;
    let d = this.cache.get(k);
    if (!d) {
      d = generateChunk(cx, cz, this.seed);
      this.cache.set(k, d);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    return d;
  }

  /** Drop everything (used when the dream is re-seeded). */
  resetAll(seed: number): void {
    for (const k of [...this.loaded.keys()]) this.unload(k);
    this.cache.clear();
    this.edits.clear();
    this.seed = seed;
    this.lastUpdate = -1;
  }

  update(
    camera: THREE.Vector3,
    focusX: number,
    focusZ: number,
    folds: readonly FoldShape[],
    allFolds: readonly Fold[],
    viewDist: number,
    propDist: number,
    now: number,
    force = false,
  ): void {
    if (!force && now - this.lastUpdate < 0.2) return;
    const first = this.lastUpdate < 0;
    this.lastUpdate = now;

    const fcx = Math.floor(focusX / CHUNK);
    const fcz = Math.floor(focusZ / CHUNK);
    const R = Math.ceil((viewDist * 1.6) / CHUNK) + 1;
    const p = new THREE.Vector3();
    const wanted: { cx: number; cz: number; dist: number }[] = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const cx = fcx + dx;
        const cz = fcz + dz;
        const mx = (cx + 0.5) * CHUNK;
        const mz = (cz + 0.5) * CHUNK;
        p.set(mx, 15, mz);
        foldPoint(folds, mx, mz, p);
        const dist = Math.max(0, p.distanceTo(camera) - CHUNK * 0.72);
        if (dist < viewDist) wanted.push({ cx, cz, dist });
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    const limit = Math.min(this.maxChunks, this.limit);
    const keep = new Set(wanted.slice(0, limit).map((w) => key(w.cx, w.cz)));
    const near = new Set(wanted.filter((w) => w.dist < propDist).map((w) => key(w.cx, w.cz)));

    for (const k of [...this.loaded.keys()]) if (!keep.has(k)) this.unload(k);

    let budget = first ? limit : 6;
    for (const w of wanted) {
      if (budget <= 0 || this.loaded.size >= limit) break;
      const k = key(w.cx, w.cz);
      if (this.loaded.has(k)) continue;
      this.load(w.cx, w.cz, now + (first ? 0.4 + w.dist / 500 : 0));
      budget--;
    }

    let propBudget = first ? limit : 8;
    for (const c of this.loaded.values()) {
      const fine = this.needsFine(c.cx, c.cz, allFolds);
      if (fine !== c.fine) this.writeGround(c, fine, -100);
      const want = near.has(c.key);
      if (want !== c.props && propBudget-- > 0) this.writeProps(c, want, want && c.born < now ? now : c.born);
    }
  }

  /** A ground tile needs tessellation only if a curl passes through it; elsewhere folds are rigid. */
  private needsFine(cx: number, cz: number, folds: readonly Fold[]): boolean {
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    for (const f of folds) {
      const L = f.radius * Math.max(Math.abs(f.angle), Math.abs(f.target)) + 4;
      if (L <= 4) continue;
      let dmin = Infinity;
      let dmax = -Infinity;
      for (const [x, z] of [
        [x0, z0],
        [x0 + CHUNK, z0],
        [x0, z0 + CHUNK],
        [x0 + CHUNK, z0 + CHUNK],
      ]) {
        const d = (x - f.hx) * f.nx + (z - f.hz) * f.nz;
        dmin = Math.min(dmin, d);
        dmax = Math.max(dmax, d);
      }
      if (dmax > -4 && dmin < L) return true;
    }
    return false;
  }

  private load(cx: number, cz: number, born: number): void {
    const data = this.chunkData(cx, cz);
    const slot = this.buildings.acquire();
    if (slot < 0) return;
    for (const pool of [this.roofs, this.trees, this.lamps]) pool.claim(slot);
    const chunk: LoadedChunk = { key: key(cx, cz), cx, cz, slot, data, fine: false, props: false, born };
    this.loaded.set(chunk.key, chunk);

    const grow = (i: number) => this.edits.get(`${cx},${cz},${i}`) ?? 1;
    const writeB = (pool: SlabPool, list: ChunkData['buildings']) => {
      list.forEach((b, i) => {
        const delay = born + hash3(cx * 31 + i, cz, 5) * 0.9;
        pool.set(slot, i, 'iPos', b.x, b.y, b.z, b.style);
        pool.set(slot, i, 'iSize', b.w, b.h, b.d, b.extra);
        pool.set(slot, i, 'iColor', b.color[0], b.color[1], b.color[2], b.parent >= 0 ? list[b.parent].seed : b.seed);
        pool.set(slot, i, 'iAnim', grow(b.parent >= 0 ? b.parent : i), delay);
      });
      pool.clearFrom(slot, list.length);
      pool.flush(slot);
    };
    writeB(this.buildings, data.buildings);
    // roofs reference their parent building's index
    data.roofs.forEach((r, i) => {
      const delay = born + hash3(cx * 31 + r.parent, cz, 5) * 0.9 + 0.3;
      this.roofs.set(slot, i, 'iPos', r.x, r.y, r.z, r.style);
      this.roofs.set(slot, i, 'iSize', r.w, r.h, r.d, r.extra);
      this.roofs.set(slot, i, 'iColor', r.color[0], r.color[1], r.color[2], data.buildings[r.parent].seed);
      this.roofs.set(slot, i, 'iAnim', grow(r.parent), delay);
    });
    this.roofs.clearFrom(slot, data.roofs.length);
    this.roofs.flush(slot);

    this.writeGround(chunk, false, born, true);
  }

  private writeProps(c: LoadedChunk, on: boolean, born: number): void {
    const writeP = (pool: SlabPool, list: ChunkData['trees'], kind: number) => {
      if (on) {
        list.forEach((t, i) => {
          pool.set(c.slot, i, 'iPosYaw', t.x, 0, t.z, t.yaw);
          pool.set(c.slot, i, 'iParam', t.scale, t.tone, born + hash3(i, c.cx, c.cz) * 1.2, 0);
          pool.set(c.slot, i, 'iState', 0, kind, 0, 0);
        });
      }
      pool.clearFrom(c.slot, on ? list.length : 0);
      pool.flush(c.slot);
    };
    writeP(this.trees, c.data.trees, 0);
    writeP(this.lamps, c.data.lamps, 1);
    c.props = on;
  }

  private writeGround(c: LoadedChunk, fine: boolean, born: number, initial = false): void {
    const from = fine ? this.groundCoarse : this.groundFine;
    const to = fine ? this.groundFine : this.groundCoarse;
    if (!initial) from.release(c.slot);
    to.claim(c.slot);
    const k = c.data.kinds;
    const packed = [0, 1, 2, 3].map((ch) => k[ch * 4] + k[ch * 4 + 1] * 16 + k[ch * 4 + 2] * 256 + k[ch * 4 + 3] * 4096);
    to.set(c.slot, 0, 'iChunk', c.cx * CHUNK, c.cz * CHUNK, born, 1);
    to.set(c.slot, 0, 'iKinds', packed[0], packed[1], packed[2], packed[3]);
    to.flush(c.slot);
    c.fine = fine;
  }

  private unload(k: string): void {
    const c = this.loaded.get(k);
    if (!c) return;
    for (const pool of [this.buildings, this.roofs, this.trees, this.lamps, this.groundFine, this.groundCoarse]) pool.release(c.slot);
    this.loaded.delete(k);
  }

  /**
   * First-person collision in fabric space: push a circle out of building
   * footprints and tree trunks. Folding never enters into it.
   */
  collide(x: number, z: number, r: number): { x: number; z: number } {
    for (let iter = 0; iter < 3; iter++) {
      const cx0 = Math.floor((x - r) / CHUNK);
      const cx1 = Math.floor((x + r) / CHUNK);
      const cz0 = Math.floor((z - r) / CHUNK);
      const cz1 = Math.floor((z + r) / CHUNK);
      let moved = false;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const d = this.chunkData(cx, cz);
          for (const b of d.rects) {
            if (x < b.x0 - r || x > b.x1 + r || z < b.z0 - r || z > b.z1 + r) continue;
            const px = Math.min(Math.max(x, b.x0), b.x1);
            const pz = Math.min(Math.max(z, b.z0), b.z1);
            const dx = x - px;
            const dz = z - pz;
            const d2 = dx * dx + dz * dz;
            if (d2 >= r * r) continue;
            if (d2 > 1e-8) {
              const dd = Math.sqrt(d2);
              x = px + (dx / dd) * r;
              z = pz + (dz / dd) * r;
            } else {
              const opts = [
                [b.x0 - r, z, x - b.x0],
                [b.x1 + r, z, b.x1 - x],
                [x, b.z0 - r, z - b.z0],
                [x, b.z1 + r, b.z1 - z],
              ].sort((a, c) => a[2] - c[2]);
              x = opts[0][0];
              z = opts[0][1];
            }
            moved = true;
          }
          for (const c of d.circles) {
            const dx = x - c.x;
            const dz = z - c.z;
            const rr = r + c.r;
            const d2 = dx * dx + dz * dz;
            if (d2 >= rr * rr || d2 < 1e-8) continue;
            const dd = Math.sqrt(d2);
            x = c.x + (dx / dd) * rr;
            z = c.z + (dz / dd) * rr;
            moved = true;
          }
        }
      }
      // the totem at the centre of the circus
      const tr = Math.hypot(x, z);
      if (tr < 11 + r && tr > 1e-6) {
        x = (x / tr) * (11 + r);
        z = (z / tr) * (11 + r);
        moved = true;
      }
      if (!moved) break;
    }
    return { x, z };
  }

  /** Architect brush: raise (amount > 0) or sink buildings around a fabric point. */
  brush(fx: number, fz: number, radius: number, amount: number): number {
    let touched = 0;
    for (const c of this.loaded.values()) {
      const x0 = c.cx * CHUNK;
      const z0 = c.cz * CHUNK;
      if (fx + radius < x0 || fx - radius > x0 + CHUNK || fz + radius < z0 || fz - radius > z0 + CHUNK) continue;
      const changed = new Map<number, number>();
      c.data.buildings.forEach((b, i) => {
        if (b.parent >= 0) return;
        const dist = Math.hypot(b.x - fx, b.z - fz);
        if (dist > radius) return;
        const k = `${c.cx},${c.cz},${i}`;
        const g = Math.min(6, Math.max(0.15, (this.edits.get(k) ?? 1) + amount * (1 - dist / radius)));
        this.edits.set(k, g);
        changed.set(i, g);
      });
      if (!changed.size) continue;
      touched += changed.size;
      c.data.buildings.forEach((b, i) => {
        const g = changed.get(b.parent >= 0 ? b.parent : i);
        if (g !== undefined) this.buildings.set(c.slot, i, 'iAnim', g, -100);
      });
      c.data.roofs.forEach((r, i) => {
        const g = changed.get(r.parent);
        if (g !== undefined) this.roofs.set(c.slot, i, 'iAnim', g, -100);
      });
      this.buildings.flush(c.slot, 0, SLAB.building, ['iAnim']);
      this.roofs.flush(c.slot, 0, SLAB.roof, ['iAnim']);
    }
    return touched;
  }
}
