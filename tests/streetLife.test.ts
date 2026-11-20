import { describe, expect, it } from 'vitest';
import { BLOCK, SIDEWALK, streetHalfWidth } from '../src/core/config';
import { ChunkData, generateChunk } from '../src/city/generator';
import { isCar, Kit, KIT_COUNT, KIT_MODELS, KIT_SPEC, kitModel } from '../src/city/kit';
import { CAR_LENGTH, CAR_WIDTH, CIRCUS_RINGS, KitRec, kitFootprint, LANE_D, ZEBRA } from '../src/city/streetLife';
import { KIT_WAVE_SPEED } from '../src/city/shaders';
import { WAVE_SPEED } from '../src/world/collapse';
import { STREET } from '../src/city/street/manifest';
import buildScript from '../art/street/build_street.py?raw';
import assets from '../ASSETS.md?raw';
import inlined from '../src/city/street/street.glb?inline';

const SEED = 4242;
/** Dream Walk starts here, walking north (+z) towards the Circus. */
const SPAWN = { x: 10.2, z: -70 };

const chunks = new Map<string, ChunkData>();
function chunk(cx: number, cz: number): ChunkData {
  const key = `${cx},${cz}`;
  if (!chunks.has(key)) chunks.set(key, generateChunk(cx, cz, SEED));
  return chunks.get(key)!;
}
/** The six by six chunks round the Circus (1.5 km across). */
const AREA: [number, number][] = [];
for (let cz = -3; cz <= 2; cz++) for (let cx = -3; cx <= 2; cx++) AREA.push([cx, cz]);
const everything = (): KitRec[] => AREA.flatMap(([cx, cz]) => chunk(cx, cz).kit);
const at = (r: KitRec) => `${r.x.toFixed(2)}, ${r.z.toFixed(2)}`;

/** Nearest street line to a coordinate, and how far from it. */
function nearestLine(v: number): { line: number; off: number } {
  const line = Math.round(v / BLOCK);
  return { line, off: Math.abs(v - line * BLOCK) };
}
/** Within a roadway (between the kerbs) of a street along z, or one along x. */
function roadway(x: number, z: number): { alongZ: boolean; alongX: boolean } {
  const X = nearestLine(x);
  const Z = nearestLine(z);
  return { alongZ: X.off < streetHalfWidth(X.line) - SIDEWALK, alongX: Z.off < streetHalfWidth(Z.line) - SIDEWALK };
}
/** In the road: the cars, and the bicycle racks in the parking lanes (not those out on the squares). */
const inRoad = (r: KitRec) => {
  if (isCar(r.model)) return true;
  if (r.model !== Kit.Rack || Math.hypot(r.x, r.z) < 60) return false;
  const { alongZ, alongX } = roadway(r.x, r.z);
  return alongZ || alongX;
};

describe('the street life kit, placed', () => {
  it('is the same every time a chunk is generated', () => {
    const a = generateChunk(0, -1, SEED).kit;
    const b = generateChunk(0, -1, SEED).kit;
    expect(a.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
  });

  it('puts every model somewhere near the start', () => {
    const seen = new Array(KIT_COUNT).fill(0);
    for (const r of everything()) seen[r.model]++;
    KIT_MODELS.forEach((name, k) => expect(seen[k], name).toBeGreaterThan(0));
  });

  it('lines most streets with parked cars', () => {
    const kit = everything();
    const cars = kit.filter((r) => isCar(r.model));
    // 36 chunks: each owns 8 street lines x 4 blocks x 2 sides = 64 stretches of kerb, about 50 m of parking each
    expect(cars.length / AREA.length).toBeGreaterThan(300);
    // the stretches of kerb with at least one car on them
    const stretches = new Set<string>();
    for (const r of cars) {
      const { line: lx, off: ox } = nearestLine(r.x);
      const { line: lz, off: oz } = nearestLine(r.z);
      // which street it is in (its kerb runs along that street), which block and which side
      const alongZ = ox < streetHalfWidth(lx) && (oz >= streetHalfWidth(lz) || ox < oz);
      stretches.add(alongZ ? `x${lx}:${Math.floor(r.z / BLOCK)}:${Math.sign(r.x - lx * BLOCK)}` : `z${lz}:${Math.floor(r.x / BLOCK)}:${Math.sign(r.z - lz * BLOCK)}`);
    }
    expect(stretches.size / (AREA.length * 64)).toBeGreaterThan(0.75);
  });

  it('furnishes the streets where Dream Walk starts', () => {
    const near = everything().filter((r) => Math.hypot(r.x - SPAWN.x, r.z - SPAWN.z) < 80);
    const count = (k: Kit) => near.filter((r) => r.model === k).length;
    expect(near.filter((r) => isCar(r.model)).length).toBeGreaterThan(30);
    expect(count(Kit.Terrace)).toBeGreaterThan(10);
    expect(count(Kit.Parasol)).toBeGreaterThan(5);
    expect(count(Kit.Bench)).toBeGreaterThan(5);
    expect(count(Kit.Bollard)).toBeGreaterThan(10);
  });

  it('furnishes every quarter of the Circus, and leaves its lawn and roadway clear', () => {
    const quarters = [
      [-1, -1],
      [-1, 0],
      [0, -1],
      [0, 0],
    ];
    for (const [cx, cz] of quarters) {
      const inside = chunk(cx, cz).kit.filter((r) => Math.max(Math.abs(r.x), Math.abs(r.z)) < 57);
      const models = new Set(inside.map((r) => r.model));
      for (const k of [Kit.Bench, Kit.Bollard, Kit.Kiosk, Kit.Column]) expect(models.has(k), `${KIT_MODELS[k]} in quarter ${cx},${cz}`).toBe(true);
    }
    // and the four between them have the lot
    const circus = new Set(quarters.flatMap(([cx, cz]) => chunk(cx, cz).kit.filter((r) => Math.max(Math.abs(r.x), Math.abs(r.z)) < 57).map((r) => r.model)));
    for (const k of [Kit.Parasol, Kit.Metro, Kit.Fountain, Kit.Planter, Kit.Menu, Kit.Bin, Kit.Rack]) expect(circus.has(k), KIT_MODELS[k]).toBe(true);
    const bad: string[] = [];
    for (const [cx, cz] of quarters) {
      for (const r of chunk(cx, cz).kit) {
        if (isCar(r.model) && Math.hypot(r.x, r.z) < CIRCUS_RINGS) bad.push(`car at ${at(r)}`);
        for (const f of kitFootprint(r)) {
          const d = Math.hypot(f.x, f.z);
          // the lawn (14 to 24 m out) and the ring road (25 to 40 m)
          if (!(d + f.r < 14 || d - f.r > 40)) bad.push(`${KIT_MODELS[r.model]} at ${at(r)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps out of the crowd\'s way: its lanes along the sidewalks, which cross the streets at the corners', () => {
    const bad: string[] = [];
    for (const r of everything()) {
      if (inRoad(r)) continue;
      for (const f of kitFootprint(r)) {
        for (const v of [f.x, f.z]) {
          const { line } = nearestLine(v);
          for (const s of [-1, 1]) {
            const lane = line * BLOCK + s * (streetHalfWidth(line) - LANE_D);
            if (Math.abs(v - lane) - f.r < 0.4) bad.push(`${KIT_MODELS[r.model]} at ${at(r)}`);
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('parks nothing on a zebra or a crossing', () => {
    const bad: string[] = [];
    let parked = 0;
    for (const r of everything()) {
      if (!inRoad(r)) continue;
      parked++;
      for (const f of kitFootprint(r)) {
        const X = nearestLine(f.x);
        const Z = nearestLine(f.z);
        // in the road of a street running along z (its line in x), or along x
        const { alongZ, alongX } = roadway(f.x, f.z);
        if (alongZ === alongX) bad.push(`${KIT_MODELS[r.model]} at ${at(r)} is not in one road`);
        const cross = alongZ ? Z : X;
        if (cross.off - f.r < streetHalfWidth(cross.line) + ZEBRA) bad.push(`${KIT_MODELS[r.model]} at ${at(r)} on a zebra`);
      }
    }
    expect(parked).toBeGreaterThan(5000);
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('keeps clear of the lamps, the trees and itself', () => {
    const bad: string[] = [];
    for (const [cx, cz] of AREA.filter(([cx, cz]) => Math.abs(cx + 0.5) < 2 && Math.abs(cz + 0.5) < 2)) {
      const c = chunk(cx, cz);
      const circles = c.kit.flatMap((r) => kitFootprint(r).map((f) => ({ ...f, piece: r })));
      // lamps, trees and pieces by 4 m cells
      const cell = (x: number, z: number) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
      const grid = new Map<string, { x: number; z: number; r: number; what: string; piece?: KitRec }[]>();
      const add = (o: { x: number; z: number; r: number; what: string; piece?: KitRec }) => {
        const k = cell(o.x, o.z);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(o);
      };
      for (const l of c.lamps) add({ x: l.x, z: l.z, r: 0.25, what: 'lamp' });
      for (const t of c.trees) add({ x: t.x, z: t.z, r: 0.35, what: 'tree' });
      for (const f of circles) add({ ...f, what: KIT_MODELS[f.piece.model] });
      for (const f of circles) {
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            for (const g of grid.get(cell(f.x + i * 4, f.z + j * 4)) ?? []) {
              if (g.piece === f.piece) continue;
              // pieces may touch (a car's circles reach its bumpers), but not overlap
              const room = g.piece ? f.r + g.r - 0.03 : f.r + g.r;
              if (Math.hypot(f.x - g.x, f.z - g.z) < room) bad.push(`${KIT_MODELS[f.piece.model]} at ${at(f.piece)} into a ${g.what}`);
            }
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('gives first person something to bump into', () => {
    const c = chunk(0, -1);
    const kitCircles = c.kit.reduce((n, r) => n + kitFootprint(r).length, 0);
    expect(c.circles.length).toBeGreaterThanOrEqual(kitCircles);
  });

  it('owns each street once: neighbouring chunks never place the same piece', () => {
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const r of everything()) {
      const key = `${KIT_MODELS[r.model]} at ${at(r)}`;
      if (seen.has(key)) twice.push(key);
      seen.add(key);
    }
    expect(twice).toEqual([]);
  });
});

interface Gltf {
  extensionsUsed?: string[];
  meshes: { name?: string; primitives: { attributes: Record<string, number>; indices: number }[] }[];
  nodes: { name?: string; mesh?: number }[];
  accessors: { count: number; type: string }[];
}

describe('the street life kit\'s models', () => {
  const glb = Uint8Array.from(atob(inlined.slice(inlined.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true)))) as Gltf;

  it('are one small, compressed file, as the manifest says', () => {
    expect(glb.length).toBe(STREET.bytes);
    expect(glb.length).toBeLessThan(256 * 1024);
    expect(json.extensionsUsed).toContain('EXT_meshopt_compression');
  });

  it('hold every model the kit draws, with what its shader reads', () => {
    const names = [...KIT_MODELS, ...KIT_MODELS.filter((_, k) => KIT_SPEC[k].far).map((n) => `${n}_far`)];
    for (const name of names) {
      const node = json.nodes.find((n) => n.name === name && n.mesh !== undefined);
      expect(node, name).toBeDefined();
      const prim = json.meshes[node!.mesh!].primitives[0];
      for (const a of ['POSITION', 'NORMAL', 'COLOR_0', 'TEXCOORD_0']) expect(prim.attributes[a], `${name} ${a}`).toBeDefined();
      // the colour carries the surface kind in its alpha
      expect(json.accessors[prim.attributes.COLOR_0].type).toBe('VEC4');
      expect(json.accessors[prim.indices].count / 3).toBe(STREET.models[name as keyof typeof STREET.models].triangles);
    }
  });

  it('stay inside their triangle budgets', () => {
    KIT_MODELS.forEach((name, k) => {
      expect(kitModel(k).triangles, name).toBeLessThanOrEqual(isCar(k) ? 3600 : 4000);
      if (KIT_SPEC[k].far) expect(kitModel(k, true).triangles, `${name}_far`).toBeLessThanOrEqual(isCar(k) ? 250 : 200);
    });
  });

  it('are the sizes the placement plans for', () => {
    for (const car of [Kit.CarHatch, Kit.CarSaloon, Kit.CarVan]) {
      const { min, max } = kitModel(car);
      expect(max[2] - min[2]).toBeCloseTo(CAR_LENGTH[car], 1);
      // the body (the mirrors stand out a little further)
      expect(max[0] - min[0]).toBeGreaterThan(CAR_WIDTH);
      expect(max[0] - min[0]).toBeLessThan(CAR_WIDTH + 0.25);
      const far = kitModel(car, true);
      expect(far.max[2] - far.min[2]).toBeCloseTo(CAR_LENGTH[car], 1);
    }
    // everything stands on the ground
    KIT_MODELS.forEach((name, k) => expect(Math.abs(kitModel(k).min[1]), name).toBeLessThan(0.02));
  });

  it('are thrown by the café explosion\'s wave as it passes', () => {
    expect(KIT_WAVE_SPEED).toBe(WAVE_SPEED);
  });

  it('are made here in Blender and listed in ASSETS.md, with nothing downloaded', () => {
    expect(buildScript).toMatch(/import bpy/);
    expect(assets).toMatch(/build_street\.py/);
    expect(assets).toMatch(/street\.glb/);
  });
});
