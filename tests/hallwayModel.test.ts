import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { HALL_AXIS, HALL_HALF, HALL_LENGTH } from '../src/world/hallway';
import { KIND, mirrorQuarter, OUTSIDE_FROM, Quarter, SEAM } from '../src/world/hallwayModel';
import { HALLWAY } from '../src/world/hallway/manifest';
import buildScript from '../art/hallway/build_hallway.py?raw';
import assets from '../ASSETS.md?raw';
import inlined from '../src/world/hallway/hallway.glb?inline';

/** The shipped file's bytes, as the single-file build inlines them. */
const FILE = Uint8Array.from(atob(inlined.slice(inlined.indexOf(',') + 1)), (c) => c.charCodeAt(0));

interface Gltf {
  extensionsUsed?: string[];
  meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
  nodes: { mesh?: number; translation?: number[]; scale?: number[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string }[];
  bufferViews: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    extensions?: { EXT_meshopt_compression?: { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string } };
  }[];
  buffers: { byteLength: number }[];
}

/** Read the shipped file the way the game does, without a browser: unpack the chunks, undo meshopt, dequantise. */
async function readModel(): Promise<{ json: Gltf; quarter: Quarter }> {
  const glb = FILE;
  const jsonLen = new DataView(glb.buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as Gltf;
  const bin = glb.subarray(20 + jsonLen + 8);
  await MeshoptDecoder.ready;
  const views = json.bufferViews.map((v) => {
    const m = v.extensions?.EXT_meshopt_compression;
    if (!m) return new Uint8Array(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0), v.byteLength);
    const out = new Uint8Array(m.count * m.byteStride);
    const src = new Uint8Array(bin.buffer, bin.byteOffset + (m.byteOffset ?? 0), m.byteLength);
    MeshoptDecoder.decodeGltfBuffer(out, m.count, m.byteStride, src, m.mode, m.filter ?? 'NONE');
    return out;
  });
  const strideOf = (i: number) => json.bufferViews[i].extensions?.EXT_meshopt_compression?.byteStride ?? json.bufferViews[i].byteStride;
  const read = (index: number): Float32Array => {
    const a = json.accessors[index];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as 'SCALAR']!;
    const Type = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[a.componentType as 5120]!;
    const view = views[a.bufferView];
    const stride = strideOf(a.bufferView) ?? size * Type.BYTES_PER_ELEMENT;
    const max = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType as 5120];
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      const row = new Type(view.buffer, view.byteOffset + (a.byteOffset ?? 0) + i * stride, size);
      for (let c = 0; c < size; c++) out[i * size + c] = a.normalized && max ? Math.max(row[c] / max, -1) : row[c];
    }
    return out;
  };
  const prim = json.meshes[0].primitives[0];
  const node = json.nodes.find((n) => n.mesh === 0)!;
  const position = read(prim.attributes.POSITION);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  for (let i = 0; i < position.length; i += 3) {
    position[i] = position[i] * sx + tx;
    position[i + 1] = position[i + 1] * sy + ty;
    position[i + 2] = position[i + 2] * sz + tz;
  }
  const quarter: Quarter = {
    position,
    normal: read(prim.attributes.NORMAL),
    uv: read(prim.attributes.TEXCOORD_0),
    color: read(prim.attributes.COLOR_0),
    index: Uint32Array.from(read(prim.indices)),
  };
  return { json, quarter };
}

describe('the modelled hallway', () => {
  it('is one small, compressed file within the brief\'s budget', async () => {
    const bytes = FILE.length;
    expect(bytes).toBe(HALLWAY.bytes);
    expect(bytes).toBeLessThan(2.5 * 1024 * 1024);
    const { json } = await readModel();
    expect(json.extensionsUsed).toEqual(expect.arrayContaining(['EXT_meshopt_compression', 'EXT_texture_webp']));
    expect(json.meshes).toHaveLength(1);
    expect(json.meshes[0].primitives).toHaveLength(1); // one draw call
  });

  it('keeps every walked-on plane clear: nothing stands more than 8 cm into the 7 m box', async () => {
    const { quarter } = await readModel();
    const p = quarter.position;
    let deepest = 0;
    for (let i = 0; i < p.length; i += 3) {
      const ax = Math.abs(p[i]);
      const ay = Math.abs(p[i + 1]);
      if (ax < HALL_HALF - 1e-3 && ay < HALL_HALF - 1e-3) deepest = Math.max(deepest, Math.min(HALL_HALF - ax, HALL_HALF - ay));
    }
    expect(deepest).toBeGreaterThan(0.03); // the mouldings are there
    expect(deepest).toBeLessThan(0.08);
  });

  it('is a quarter of the corridor at its exact size, and clears the street as it turns', async () => {
    const { quarter } = await readModel();
    const p = quarter.position;
    let minX = Infinity;
    let maxZ = -Infinity;
    let minZ = Infinity;
    let reach = 0;
    let floorAtEnd = false;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]);
      minZ = Math.min(minZ, p[i + 2]);
      maxZ = Math.max(maxZ, p[i + 2]);
      reach = Math.max(reach, Math.hypot(p[i], p[i + 1]));
      if (Math.abs(p[i + 1] + HALL_HALF) < 2e-3 && Math.abs(p[i + 2] - HALL_LENGTH / 2) < 2e-3) floorAtEnd = true;
    }
    expect(minX).toBeGreaterThan(-2e-3);
    expect(minZ).toBeGreaterThan(-2e-3);
    expect(maxZ).toBeCloseTo(HALL_LENGTH / 2, 2);
    expect(floorAtEnd).toBe(true);
    // the corners of the stone outside must pass over the street while the corridor rolls
    expect(reach).toBeLessThan(HALL_AXIS - 0.1);
  });

  it('closes up down the middle, where the four copies meet', async () => {
    const { quarter } = await readModel();
    const p = quarter.position;
    let onX = 0;
    let onZ = 0;
    // the file's quantised positions miss the mirror planes by less than SEAM, and nothing else is that close
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i]) < SEAM) onX++;
      else expect(Math.abs(p[i])).toBeGreaterThan(5 * SEAM);
      if (Math.abs(p[i + 2]) < SEAM) onZ++;
      else expect(Math.abs(p[i + 2])).toBeGreaterThan(5 * SEAM);
    }
    expect(onX).toBeGreaterThan(50);
    expect(onZ).toBeGreaterThan(50);
    const whole = mirrorQuarter(quarter).attributes.position.array as Float32Array;
    for (let i = 0; i < whole.length; i += 3) {
      if (Math.abs(whole[i]) < SEAM) expect(Math.abs(whole[i])).toBe(0);
      if (Math.abs(whole[i + 2]) < SEAM) expect(Math.abs(whole[i + 2])).toBe(0);
    }
  });

  it('marks every vertex with a known kind of surface, and bakes light only on the inside', async () => {
    const { quarter } = await readModel();
    const kinds = new Set<number>();
    for (let i = 3; i < quarter.color.length; i += 4) kinds.add(Math.round(quarter.color[i] * 16));
    expect([...kinds].sort((a, b) => a - b)).toEqual(Object.values(KIND).sort((a, b) => a - b));
    expect(OUTSIDE_FROM).toBe(KIND.stone);
    // the lightmap coordinates of baked surfaces stay inside the image
    for (let i = 0; i < quarter.uv.length; i++) {
      expect(quarter.uv[i]).toBeGreaterThanOrEqual(0);
      expect(quarter.uv[i]).toBeLessThanOrEqual(1);
    }
  });

  it('draws the inside and the stone outside as two groups, in two draw calls', async () => {
    const { quarter } = await readModel();
    const g = mirrorQuarter(quarter);
    expect(g.groups).toHaveLength(2);
    const [inner, outer] = g.groups;
    const idx = g.index!.array;
    const kind = g.attributes.aKind.array;
    expect(inner.start).toBe(0);
    expect(outer.start).toBe(inner.count);
    expect(inner.count + outer.count).toBe(idx.length);
    expect(outer.count).toBeGreaterThan(0);
    for (let i = 0; i < idx.length; i++) expect(kind[idx[i]] >= OUTSIDE_FROM).toBe(i >= inner.count);
  });

  it('shares its kinds with the Blender script that made it', () => {
    const made = Object.fromEntries([...buildScript.matchAll(/^ {4}(\d+): \("(\w+)"/gm)].map((m) => [m[2], Number(m[1])]));
    expect(made).toEqual({ ...KIND });
  });

  it('is listed in ASSETS.md as made here, with nothing downloaded', () => {
    expect(assets).toMatch(/build_hallway\.py/);
    expect(assets).toMatch(/hallway\.glb/);
  });
});

describe('mirroring the quarter', () => {
  const quarter: Quarter = {
    position: new Float32Array([1, 0, 1, 2, 0, 1, 1, 1, 2]),
    normal: new Float32Array([0, -0.6, 0.8, 0, -0.6, 0.8, 0, -0.6, 0.8]),
    uv: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    color: new Float32Array([0.5, 0.4, 0.3, 2 / 16, 0.5, 0.4, 0.3, 2 / 16, 0.5, 0.4, 0.3, 2 / 16]),
    index: new Uint32Array([0, 1, 2]),
  };
  const g = mirrorQuarter(quarter);
  const pos = g.attributes.position.array as Float32Array;
  const idx = g.index!.array as Uint32Array;

  it('makes the whole corridor from four copies, sharing the lightmap', () => {
    expect(g.attributes.position.count).toBe(12);
    expect(idx.length).toBe(12);
    expect(Array.from(pos.slice(9, 12))).toEqual([-1, 0, 1]); // across x = 0
    expect(Array.from(pos.slice(18, 21))).toEqual([1, 0, -1]); // across z = 0
    expect(Array.from(g.attributes.uv.array.slice(18, 20))).toEqual(Array.from(quarter.uv.slice(0, 2)).map((v) => expect.closeTo(v, 6)));
    expect(Array.from(g.attributes.aKind.array)).toEqual(new Array(12).fill(2));
    expect(g.groups).toEqual([
      { start: 0, count: 12, materialIndex: 0 },
      { start: 12, count: 0, materialIndex: 1 },
    ]);
  });

  it('turns the triangles of the copies mirrored once, so they still face their normals', () => {
    const facing = (p: ArrayLike<number>, nrm: ArrayLike<number>, [a, b, c]: number[]) => {
      const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
      const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      return Math.sign(n[0] * nrm[a * 3] + n[1] * nrm[a * 3 + 1] + n[2] * nrm[a * 3 + 2]);
    };
    const original = facing(quarter.position, quarter.normal, [0, 1, 2]);
    expect(original).toBe(1);
    const nrm = g.attributes.normal.array as Float32Array;
    for (let t = 0; t < 12; t += 3) expect(facing(pos, nrm, [idx[t], idx[t + 1], idx[t + 2]])).toBe(original);
  });
});
