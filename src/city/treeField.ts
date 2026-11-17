import * as THREE from 'three';
import { FoldShape, foldPoint } from '../core/fold';
import { hash3 } from '../core/rng';
import type { ChunkData } from './generator';
import { treeDepthMaterial, treeMaterial, U } from './materials';
import { leafTexture, treeGeometry } from './trees';

/** What the trees need to know about a streamed chunk. */
export interface TreeChunk {
  cx: number;
  cz: number;
  data: ChunkData;
  /** Its street furniture is out (the detail ring), and since when (trees grow in from then). */
  props: boolean;
  propsBorn: number;
}

/** At most this many trees close enough for the near version (the rest are far). */
const NEAR_CAP = 256;
/** At most this many trees out at all. */
const FAR_CAP = 4096;
/** Over this stretch (metres) a tree fades from its near version to its far one. */
export const TREE_FADE = 12;
/** A tree joins the near list this far beyond where its near version is gone, so the list can lag a frame. */
const NEAR_MARGIN = 8;
/** Floats per tree: x, z, yaw, scale, tone, birth time, seed, shape * 2 + mirrored. */
const STRIDE = 8;

/** One instanced mesh drawing a compact list of trees (no empty slots: every instance drawn is a tree). */
class TreeList {
  readonly geometry = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;
  private readonly iTree: THREE.InstancedBufferAttribute;
  private readonly iLook: THREE.InstancedBufferAttribute;

  constructor(
    base: THREE.BufferGeometry,
    readonly cap: number,
    material: THREE.Material,
    depth: THREE.Material,
  ) {
    this.geometry.setIndex(base.index);
    for (const [name, attr] of Object.entries(base.attributes)) this.geometry.setAttribute(name, attr);
    this.iTree = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iLook = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iTree', this.iTree);
    this.geometry.setAttribute('iLook', this.iLook);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // folding happens on the GPU, so CPU-side bounds mean nothing
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.geometry.instanceCount;
  }

  /** Copy trees (rows of `all`, STRIDE floats each) into the list and upload them. */
  write(all: Float32Array, rows: ArrayLike<number>, n: number): void {
    const t = this.iTree.array as Float32Array;
    const l = this.iLook.array as Float32Array;
    n = Math.min(n, this.cap);
    for (let i = 0; i < n; i++) {
      const o = rows[i] * STRIDE;
      t.set(all.subarray(o, o + 4), i * 4);
      l.set(all.subarray(o + 4, o + 8), i * 4);
    }
    this.geometry.instanceCount = n;
    for (const a of [this.iTree, this.iLook]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(n, 1) * 4);
      a.needsUpdate = true;
    }
  }
}

/**
 * The city's trees, drawn as two lists: the near version for the few close to the eye
 * and the far version for every tree out (both instanced, one draw call each). Which
 * list a tree is in is decided here every frame from where its foot stands once folded;
 * the shader then fades between the two versions exactly, so a list only needs to be
 * about right (see TREE_VERT_HEAD).
 */
export class TreeField {
  readonly group = new THREE.Group();
  readonly near: TreeList;
  readonly far: TreeList;
  /** Where the near version has faded out, metres from the eye (0: far version only, as on Low). */
  nearDist = 60;
  /** Resolves when the leaves have been drawn (just after the first frame). */
  ready: Promise<void>;

  private all = new Float32Array(FAR_CAP * STRIDE);
  private total = 0;
  private dirty = true;
  private rows = new Int32Array(FAR_CAP);
  private order = new Int32Array(NEAR_CAP);
  private nearDist2 = new Float32Array(FAR_CAP);
  private lastNear = new Int32Array(NEAR_CAP).fill(-1);
  private lastNearCount = -1;
  private p = new THREE.Vector3();

  constructor() {
    this.near = new TreeList(treeGeometry('near'), NEAR_CAP, treeMaterial('near'), treeDepthMaterial('near'));
    this.far = new TreeList(treeGeometry('far'), FAR_CAP, treeMaterial('far'), treeDepthMaterial('far'));
    // The near trees are drawn before the city: where their leaves cover a facade, its shading is skipped.
    this.near.mesh.renderOrder = -1;
    this.group.add(this.near.mesh, this.far.mesh);
    // the leaves are drawn texel by texel; leave that until the first frame is on the screen
    this.ready = new Promise((done) =>
      setTimeout(() => {
        U.tLeaves.value = leafTexture();
        done();
      }, 0),
    );
  }

  /** A chunk's street furniture came or went: rebuild the list of trees. */
  changed(): void {
    this.dirty = true;
  }

  /** Every frame: the trees that are out, and which of them are close enough to the eye for the near version. */
  update(chunks: Iterable<TreeChunk>, folds: readonly FoldShape[], eye: THREE.Vector3): void {
    U.uEye.value.copy(eye);
    const end = this.nearDist;
    // (with no near version, both ends sit behind the eye so every tree is far)
    U.uTrees.value.x = end > 0 ? end - TREE_FADE : -2;
    U.uTrees.value.y = end > 0 ? end : -1;
    if (this.dirty) this.collect(chunks);

    let n = 0;
    if (end > 0) {
      const reach = (end + NEAR_MARGIN) ** 2;
      const p = this.p;
      for (let i = 0; i < this.total; i++) {
        const o = i * STRIDE;
        p.set(this.all[o], 0, this.all[o + 1]);
        if (folds.length) foldPoint(folds, p.x, p.z, p);
        const d2 = p.distanceToSquared(eye);
        if (d2 < reach) {
          this.rows[n] = i;
          this.nearDist2[n++] = d2;
        }
      }
      if (n > NEAR_CAP) {
        // the nearest ones, if there are too many
        const idx = Array.from({ length: n }, (_, k) => k).sort((a, b) => this.nearDist2[a] - this.nearDist2[b]);
        for (let k = 0; k < NEAR_CAP; k++) this.order[k] = this.rows[idx[k]];
        n = NEAR_CAP;
      } else {
        this.order.set(this.rows.subarray(0, n));
      }
    }
    let same = n === this.lastNearCount;
    for (let k = 0; same && k < n; k++) same = this.order[k] === this.lastNear[k];
    if (!same) {
      this.near.write(this.all, this.order, n);
      this.lastNear.set(this.order.subarray(0, n));
      this.lastNearCount = n;
    }
  }

  private collect(chunks: Iterable<TreeChunk>): void {
    this.dirty = false;
    let n = 0;
    for (const c of chunks) {
      if (!c.props) continue;
      c.data.trees.forEach((t, i) => {
        if (n >= FAR_CAP) return;
        const o = n * STRIDE;
        const seed = hash3(Math.round(t.x * 8), Math.round(t.z * 8), 71);
        const mirrored = hash3(Math.round(t.x * 8), Math.round(t.z * 8), 72) < 0.5 ? 1 : 0;
        this.all[o] = t.x;
        this.all[o + 1] = t.z;
        this.all[o + 2] = t.yaw;
        this.all[o + 3] = t.scale;
        this.all[o + 4] = t.tone;
        this.all[o + 5] = c.propsBorn + hash3(i, c.cx, c.cz) * 1.2;
        this.all[o + 6] = seed;
        this.all[o + 7] = (t.shape ?? 1) * 2 + mirrored;
        n++;
      });
    }
    this.total = n;
    const rows = new Int32Array(n);
    for (let i = 0; i < n; i++) rows[i] = i;
    this.far.write(this.all, rows, n);
    // the rows behind the near list have moved
    this.lastNearCount = -1;
  }

  /** How many trees each version is drawing now. */
  counts(): { near: number; far: number } {
    return { near: this.near.count, far: this.far.count };
  }
}
