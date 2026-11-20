import * as THREE from 'three';
import { CHUNK } from '../core/config';
import { FoldShape, foldPoint } from '../core/fold';
import { hash3 } from '../core/rng';
import type { ChunkData } from './generator';
import { foldedDepthMaterial, foldedMaterial, U } from './materials';
import { isCar, KIT_COUNT, KIT_SPEC, KitRing } from './kit';
import { loadStreetKit, StreetKitModels } from './streetKit';

/** What the kit needs to know about a streamed chunk. */
export interface KitChunk {
  cx: number;
  cz: number;
  data: ChunkData;
  /** When the chunk came in (its kit grows in from then). */
  born: number;
}

/** Floats per piece in a chunk's packed list: x, z, yaw, birth, paint tone, cloth tone, model, thrown. */
const STRIDE = 8;
/** A piece joins its list this far beyond its ring's end, so the list can lag the eye a little (the shader fades it out first). */
const MARGIN = 6;
/** The lists are rebuilt once the eye has moved this far (metres) since they last were. */
const MOVE = 2.5;
/** The far side of a chunk from its centre, metres (with room for what overhangs it). */
const CHUNK_REACH = CHUNK * 0.72;

/** One instanced mesh drawing a compact list of one model (no empty slots), and its shadow. */
class KitList {
  readonly geometry = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;
  private iKit: THREE.InstancedBufferAttribute;
  private iLook: THREE.InstancedBufferAttribute;
  private cap = 0;

  constructor(base: THREE.BufferGeometry, material: THREE.Material, depth: THREE.Material, shadow: boolean) {
    this.geometry.setIndex(base.index);
    for (const [name, attr] of Object.entries(base.attributes)) this.geometry.setAttribute(name, attr);
    this.iKit = this.grow(64, 'iKit');
    this.iLook = this.grow(64, 'iLook');
    this.cap = 64;
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    // folding happens on the GPU, so CPU-side bounds mean nothing
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  private grow(cap: number, name: string): THREE.InstancedBufferAttribute {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute(name, a);
    return a;
  }

  get count(): number {
    return this.geometry.instanceCount;
  }

  /** Upload n pieces: kit rows (x, z, yaw, birth) and look rows (paint, cloth, ring end, thrown), 4 floats each. */
  write(kit: Float32Array, look: Float32Array, n: number): void {
    if (n > this.cap) {
      let cap = this.cap;
      while (cap < n) cap *= 2;
      this.cap = cap;
      this.iKit = this.grow(cap, 'iKit');
      this.iLook = this.grow(cap, 'iLook');
    }
    (this.iKit.array as Float32Array).set(kit.subarray(0, n * 4));
    (this.iLook.array as Float32Array).set(look.subarray(0, n * 4));
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    for (const a of [this.iKit, this.iLook]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(n, 1) * 4);
      a.needsUpdate = true;
    }
  }
}

/**
 * The street life kit, drawn: one instanced list per model (and its far version, where it has one), each holding
 * only the pieces near enough the eye to be drawn, so nothing is drawn that is too far away to see. The
 * lists are rebuilt from the streamed chunks when the chunks change, the eye has moved a few metres, or a
 * fold moves; the shader then shrinks each piece away over the last stretch of its ring, so the edge never
 * pops. Distances are taken where a piece's foot stands once folded, as the trees' are.
 */
export class KitField {
  readonly group = new THREE.Group();
  /** How far from the eye (metres) each ring of pieces is drawn: set per quality tier. */
  readonly reach: Record<KitRing, number> = { small: 120, large: 320, car: 480 };
  /** Cars nearer the eye than this are drawn in full, the rest in their far version (metres). The parasols switch at reach.small. */
  carNear = 70;
  /** How far from the eye the kit casts shadows, metres. */
  shadowDist = 150;
  /** Resolves when the models have loaded (or failed to: then the kit is simply not drawn). */
  readonly ready: Promise<void>;

  private near: (KitList | null)[] = new Array(KIT_COUNT).fill(null);
  private far: (KitList | null)[] = new Array(KIT_COUNT).fill(null);
  private packed = new WeakMap<ChunkData, { born: number; rows: Float32Array }>();
  private dirty = true;
  private builtAt = new THREE.Vector3(NaN, 0, 0);
  private foldKey = '';
  private kitRows: Float32Array[] = [];
  private lookRows: Float32Array[] = [];
  /** Pieces per list this build: the near lists by Kit id, then the far ones at KIT_COUNT + id. */
  private counts = new Int32Array(KIT_COUNT * 2);
  private p = new THREE.Vector3();
  readonly material = foldedMaterial('kit');
  readonly depth = foldedDepthMaterial('kit');

  constructor(models?: Promise<StreetKitModels>) {
    this.depth.defines = { ...this.depth.defines, KIT_SHADOW: '' };
    for (let i = 0; i < KIT_COUNT * 2; i++) {
      this.kitRows.push(new Float32Array(256 * 4));
      this.lookRows.push(new Float32Array(256 * 4));
    }
    // (outside a browser, in the tests, there is nothing to load the file with and nothing to draw)
    const load = models ?? (typeof document === 'undefined' ? null : loadStreetKit());
    this.ready = load
      ? load.then((m) => this.use(m)).catch((err) => console.warn('street kit not drawn:', err))
      : Promise.resolve();
  }

  /** Put the loaded models to use: a list for each. */
  use(models: StreetKitModels): void {
    for (let k = 0; k < KIT_COUNT; k++) {
      const list = new KitList(models.near[k], this.material, this.depth, KIT_SPEC[k].shadow);
      this.near[k] = list;
      this.group.add(list.mesh);
    }
    for (let k = 0; k < KIT_COUNT; k++) {
      const base = models.far[k];
      if (!base) continue;
      // far away a piece's shadow is a few texels at most: not worth a draw in the shadow pass
      const list = new KitList(base, this.material, this.depth, false);
      this.far[k] = list;
      this.group.add(list.mesh);
    }
    this.dirty = true;
  }

  /** The streamed chunks changed: rebuild the lists. */
  changed(): void {
    this.dirty = true;
  }

  /** How many pieces each list is drawing now, by Kit id (far: 0 for a model with no far version). */
  drawn(): { near: number[]; far: number[] } {
    return { near: this.near.map((l) => l?.count ?? 0), far: this.far.map((l) => l?.count ?? 0) };
  }

  /** Every frame: rebuild the lists if the chunks, the eye or the folds have moved on enough. */
  update(chunks: Iterable<KitChunk>, folds: readonly FoldShape[], eye: THREE.Vector3): void {
    U.uKitShadow.value.set(this.shadowDist * 0.85, this.shadowDist);
    if (!this.near[0]) return;
    const key = folds.length ? folds.map((f) => `${f.hx.toFixed(1)},${f.hz.toFixed(1)},${f.angle.toFixed(3)},${f.radius.toFixed(1)}`).join(';') : '';
    if (!this.dirty && key === this.foldKey && this.builtAt.distanceToSquared(eye) < MOVE * MOVE) return;
    this.dirty = false;
    this.foldKey = key;
    this.builtAt.copy(eye);
    this.build(chunks, folds, eye);
  }

  private build(chunks: Iterable<KitChunk>, folds: readonly FoldShape[], eye: THREE.Vector3): void {
    const reachOf = KIT_SPEC.map((s) => this.reach[s.ring]);
    const reach2 = reachOf.map((r) => (r + MARGIN) ** 2);
    const longest = Math.max(...reachOf) + MARGIN;
    // beyond this (squared) a model with a far version is drawn in it
    const swap2 = KIT_SPEC.map((s, k) => (!s.far ? Infinity : (isCar(k) ? this.carNear : this.reach.small) ** 2));
    const counts = this.counts.fill(0);
    const p = this.p;
    for (const c of chunks) {
      const mx = (c.cx + 0.5) * CHUNK;
      const mz = (c.cz + 0.5) * CHUNK;
      p.set(mx, 0, mz);
      if (folds.length) foldPoint(folds, mx, mz, p);
      if (p.distanceTo(eye) - CHUNK_REACH > longest) continue;
      const rows = this.rows(c);
      for (let o = 0; o < rows.length; o += STRIDE) {
        const x = rows[o];
        const z = rows[o + 1];
        const model = rows[o + 6];
        p.set(x, 0, z);
        if (folds.length) foldPoint(folds, x, z, p);
        const d2 = p.distanceToSquared(eye);
        if (d2 > reach2[model]) continue;
        const list = d2 > swap2[model] ? KIT_COUNT + model : model;
        let n = counts[list];
        if ((n + 1) * 4 > this.kitRows[list].length) {
          const grow = (a: Float32Array) => {
            const b = new Float32Array(a.length * 2);
            b.set(a);
            return b;
          };
          this.kitRows[list] = grow(this.kitRows[list]);
          this.lookRows[list] = grow(this.lookRows[list]);
        }
        const k = this.kitRows[list];
        const l = this.lookRows[list];
        k[n * 4] = x;
        k[n * 4 + 1] = z;
        k[n * 4 + 2] = rows[o + 2];
        k[n * 4 + 3] = rows[o + 3];
        l[n * 4] = rows[o + 4];
        l[n * 4 + 1] = rows[o + 5];
        l[n * 4 + 2] = reachOf[model];
        l[n * 4 + 3] = rows[o + 7];
        counts[list] = n + 1;
      }
    }
    for (let k = 0; k < KIT_COUNT; k++) {
      this.near[k]!.write(this.kitRows[k], this.lookRows[k], counts[k]);
      this.far[k]?.write(this.kitRows[KIT_COUNT + k], this.lookRows[KIT_COUNT + k], counts[KIT_COUNT + k]);
    }
  }

  /** A chunk's pieces, packed once (they never change: a chunk is a pure function of its seed). */
  private rows(c: KitChunk): Float32Array {
    const had = this.packed.get(c.data);
    if (had && had.born === c.born) return had.rows;
    const kit = c.data.kit;
    const rows = new Float32Array(kit.length * STRIDE);
    kit.forEach((r, i) => {
      const o = i * STRIDE;
      rows[o] = r.x;
      rows[o + 1] = r.z;
      rows[o + 2] = r.yaw;
      rows[o + 3] = c.born + hash3(i, c.cx, c.cz) * 1.2;
      rows[o + 4] = r.tone;
      rows[o + 5] = r.tone2;
      rows[o + 6] = r.model;
      rows[o + 7] = KIT_SPEC[r.model].thrown ? 1 : 0;
    });
    this.packed.set(c.data, { born: c.born, rows });
    return rows;
  }
}
