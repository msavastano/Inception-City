import * as THREE from 'three';

/**
 * A slab allocator over one instanced mesh.
 *
 * Every streamed chunk owns a fixed-size slab of instances. Loading a chunk
 * writes into its slab and uploads only that byte range; unloading zeroes it.
 * However big the city gets, each kind of thing (buildings, roofs, trees…) is
 * still exactly one draw call.
 */
export class SlabPool {
  readonly geometry = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;
  readonly attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  private freeList: number[] = [];
  private used = new Set<number>();

  constructor(
    base: THREE.BufferGeometry,
    defs: Record<string, number>,
    readonly slabSize: number,
    readonly slabCount: number,
    material: THREE.Material,
  ) {
    if (base.index) this.geometry.setIndex(base.index);
    for (const [name, attr] of Object.entries(base.attributes)) this.geometry.setAttribute(name, attr);
    for (const [name, size] of Object.entries(defs)) {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(slabSize * slabCount * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.attrs[name] = attr;
      this.geometry.setAttribute(name, attr);
    }
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, material);
    // Folding happens on the GPU, so CPU-side bounds are meaningless.
    this.mesh.frustumCulled = false;
    for (let i = slabCount - 1; i >= 0; i--) this.freeList.push(i);
  }

  get capacity(): number {
    return this.slabSize * this.slabCount;
  }

  get usedSlabs(): number {
    return this.used.size;
  }

  /** Lowest free slab, so instanceCount stays compact. */
  acquire(): number {
    if (!this.freeList.length) return -1;
    let best = 0;
    for (let i = 1; i < this.freeList.length; i++) if (this.freeList[i] < this.freeList[best]) best = i;
    const slab = this.freeList.splice(best, 1)[0];
    this.used.add(slab);
    this.refreshCount();
    return slab;
  }

  /** Claim a specific slab (used to keep several pools in lock-step). */
  claim(slab: number): void {
    const i = this.freeList.indexOf(slab);
    if (i < 0) return;
    this.freeList.splice(i, 1);
    this.used.add(slab);
    this.refreshCount();
  }

  release(slab: number): void {
    if (!this.used.delete(slab)) return;
    for (const attr of Object.values(this.attrs)) {
      const start = slab * this.slabSize * attr.itemSize;
      (attr.array as Float32Array).fill(0, start, start + this.slabSize * attr.itemSize);
    }
    this.flush(slab);
    this.freeList.push(slab);
    this.refreshCount();
  }

  /** Write one instance's attribute. */
  set(slab: number, index: number, name: string, a: number, b = 0, c = 0, d = 0): void {
    const attr = this.attrs[name];
    const arr = attr.array as Float32Array;
    const o = (slab * this.slabSize + index) * attr.itemSize;
    arr[o] = a;
    if (attr.itemSize > 1) arr[o + 1] = b;
    if (attr.itemSize > 2) arr[o + 2] = c;
    if (attr.itemSize > 3) arr[o + 3] = d;
  }

  get(slab: number, index: number, name: string, component = 0): number {
    const attr = this.attrs[name];
    return (attr.array as Float32Array)[(slab * this.slabSize + index) * attr.itemSize + component];
  }

  /** Clear the tail of a slab after writing `count` instances. */
  clearFrom(slab: number, count: number): void {
    for (const attr of Object.values(this.attrs)) {
      const start = (slab * this.slabSize + count) * attr.itemSize;
      const end = (slab + 1) * this.slabSize * attr.itemSize;
      (attr.array as Float32Array).fill(0, start, end);
    }
  }

  /** Upload a slab's range (or a sub-range) to the GPU. */
  flush(slab: number, from = 0, count = this.slabSize, names?: string[]): void {
    for (const [name, attr] of Object.entries(this.attrs)) {
      if (names && !names.includes(name)) continue;
      attr.addUpdateRange((slab * this.slabSize + from) * attr.itemSize, count * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  private refreshCount(): void {
    let max = -1;
    for (const s of this.used) if (s > max) max = s;
    this.geometry.instanceCount = (max + 1) * this.slabSize;
  }
}
