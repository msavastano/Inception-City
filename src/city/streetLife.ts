import { BLOCK, BOULEVARD_HALF, BOULEVARD_TREES, CHUNK, CHUNK_BLOCKS, LAMP_OFFSET, LAMP_SPACING, streetHalfWidth } from '../core/config';
import { hash3, rng } from '../core/rng';
import type { Circle, Rect } from './generator';
import { Kit } from './kit';

/**
 * THE STREET LIFE KIT, PLACED
 *
 * What makes a Paris street look lived in at eye level: cars parked nose to tail along the kerbs, café
 * terraces against the facades with their planters and chalkboards, bollards at the corners, benches
 * between the boulevard plane trees, bicycles at racks in the parking lane, litter bins by the lamps; and
 * out on the squares, the parks and the Circus, news kiosks, advertising columns, metro entrances,
 * drinking fountains and terraces under parasols.
 *
 * Placed by seed, as a pure function of the chunk like the rest of the city. Each chunk owns the streets
 * along its west and south edges and the three between (as with the lamps), both sides of them, and the
 * insides of its own sixteen blocks; the Circus round the totem is laid out by hand (circusQuarter).
 *
 * Everything keeps clear of where the crowd walks (src/world/projections.ts: straight lanes 1.7 m in from
 * every building line, which cross the streets at the corners) and of the zebras, which the ground shader
 * paints from 0 to 3.5 m past every corner. Sidewalk positions are given as d, metres in from the building
 * line: the kerb is at d = 3, the crowd's lane at 1.7, the lamps at 1 and the boulevard trees at 2.5; the
 * parked cars are in the road at d = 4.05.
 */

export interface KitRec {
  x: number;
  z: number;
  /** Turns the model's +z (its front) towards (sin yaw, cos yaw). */
  yaw: number;
  model: Kit;
  /** 0..1: a car's or a bicycle's paint. */
  tone: number;
  /** 0..1: a café's colours (chair weave, parasols), shared by its whole terrace. */
  tone2: number;
}

export interface StreetLife {
  kit: KitRec[];
  /** Footprints for first-person collision, added to the chunk's circles. */
  circles: Circle[];
}

/** What the generator knows about a block that the kit needs. */
export interface BlockInfo {
  kind: number;
  /** A row of shops with cafés on the ground floor (Haussmann or brick facades). */
  cafes: boolean;
}

// BlockKind, as numbers (generator.ts imports this file, so its const enum is repeated here).
const PERIMETER = 0;
const PARK = 1;
const PLAZA = 2;
const TOWERS = 3;
const CIRCUS = 4;

/** Where things stand on a sidewalk, metres in from the building line (see the top of this file). */
export const KIT_D = {
  terrace: 0.64,
  planter: 0.5,
  bin: 0.45,
  parkBench: 0.5,
  menu: 2.45,
  bench: 2.55,
  bollard: 2.75,
  /** The middle of a car parked against the kerb, in the road. */
  car: 4.05,
  /** Bicycle racks in the parking lane, at right angles to the kerb. */
  rack: 3.95,
} as const;

/** The crowd's lanes are this far in from the building lines; nothing on a sidewalk comes within LANE_CLEAR of one. */
export const LANE_D = 1.7;
export const LANE_CLEAR = 0.45;
/** How far past a crossing street's building line its zebra runs (the ground shader paints it from there). */
export const ZEBRA = 3.5;

/** Lengths and width of the cars (metres), by Kit id. */
export const CAR_LENGTH: Record<number, number> = { [Kit.CarHatch]: 3.96, [Kit.CarSaloon]: 4.62, [Kit.CarVan]: 4.42 };
export const CAR_WIDTH = 1.82;

/** The collision footprint of one piece (circles, fabric metres): local points (x, z, r) turned by its yaw. */
const FOOTPRINT: Record<number, [number, number, number][]> = {
  // (reaching back into the facade, so that nobody can squeeze in behind the chairs)
  [Kit.Terrace]: [[0, -0.12, 0.66]],
  [Kit.Parasol]: [[0, 0, 0.95]],
  [Kit.Bench]: [
    [-0.5, -0.02, 0.36],
    [0.5, -0.02, 0.36],
  ],
  [Kit.Bollard]: [[0, 0, 0.1]],
  [Kit.Rack]: [
    [-0.45, 0.1, 0.33],
    [0.45, 0.1, 0.33],
  ],
  [Kit.Planter]: [
    [-0.36, 0, 0.27],
    [0.36, 0, 0.27],
  ],
  [Kit.Menu]: [[0, 0, 0.25]],
  [Kit.Bin]: [[0, -0.02, 0.22]],
  [Kit.Column]: [[0, 0, 0.7]],
  [Kit.Kiosk]: [
    [-0.5, 0.05, 0.95],
    [0.5, 0.05, 0.95],
  ],
  [Kit.Metro]: [
    [0, -1.4, 0.95],
    [0, 0, 0.95],
    [0, 1.4, 0.95],
  ],
  [Kit.Fountain]: [[0, 0, 0.52]],
};
for (const car of [Kit.CarHatch, Kit.CarSaloon, Kit.CarVan]) {
  const half = CAR_LENGTH[car] / 2 - CAR_WIDTH / 2;
  FOOTPRINT[car] = [
    [0, -half, CAR_WIDTH / 2],
    [0, 0, CAR_WIDTH / 2],
    [0, half, CAR_WIDTH / 2],
  ];
}

export function kitFootprint(r: KitRec): Circle[] {
  const c = Math.cos(r.yaw);
  const s = Math.sin(r.yaw);
  return FOOTPRINT[r.model].map(([lx, lz, rad]) => ({ x: r.x + c * lx + s * lz, z: r.z - s * lx + c * lz, r: rad }));
}

/** Distance along a street from its nearest lamp, a being metres into the block (lamps stand 16 and 48 m in). */
export function lampGap(a: number): number {
  let g = Infinity;
  for (let l = LAMP_OFFSET; l < BLOCK; l += LAMP_SPACING) g = Math.min(g, Math.abs(a - l));
  return g;
}

/** Distance along a boulevard from its nearest plane tree (they stand 22, 32 and 42 m into each block, 2.5 m in). */
export function treeGap(a: number): number {
  let g = Infinity;
  for (let t = 0; t < BOULEVARD_TREES.count; t++) g = Math.min(g, Math.abs(a - (BOULEVARD_TREES.first + t * BOULEVARD_TREES.step)));
  return g;
}

/** The Circus's rings (the hub, the lawn, the roadway and its pavement) are within this of the origin. */
export const CIRCUS_RINGS = 46;
/** Within r of the Circus's rings: where the streets run through it there is no kerb to park at. */
const circus = (x: number, z: number, r: number) => Math.hypot(x, z) < CIRCUS_RINGS + 1.5 + r;

/** The yaw that turns +z to (dx, dz). */
const facing = (dx: number, dz: number) => Math.atan2(dx, dz);

/**
 * Place the kit on a chunk. `block` describes any block (by its global indices); `occupied` holds what is
 * already there (trees, building and tower footprints), which the pieces off the sidewalks keep clear of.
 */
export function placeStreetLife(
  cx: number,
  cz: number,
  seed: number,
  block: (bx: number, bz: number) => BlockInfo,
  occupied: { circles: readonly Circle[]; rects: readonly Rect[] },
): StreetLife {
  const out: StreetLife = { kit: [], circles: [] };
  const rand = rng(Math.floor(hash3(cx * 7 + 3, cz * 13 + 5, seed + 501) * 4294967296));
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;

  const put = (x: number, z: number, yaw: number, model: Kit, tone: number, tone2 = 0): KitRec => {
    const rec: KitRec = { x, z, yaw, model, tone, tone2 };
    out.kit.push(rec);
    out.circles.push(...kitFootprint(rec));
    return rec;
  };
  /** Clear of trees, buildings and the pieces placed so far, by at least `pad` round the piece's footprint. */
  const free = (x: number, z: number, yaw: number, model: Kit, pad = 0.15): boolean => {
    for (const f of kitFootprint({ x, z, yaw, model, tone: 0, tone2: 0 })) {
      const r = f.r + pad;
      for (const c of occupied.circles) if ((f.x - c.x) ** 2 + (f.z - c.z) ** 2 < (c.r + r) ** 2) return false;
      for (const c of out.circles) if ((f.x - c.x) ** 2 + (f.z - c.z) ** 2 < (c.r + r) ** 2) return false;
      for (const b of occupied.rects) {
        const dx = Math.max(b.x0 - f.x, 0, f.x - b.x1);
        const dz = Math.max(b.z0 - f.z, 0, f.z - b.z1);
        if (dx * dx + dz * dz < r * r) return false;
      }
    }
    return true;
  };
  const tryPut = (x: number, z: number, yaw: number, model: Kit, tone: number, tone2 = 0, pad = 0.15): boolean => {
    if (!free(x, z, yaw, model, pad)) return false;
    put(x, z, yaw, model, tone, tone2);
    return true;
  };

  // ---- The Circus: its four quarters are laid out by hand ----
  for (let j = 0; j < CHUNK_BLOCKS; j++) {
    for (let i = 0; i < CHUNK_BLOCKS; i++) {
      const bx = cx * CHUNK_BLOCKS + i;
      const bz = cz * CHUNK_BLOCKS + j;
      if (block(bx, bz).kind === CIRCUS) circusQuarter(bx < 0 ? -1 : 1, bz < 0 ? -1 : 1, seed, tryPut);
    }
  }

  // ---- Inside the blocks: squares, parks and tower forecourts ----
  for (let j = 0; j < CHUNK_BLOCKS; j++) {
    for (let i = 0; i < CHUNK_BLOCKS; i++) {
      const bx = cx * CHUNK_BLOCKS + i;
      const bz = cz * CHUNK_BLOCKS + j;
      const info = block(bx, bz);
      if (info.kind !== PLAZA && info.kind !== PARK && info.kind !== TOWERS) continue;
      const x0 = bx * BLOCK + streetHalfWidth(bx);
      const x1 = (bx + 1) * BLOCK - streetHalfWidth(bx + 1);
      const z0 = bz * BLOCK + streetHalfWidth(bz);
      const z1 = (bz + 1) * BLOCK - streetHalfWidth(bz + 1);
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      const brand = rng(Math.floor(hash3(bx, bz, seed + 777) * 4294967296));
      // a point `inset` in from edge e (0 south, 1 north, 2 west, 3 east), t (-1..1) of the way along it, and the
      // yaw that turns +z out to that edge's street
      const edge = (e: number, t: number, inset: number): [number, number, number] => {
        if (e === 0) return [mx + (t * (x1 - x0)) / 2, z0 + inset, Math.PI];
        if (e === 1) return [mx + (t * (x1 - x0)) / 2, z1 - inset, 0];
        if (e === 2) return [x0 + inset, mz + (t * (z1 - z0)) / 2, -Math.PI / 2];
        return [x1 - inset, mz + (t * (z1 - z0)) / 2, Math.PI / 2];
      };
      if (info.kind === PLAZA) plaza(edge, mx, mz, brand, tryPut);
      else if (info.kind === PARK) park(edge, mx, mz, x0, x1, z0, z1, brand, tryPut);
      else forecourts(occupied.rects, x0, x1, z0, z1, brand, tryPut);
    }
  }

  // ---- The streets: every owned street line, both sides, block by block ----
  for (const axis of [0, 1]) {
    for (let k = 0; k < CHUNK_BLOCKS; k++) {
      const h = streetHalfWidth(k);
      const boulevard = h === BOULEVARD_HALF;
      for (const s of [-1, 1]) {
        for (let m = 0; m < CHUNK_BLOCKS; m++) {
          // the block on this side of the street (its facade is the building line at d = 0)
          const li = s > 0 ? k : k - 1;
          const bi = axis === 0 ? block(cx * CHUNK_BLOCKS + li, cz * CHUNK_BLOCKS + m) : block(cx * CHUNK_BLOCKS + m, cz * CHUNK_BLOCKS + li);
          // a: along the street from this block's first crossing line; d: in from the building line
          const at = (a: number, d: number): [number, number] => {
            const lat = k * BLOCK + s * (h - d);
            const lon = m * BLOCK + a;
            return axis === 0 ? [ox + lat, oz + lon] : [ox + lon, oz + lat];
          };
          // a model's +z turned to face the street (so its x runs along the kerb)
          const toStreet = axis === 0 ? (-s * Math.PI) / 2 : s > 0 ? Math.PI : 0;
          // driving on the right: a car parked on this side points this way
          const heading = axis === 0 ? (s > 0 ? Math.PI : 0) : s > 0 ? Math.PI / 2 : -Math.PI / 2;
          const a0 = streetHalfWidth(m);
          const a1 = BLOCK - streetHalfWidth(m + 1);
          // the blocks round the Circus are where Dream Walk starts: furnish them more
          const gbx = axis === 0 ? cx * CHUNK_BLOCKS + li : cx * CHUNK_BLOCKS + m;
          const gbz = axis === 0 ? cz * CHUNK_BLOCKS + m : cz * CHUNK_BLOCKS + li;
          const central = Math.max(Math.abs(gbx + 0.5), Math.abs(gbz + 0.5)) < 3;
          const sidewalk = { a0, a1, boulevard, central, toStreet, heading, at, rand, put, tryPut };
          if (bi.kind !== CIRCUS) furnishSidewalk(sidewalk, bi);
          parkCars(sidewalk);
        }
      }
    }
  }
  return out;
}

type TryPut = (x: number, z: number, yaw: number, model: Kit, tone: number, tone2?: number, pad?: number) => boolean;
type Put = (x: number, z: number, yaw: number, model: Kit, tone: number, tone2?: number) => KitRec;

interface Sidewalk {
  a0: number;
  a1: number;
  boulevard: boolean;
  central: boolean;
  toStreet: number;
  heading: number;
  at: (a: number, d: number) => [number, number];
  rand: () => number;
  put: Put;
  tryPut: TryPut;
}

/** A stretch of sidewalk along one side of a block: café terraces, bins, bollards, benches. */
function furnishSidewalk(w: Sidewalk, bi: BlockInfo): void {
  const { a0, a1, boulevard, toStreet, at, rand, put } = w;
  const taken: [number, number][] = []; // stretches of a (with their d band) already used near the facade
  const clear = (a: number, half: number) => taken.every(([lo, hi]) => a + half < lo || a - half > hi);
  const kerb: [number, number][] = []; // stretches of a already used along the kerb (d over 2)
  const kerbClear = (a: number, half: number) => kerb.every(([lo, hi]) => a + half < lo || a - half > hi);

  // Café terraces against the facade: tables in a row under the awnings, a planter at an end, a chalkboard by the kerb
  if (bi.kind === PERIMETER && bi.cafes) {
    const cafes = rand() < (w.central ? 0.9 : 0.6) ? (rand() < 0.35 ? 2 : 1) : 0;
    for (let c = 0; c < cafes; c++) {
      const tone2 = rand();
      const units = 2 + Math.floor(rand() * 6);
      const len = units * 1.6;
      const start = a0 + 1.2 + rand() * Math.max(0, a1 - a0 - 2.4 - len);
      if (!clear(start + len / 2, len / 2 + 1.4)) continue;
      let first = Infinity;
      let last = -Infinity;
      for (let u = 0; u < units; u++) {
        const a = start + 0.8 + u * 1.6;
        if (a > a1 - 1.2 || lampGap(a) < 1.0) continue;
        const [x, z] = at(a, KIT_D.terrace);
        put(x, z, toStreet + (rand() - 0.5) * 0.12, Kit.Terrace, rand(), tone2);
        first = Math.min(first, a);
        last = Math.max(last, a);
      }
      if (first > last) continue;
      // the terrace, with room for a planter at either end
      taken.push([first - 2.0, last + 2.0]);
      for (const [a, p] of [
        [first - 1.35, 0.6],
        [last + 1.35, 0.35],
      ]) {
        if (rand() < p && a > a0 + 0.8 && a < a1 - 0.8 && lampGap(a) > 1.0) {
          const [x, z] = at(a, KIT_D.planter);
          put(x, z, toStreet, Kit.Planter, rand(), tone2);
        }
      }
      if (rand() < 0.75) {
        const a = rand() < 0.5 ? first : last;
        if (!boulevard || treeGap(a) > 0.9) {
          const [x, z] = at(a, KIT_D.menu);
          put(x, z, toStreet + (rand() - 0.5) * 0.5, Kit.Menu, rand());
          kerb.push([a - 0.3, a + 0.3]);
        }
      }
    }
  }
  // A bench or two along a park's edge, backs to the park
  if (bi.kind === PARK) {
    const n = rand() < 0.75 ? 1 + Math.floor(rand() * 3) : 0;
    for (let b = 0; b < n; b++) {
      const a = a0 + 5 + rand() * (a1 - a0 - 10);
      if (lampGap(a) < 1.6 || !clear(a, 1.2)) continue;
      const [x, z] = at(a, KIT_D.parkBench);
      put(x, z, toStreet, Kit.Bench, rand());
      taken.push([a - 1.1, a + 1.1]);
    }
  }
  // Planters along a tower block's frontage
  if (bi.kind === TOWERS && rand() < 0.4) {
    const n = 2 + Math.floor(rand() * 3);
    const start = a0 + 4 + rand() * 8;
    for (let p = 0; p < n; p++) {
      const a = start + p * 4.5;
      if (a > a1 - 2 || lampGap(a) < 1.2 || !clear(a, 0.8)) continue;
      const [x, z] = at(a, KIT_D.planter);
      put(x, z, toStreet, Kit.Planter, rand());
      taken.push([a - 0.7, a + 0.7]);
    }
  }
  // A litter bin by a lamp now and then
  if (bi.kind === PERIMETER || bi.kind === TOWERS) {
    for (let l = LAMP_OFFSET; l < BLOCK; l += LAMP_SPACING) {
      const a = l + 0.75;
      if (a < a0 + 0.6 || a > a1 - 0.6 || rand() >= 0.45 || !clear(a, 0.4)) continue;
      const [x, z] = at(a, KIT_D.bin);
      put(x, z, toStreet, Kit.Bin, rand());
    }
  }
  // Bollards along the kerb: a short row at a corner, now and then a whole street of them
  const row = (from: number, to: number, step: number) => {
    for (let a = from; step > 0 ? a <= to : a >= to; a += step) {
      if ((boulevard && treeGap(a) < 0.9) || !kerbClear(a, 0.15)) continue;
      const [x, z] = at(a, KIT_D.bollard);
      kerb.push([a - 0.1, a + 0.1]);
      put(x, z, 0, Kit.Bollard, rand());
    }
  };
  if (rand() < 0.1 && !boulevard) row(a0 + 0.6, a1 - 0.6, 1.6);
  else {
    if (rand() < 0.5) row(a0 + 0.6, a0 + 0.6 + 1.4 * (2 + Math.floor(rand() * 3)), 1.4);
    if (rand() < 0.5) row(a1 - 0.6, a1 - 0.6 - 1.4 * (2 + Math.floor(rand() * 3)), -1.4);
  }
  // Benches between a boulevard's plane trees, looking at the shops or at the traffic
  if (boulevard) {
    for (let t = 0; t + 1 < BOULEVARD_TREES.count; t++) {
      if (rand() >= (w.central ? 0.75 : 0.5)) continue;
      const a = BOULEVARD_TREES.first + (t + 0.5) * BOULEVARD_TREES.step;
      if (!kerbClear(a, 1.0)) continue;
      const [x, z] = at(a, KIT_D.bench);
      put(x, z, toStreet + (rand() < 0.5 ? Math.PI : 0), Kit.Bench, rand());
    }
  }
}

/** The parking lane along one side of a block: cars nose to tail, clear of the zebras, and now and then a rack of bicycles. */
function parkCars(w: Sidewalk): void {
  const { a0, a1, boulevard, heading, at, rand, put } = w;
  if (rand() >= (boulevard ? 0.8 : 0.88)) return;
  let a = a0 + ZEBRA + 1.0 + rand() * 1.5;
  const end = a1 - ZEBRA - 1.0;
  // bicycles in the first space by the corner
  if (rand() < 0.22 && a + 4 < end) {
    const n = 3 + Math.floor(rand() * 3);
    for (let r = 0; r < n; r++) {
      const [x, z] = at(a + 0.4 + r * 0.85, KIT_D.rack);
      if (circus(x, z, 1)) continue;
      // the bicycles at right angles to the kerb (the rack's hoop runs along the model's x)
      put(x, z, heading + (rand() < 0.5 ? Math.PI : 0), Kit.Rack, rand());
    }
    a += 0.8 + n * 0.85 + 0.6;
  }
  while (a < end) {
    const r = rand();
    const model = r < 0.42 ? Kit.CarHatch : r < 0.8 ? Kit.CarSaloon : Kit.CarVan;
    const len = CAR_LENGTH[model];
    if (a + len > end) break;
    // an empty space now and then
    if (rand() < 0.12) {
      a += len + 1;
      continue;
    }
    const [x, z] = at(a + len / 2, KIT_D.car + (rand() - 0.5) * 0.12);
    const yaw = heading + (rand() < 0.08 ? Math.PI : 0) + (rand() - 0.5) * 0.03;
    const tone = rand();
    if (!circus(x, z, len / 2)) put(x, z, yaw, model, tone);
    a += len + 0.6 + rand() * 1.3;
  }
}

/** A paved square: a metro entrance, a kiosk, columns, a fountain ringed by benches, a terrace under parasols. */
function plaza(edge: (e: number, t: number, inset: number) => [number, number, number], mx: number, mz: number, rand: () => number, tryPut: TryPut): void {
  const em = Math.floor(rand() * 4);
  // the metro along one side, its mouth turned along the side
  {
    const [x, z, yaw] = edge(em, (rand() - 0.5) * 0.4, 3.4);
    tryPut(x, z, yaw + Math.PI / 2, Kit.Metro, rand());
  }
  // a kiosk on another side, facing the street
  const ek = (em + 1 + Math.floor(rand() * 3)) % 4;
  {
    const [x, z, yaw] = edge(ek, (rand() - 0.5) * 0.6, 3);
    tryPut(x, z, yaw, Kit.Kiosk, rand());
  }
  // advertising columns
  for (let c = 0; c < 2; c++) {
    const [x, z] = edge(Math.floor(rand() * 4), (rand() < 0.5 ? -1 : 1) * (0.45 + rand() * 0.2), 2.6);
    tryPut(x, z, rand() * 6.28, Kit.Column, rand());
  }
  // a fountain with benches round it
  const fx = mx + (rand() - 0.5) * 6;
  const fz = mz + (rand() - 0.5) * 6;
  if (tryPut(fx, fz, rand() * 6.28, Kit.Fountain, rand())) {
    for (let b = 0; b < 4; b++) {
      const t = (b * Math.PI) / 2 + Math.PI / 4;
      const x = fx + Math.sin(t) * 4.2;
      const z = fz + Math.cos(t) * 4.2;
      tryPut(x, z, facing(fx - x, fz - z), Kit.Bench, rand());
      if (b % 2 === 0) tryPut(x + Math.cos(t) * 1.4, z - Math.sin(t) * 1.4, facing(fx - x, fz - z), Kit.Bin, rand());
    }
  }
  // the terrace: tables under parasols in rows, on the side across from the metro, planters along its front
  const et = em ^ 1;
  const tone2 = rand();
  const rows = 2 + Math.floor(rand() * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = -3; c <= 3; c++) {
      if (rand() < 0.15) continue;
      const [x, z, yaw] = edge(et, c * 0.1, 5 + r * 3.3);
      tryPut(x, z, yaw + rand() * 0.4, Kit.Parasol, rand(), tone2, 0.2);
    }
  }
  for (let c = -2; c <= 2; c++) {
    const [x, z, yaw] = edge(et, c * 0.1, 5 + rows * 3.3 - 0.9);
    tryPut(x, z, yaw + Math.PI / 2, Kit.Planter, rand(), tone2);
  }
  // bicycles by the metro
  for (let r = 0; r < 4; r++) {
    const [x, z, yaw] = edge(em, 0.35 + r * 0.04, 2.2);
    tryPut(x, z, yaw + Math.PI, Kit.Rack, rand());
  }
}

/** A park: benches round the pond on the ring path, a kiosk or a column by a corner, now and then a metro or a fountain. */
function park(
  edge: (e: number, t: number, inset: number) => [number, number, number],
  mx: number,
  mz: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  rand: () => number,
  tryPut: TryPut,
): void {
  // the ring path round the pond is 9 to 13 m out; the benches stand on its outer edge, looking in
  for (let q = 0; q < 4; q++) {
    for (const off of [-0.26, 0.26]) {
      if (rand() < 0.15) continue;
      const t = (q * Math.PI) / 2 + off;
      const x = mx + Math.sin(t) * 12.4;
      const z = mz + Math.cos(t) * 12.4;
      tryPut(x, z, facing(mx - x, mz - z), Kit.Bench, rand());
    }
  }
  for (let q = 0; q < 4; q++) {
    if (rand() >= 0.35) continue;
    const t = (q * Math.PI) / 2;
    const x = mx + Math.sin(t) * 13.9;
    const z = mz + Math.cos(t) * 13.9;
    tryPut(x, z, facing(mx - x, mz - z), Kit.Bin, rand());
  }
  // by the corners, off the diagonal paths
  for (let c = 0; c < 4; c++) {
    const r = rand();
    if (r >= 0.5) continue;
    const sx = c & 1 ? 1 : -1;
    const sz = c & 2 ? 1 : -1;
    const x = sx > 0 ? x1 - 2.4 : x0 + 2.4;
    const z = sz > 0 ? z1 - 7 : z0 + 7;
    const model = r < 0.2 ? Kit.Kiosk : r < 0.38 ? Kit.Column : Kit.Fountain;
    tryPut(x, z, model === Kit.Kiosk ? (sx > 0 ? Math.PI / 2 : -Math.PI / 2) : rand() * 6.28, model, rand());
  }
  if (rand() < 0.25) {
    const [x, z, yaw] = edge(Math.floor(rand() * 4), 0.5, 2.6);
    tryPut(x, z, yaw + Math.PI / 2, Kit.Metro, rand());
  }
}

/** Round the towers: planters and benches along their forecourts, a column now and then. */
function forecourts(rects: readonly Rect[], x0: number, x1: number, z0: number, z1: number, rand: () => number, tryPut: TryPut): void {
  for (const t of rects) {
    // only this block's towers (the block's own outline is a rect too, for the perimeter blocks: not here)
    if (t.x0 < x0 - 0.1 || t.x1 > x1 + 0.1 || t.z0 < z0 - 0.1 || t.z1 > z1 + 0.1) continue;
    const sides: [number, number, number, number, number][] = [
      // x, z of the side's middle, its half length, the yaw out from it, and whether it runs along x
      [(t.x0 + t.x1) / 2, t.z0 - 2.4, (t.x1 - t.x0) / 2, Math.PI, 1],
      [(t.x0 + t.x1) / 2, t.z1 + 2.4, (t.x1 - t.x0) / 2, 0, 1],
      [t.x0 - 2.4, (t.z0 + t.z1) / 2, (t.z1 - t.z0) / 2, -Math.PI / 2, 0],
      [t.x1 + 2.4, (t.z0 + t.z1) / 2, (t.z1 - t.z0) / 2, Math.PI / 2, 0],
    ];
    for (const [sx, sz, half, yaw, alongX] of sides) {
      if (rand() >= 0.55) continue;
      const n = Math.max(1, Math.floor(half / 4));
      const bench = rand() < 0.5;
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * 7.5;
        const x = alongX ? sx + o : sx;
        const z = alongX ? sz : sz + o;
        tryPut(x, z, yaw, bench && i % 2 ? Kit.Bench : Kit.Planter, rand(), rand(), 0.3);
      }
      if (rand() < 0.3) {
        const o = half + 2.5;
        tryPut(alongX ? sx + o : sx, alongX ? sz : sz + o, rand() * 6.28, Kit.Column, rand(), 0, 0.4);
      }
    }
  }
}

/**
 * One quarter of the Circus round the totem (qx, qz: which quarter), laid out by hand. The Circus is open
 * paving from 46 m out to the building lines, a ring of pavement 40 to 46 m out round the roadway, then the
 * lawn and the paved hub round the totem. Each quarter is laid out in the frame of the north-east one and
 * mirrored into place; the four differ (which is which depends on the seed). Dream Walk starts at the south
 * corner of the boulevard (x 10, z -70), looking north into the Circus, so the two southern quarters are
 * the first thing a dreamer sees.
 */
function circusQuarter(qx: number, qz: number, seed: number, tryPut: TryPut): void {
  const rand = rng(Math.floor(hash3(qx + 5, qz + 9, seed + 811) * 4294967296));
  const P = (x: number, z: number, yaw: number, model: Kit, tone = rand(), tone2 = 0, pad = 0.15) => {
    // mirror the position and the direction the model faces
    const sx = Math.sin(yaw) * qx;
    const sz = Math.cos(yaw) * qz;
    tryPut(x * qx, z * qz, Math.atan2(sx, sz), model, tone, tone2, pad);
  };
  // The southern quarters (seen from the start) get the terrace and the metro; the northern ones the fountain
  // and the second terrace. Which of each pair is which is up to the seed.
  const swap = hash3(seed, 3, 17) < 0.5 ? 1 : -1;
  const variant = qz < 0 ? (qx * swap > 0 ? 0 : 1) : qx * swap > 0 ? 2 : 3;
  const toCentre = (x: number, z: number) => facing(-x, -z);

  // round the ring: bollards along the kerb of the pavement, benches facing the lawn, bins between
  for (let t = 18; t <= 72; t += 2.6) {
    const a = (t * Math.PI) / 180;
    P(Math.cos(a) * 40.8, Math.sin(a) * 40.8, 0, Kit.Bollard);
  }
  for (const t of [24, 34, 56, 66]) {
    const a = (t * Math.PI) / 180;
    const x = Math.cos(a) * 44.3;
    const z = Math.sin(a) * 44.3;
    P(x, z, toCentre(x, z), Kit.Bench);
    const b = ((t + 4) * Math.PI) / 180;
    if (t === 34 || t === 66) P(Math.cos(b) * 44.6, Math.sin(b) * 44.6, toCentre(x, z), Kit.Bin);
  }
  // round the hub, benches with their backs to the totem, looking out over the lawn
  for (const t of [28, 62]) {
    const a = (t * Math.PI) / 180;
    const x = Math.cos(a) * 12.9;
    const z = Math.sin(a) * 12.9;
    P(x, z, facing(x, z), Kit.Bench);
  }

  if (variant === 0) {
    // a café's terrace under parasols by the boulevard, its kiosk at the far end
    const tone2 = rand();
    for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) P(17.5 + c * 3.5, 49.6 + r * 3.5, rand(), Kit.Parasol, rand(), tone2, 0.1);
    for (let c = 0; c < 6; c++) P(16.5 + c * 3.3, 47.2, 0, Kit.Planter, rand(), tone2);
    P(15, 47.8, toCentre(15, 47.8), Kit.Menu);
    P(36.5, 52, -Math.PI / 2, Kit.Kiosk);
    P(46.5, 33, 0, Kit.Column);
    P(51.5, 21, 0, Kit.Column);
    for (let r = 0; r < 5; r++) P(54.5, 26 + r * 0.9, 0, Kit.Rack);
    P(41, 45.5, toCentre(41, 45.5), Kit.Fountain);
  } else if (variant === 1) {
    // a metro entrance by the boulevard, a kiosk, columns, bicycles, benches
    P(19.5, 50.5, -Math.PI / 2, Kit.Metro);
    for (let r = 0; r < 6; r++) P(15.5 + r * 0.9, 54.5, Math.PI / 2, Kit.Rack);
    P(29, 52.5, Math.PI, Kit.Kiosk);
    P(26, 47.2, toCentre(26, 47.2), Kit.Column);
    P(40, 47, 0, Kit.Column);
    for (const [x, z] of [
      [34, 49],
      [37.5, 50.5],
      [47, 38],
      [50, 30],
    ]) {
      P(x, z, toCentre(x, z), Kit.Bench);
    }
    P(48.5, 22, 0, Kit.Fountain);
    P(35.5, 47.8, 0, Kit.Bin);
  } else if (variant === 2) {
    // a fountain in a ring of benches, planters, a column and bicycles
    P(38, 38, 0, Kit.Fountain);
    for (let b = 0; b < 4; b++) {
      const t = (b * Math.PI) / 2 + Math.PI / 4;
      const x = 38 + Math.sin(t) * 4.2;
      const z = 38 + Math.cos(t) * 4.2;
      P(x, z, facing(38 - x, 38 - z), Kit.Bench);
    }
    for (let p = 0; p < 4; p++) P(20 + p * 4.2, 48, 0, Kit.Planter);
    P(22, 52.5, 0, Kit.Column);
    P(50, 24, Math.PI / 2, Kit.Kiosk);
    for (let r = 0; r < 5; r++) P(30 + r * 0.9, 54.5, Math.PI / 2, Kit.Rack);
    P(52, 40, 0, Kit.Bin);
  } else {
    // a second terrace along the cross street, a metro and a kiosk
    const tone2 = rand();
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) P(48.5 + r * 3.5, 18 + c * 3.5, rand(), Kit.Parasol, rand(), tone2, 0.1);
    for (let c = 0; c < 4; c++) P(46.4, 18 + c * 3.5, Math.PI / 2, Kit.Planter, rand(), tone2);
    P(21, 52.5, Math.PI, Kit.Kiosk);
    P(38, 50.5, -Math.PI / 2, Kit.Metro);
    P(30, 47.5, 0, Kit.Column);
    P(47, 36, toCentre(47, 36), Kit.Bench);
  }
}
