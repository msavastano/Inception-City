import { BLOCK, BOULEVARD_HALF, BOULEVARD_TREES, CHUNK, CHUNK_BLOCKS, LAMP_OFFSET, LAMP_SPACING, SLAB, streetHalfWidth } from '../core/config';
import { hash3, rng } from '../core/rng';
import type { Circle, PropRec, Rect } from './generator';

/**
 * THE STREET LIFE KIT
 *
 * What makes a Paris street look lived in at eye level: café terraces against
 * the facades, cast-iron bollards by the crossings, benches between the plane
 * trees, a bicycle at a rack, advertising columns and news kiosks on the open
 * squares, a metro entrance, and cars parked along the kerbs.
 *
 * Everything here is placed by seed, as a pure function of the chunk, like the
 * rest of the city. Two instanced meshes draw all of it (src/city/geometry.ts):
 * the small furniture, which casts no shadow (like the lamps), and the larger
 * fixtures and cars, which do. Each instance picks its model by variant.
 *
 * Every piece keeps clear of where the crowd walks (src/world/projections.ts:
 * a lattice of straight lanes 1.7 m in from every building line, crossing the
 * streets on the zebras) and of the zebras themselves, which the ground shader
 * paints just past every corner.
 *
 * Sidewalk positions are given as `d`, metres in from the building line: the
 * kerb is at d = 3 (SIDEWALK), the crowd's lane at 1.7, the lamps at 1 and the
 * boulevard trees at 2.5.
 */

/** The small furniture's models (the variant of an instance in the furniture mesh). */
export const enum Furniture {
  /** Two bistro chairs side by side facing the street, a little round table in front: a terrace against a facade. */
  CafePair = 0,
  /** A table with a chair either side under a parasol: a terrace out on a square. */
  CafeParasol = 1,
  /** A row of three cast-iron bollards along the kerb. */
  Bollards = 2,
  /** A bench of wooden slats on iron ends. */
  Bench = 3,
  /** A hoop of a bicycle rack with a bicycle leaning on it. */
  BikeRack = 4,
}

/** The fixtures' models (the variant of an instance in the fixtures mesh). */
export const enum Fixture {
  /** An advertising column: a drum of posters under a little dome. */
  Column = 0,
  /** A news kiosk: an octagonal booth, magazines all round, a hipped roof. */
  Kiosk = 1,
  /** A metro entrance: iron balustrades round a stairwell, two lamp stalks and a blank sign over its mouth. */
  Metro = 2,
  /** Parked cars, all generic: a small hatchback, a saloon and a little van. */
  CarSmall = 3,
  CarSaloon = 4,
  CarVan = 5,
}

export interface KitRec extends PropRec {
  /** Which model (Furniture or Fixture). */
  variant: number;
  /** Café furniture: thrown with the walls when the dream collapses (src/world/collapse.ts). */
  debris: boolean;
}

export interface StreetLife {
  furniture: KitRec[];
  fixtures: KitRec[];
  /** Footprints for first-person collision, added to the chunk's circles. */
  circles: Circle[];
}

/**
 * The palettes the prop shader paints the kit's paint and cloth parts with, by the instance's tone (the shader is
 * written from these, src/city/shaders.ts, and the café explosion tints the thrown furniture with them).
 */
export const PAINT: [number, number, number][] = [
  [0.62, 0.63, 0.64],
  [0.82, 0.82, 0.8],
  [0.07, 0.07, 0.08],
  [0.1, 0.16, 0.3],
  [0.38, 0.06, 0.06],
  [0.32, 0.34, 0.36],
  [0.66, 0.6, 0.48],
  [0.1, 0.22, 0.16],
];
export const CLOTH: [number, number, number][] = [
  [0.6, 0.13, 0.1],
  [0.13, 0.32, 0.22],
  [0.12, 0.18, 0.36],
  [0.72, 0.56, 0.26],
  [0.42, 0.1, 0.16],
  [0.78, 0.74, 0.64],
];
export function paletteColor(list: readonly [number, number, number][], tone: number): [number, number, number] {
  return list[Math.min(list.length - 1, Math.floor(tone * list.length))];
}

/** Lengths of the three cars (metres), by Fixture variant. */
export const CAR_LENGTH: Record<number, number> = { [Fixture.CarSmall]: 3.9, [Fixture.CarSaloon]: 4.6, [Fixture.CarVan]: 4.3 };
export const CAR_WIDTH = 1.76;

/** Where the pieces stand, in metres in from the building line (see the comment at the top). */
export const KIT_D = {
  cafe: 0.62,
  parkBench: 0.55,
  bollard: 2.78,
  bench: 2.5,
  rack: 2.62,
  /** Cars: centre of a car parked against the kerb (in the road, clear of the gutter's setts). */
  car: 4.1,
} as const;

/** How far past a crossing street's building line its zebra runs (the ground shader paints it from there). */
export const ZEBRA = 3.5;

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

/** Distance from a lamp along the street, in a block of street (lamps stand 16 and 48 m into every block). */
function lampGap(a: number): number {
  let g = Infinity;
  for (let l = LAMP_OFFSET; l < BLOCK; l += LAMP_SPACING) g = Math.min(g, Math.abs(a - l));
  return g;
}

/** Inside the stretch of a boulevard where its trees stand. */
function amongTrees(a: number, margin: number): boolean {
  const first = BOULEVARD_TREES.first;
  const last = first + BOULEVARD_TREES.step * (BOULEVARD_TREES.count - 1);
  return a > first - margin && a < last + margin;
}

/** The collision footprint of one piece (circles, fabric metres). */
export function kitFootprint(r: KitRec, fixture: boolean): Circle[] {
  const along = (o: number, rad: number): Circle => ({ x: r.x + Math.sin(r.yaw) * o, z: r.z + Math.cos(r.yaw) * o, r: rad });
  const across = (o: number, rad: number): Circle => ({ x: r.x + Math.cos(r.yaw) * o, z: r.z - Math.sin(r.yaw) * o, r: rad });
  if (fixture) {
    switch (r.variant) {
      case Fixture.Column:
        return [{ x: r.x, z: r.z, r: 0.66 }];
      case Fixture.Kiosk:
        return [{ x: r.x, z: r.z, r: 1.15 }];
      case Fixture.Metro:
        return [along(-0.9, 0.95), along(0.9, 0.95)];
      default: {
        const half = CAR_LENGTH[r.variant] / 2 - CAR_WIDTH / 2;
        return [along(-half, CAR_WIDTH / 2), along(0, CAR_WIDTH / 2), along(half, CAR_WIDTH / 2)];
      }
    }
  }
  switch (r.variant) {
    case Furniture.CafePair:
      return [{ x: r.x, z: r.z, r: 0.6 }];
    case Furniture.CafeParasol:
      return [{ x: r.x, z: r.z, r: 0.95 }];
    case Furniture.Bollards:
      return [across(-1.3, 0.14), across(0, 0.14), across(1.3, 0.14)];
    case Furniture.Bench:
      return [across(-0.5, 0.36), across(0.5, 0.36)];
    default:
      return [across(-0.55, 0.32), across(0.55, 0.32)];
  }
}

/**
 * Place the kit on a chunk. Each chunk owns the streets along its west and
 * south edges and the three between (as with the lamps), both sides of them,
 * and the insides of its own sixteen blocks.
 *
 * `occupied` holds what is already there (trees, tower footprints), so the
 * fixtures on squares and in forecourts can find room.
 */
export function placeStreetLife(cx: number, cz: number, seed: number, block: (bx: number, bz: number) => BlockInfo, occupied: { circles: Circle[]; rects: Rect[] }): StreetLife {
  const out: StreetLife = { furniture: [], fixtures: [], circles: [] };
  const rand = rng(Math.floor(hash3(cx * 7 + 3, cz * 13 + 5, seed + 501) * 4294967296));
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;

  const add = (list: KitRec[], rec: KitRec, fixture: boolean): boolean => {
    if (list.length >= (fixture ? SLAB.fixtures : SLAB.furniture)) return false;
    list.push(rec);
    out.circles.push(...kitFootprint(rec, fixture));
    return true;
  };
  const furniture = (x: number, z: number, yaw: number, variant: Furniture, tone: number) =>
    add(out.furniture, { x, z, yaw, scale: 1, tone, variant, debris: variant === Furniture.CafePair || variant === Furniture.CafeParasol }, false);
  const fixture = (x: number, z: number, yaw: number, variant: Fixture, tone: number) => add(out.fixtures, { x, z, yaw, scale: 1, tone, variant, debris: false }, true);

  /** Clear of trees, buildings and kit already placed, by at least r. */
  const free = (x: number, z: number, r: number): boolean => {
    for (const c of occupied.circles) if (Math.hypot(x - c.x, z - c.z) < c.r + r) return false;
    for (const c of out.circles) if (Math.hypot(x - c.x, z - c.z) < c.r + r) return false;
    for (const b of occupied.rects) {
      const dx = Math.max(b.x0 - x, 0, x - b.x1);
      const dz = Math.max(b.z0 - z, 0, z - b.z1);
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  };

  // ---- Inside the blocks: squares, park corners and tower forecourts ----
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
      // a point `inset` in from edge e (0 south, 1 north, 2 west, 3 east), `t` (-1..1) of the way along it,
      // and the yaw that turns a model's +z out to that edge's street
      const edge = (e: number, t: number, inset: number): [number, number, number] => {
        if (e === 0) return [mx + t * (x1 - x0) * 0.5, z0 + inset, Math.PI];
        if (e === 1) return [mx + t * (x1 - x0) * 0.5, z1 - inset, 0];
        if (e === 2) return [x0 + inset, mz + t * (z1 - z0) * 0.5, -Math.PI / 2];
        return [x1 - inset, mz + t * (z1 - z0) * 0.5, Math.PI / 2];
      };
      const brand = rng(Math.floor(hash3(bx, bz, seed + 777) * 4294967296));

      if (info.kind === PLAZA) {
        // a metro entrance along one side, a kiosk and a column on two others, and a terrace under parasols
        const em = Math.floor(brand() * 4);
        const [mxe, mze, myaw] = edge(em, (brand() - 0.5) * 0.4, 2.6);
        if (free(mxe, mze, 2)) fixture(mxe, mze, myaw + Math.PI / 2, Fixture.Metro, brand());
        const ek = (em + 1 + Math.floor(brand() * 3)) % 4;
        const [kx, kz, kyaw] = edge(ek, (brand() - 0.5) * 0.8, 3);
        if (free(kx, kz, 1.4)) fixture(kx, kz, kyaw, Fixture.Kiosk, brand());
        const ec = (ek + 1 + Math.floor(brand() * 2)) % 4;
        const [colx, colz] = edge(ec === em ? (ec + 1) % 4 : ec, (brand() - 0.5) * 0.8, 2.4);
        if (free(colx, colz, 1)) fixture(colx, colz, brand() * 6.28, Fixture.Column, brand());
        // the terrace: a few tables in rows, on the side across from the metro
        const et = em ^ 1;
        const tone = brand();
        const rows = 1 + Math.floor(brand() * 2);
        for (let r = 0; r < rows; r++) {
          for (let c = -2; c <= 2; c++) {
            if (brand() < 0.2) continue;
            const [tx, tz, tyaw] = edge(et, c * 0.13, 6 + r * 3);
            if (free(tx, tz, 1.1)) furniture(tx, tz, tyaw, Furniture.CafeParasol, tone);
          }
        }
      } else if (info.kind === PARK) {
        // a column or a kiosk at a corner, off the diagonal paths; now and then a metro entrance on a side
        for (let c = 0; c < 4; c++) {
          if (brand() >= 0.32) continue;
          const sx = c & 1 ? 1 : -1;
          const sz = c & 2 ? 1 : -1;
          const x = sx > 0 ? x1 - 2.2 : x0 + 2.2;
          const z = sz > 0 ? z1 - 6.5 : z0 + 6.5;
          const kiosk = brand() < 0.4;
          if (!free(x, z, kiosk ? 1.6 : 1.1)) continue;
          fixture(x, z, kiosk ? (sx > 0 ? Math.PI / 2 : -Math.PI / 2) : brand() * 6.28, kiosk ? Fixture.Kiosk : Fixture.Column, brand());
        }
        if (brand() < 0.22) {
          const [x, z, yaw] = edge(Math.floor(brand() * 4), 0, 2.2);
          if (free(x, z, 2.1)) fixture(x, z, yaw + Math.PI / 2, Fixture.Metro, brand());
        }
      } else {
        // a column in a tower's forecourt, if there is room in front of it
        for (let e = 0; e < 4; e++) {
          if (brand() >= 0.3) continue;
          const [x, z] = edge(e, (brand() < 0.5 ? -1 : 1) * 0.7, 1.9);
          if (free(x, z, 1.4)) fixture(x, z, brand() * 6.28, Fixture.Column, brand());
        }
      }
    }
  }
  // ---- The streets: every owned street line, both sides, block by block ----
  for (const axis of [0, 1]) {
    for (let k = 0; k < CHUNK_BLOCKS; k++) {
      const h = streetHalfWidth(k);
      const boulevard = h === BOULEVARD_HALF;
      for (const s of [-1, 1]) {
        for (let m = 0; m < CHUNK_BLOCKS; m++) {
          // the blocks on this side and across the street
          const i = s > 0 ? k : k - 1;
          const j = s > 0 ? k - 1 : k;
          const bi = axis === 0 ? block(cx * CHUNK_BLOCKS + i, cz * CHUNK_BLOCKS + m) : block(cx * CHUNK_BLOCKS + m, cz * CHUNK_BLOCKS + i);
          const bj = axis === 0 ? block(cx * CHUNK_BLOCKS + j, cz * CHUNK_BLOCKS + m) : block(cx * CHUNK_BLOCKS + m, cz * CHUNK_BLOCKS + j);
          // the Circus has its own round place, and no sidewalks to furnish
          if (bi.kind === CIRCUS || bj.kind === CIRCUS) continue;

          // a: along the street from this block's first crossing line; d: in from the building line
          const at = (a: number, d: number): [number, number] => {
            const lat = k * BLOCK + s * (h - d);
            const lon = m * BLOCK + a;
            return axis === 0 ? [ox + lat, oz + lon] : [ox + lon, oz + lat];
          };
          // a model's +z turned to face the street (so its x runs along the kerb)
          const toStreet = axis === 0 ? (-s * Math.PI) / 2 : s > 0 ? Math.PI : 0;
          const hA = streetHalfWidth(m);
          const hB = streetHalfWidth(m + 1);
          const a0 = hA;
          const a1 = BLOCK - hB;

          // Café terrace against the facade
          if (bi.kind === PERIMETER && bi.cafes && rand() < 0.28) {
            const tone = rand();
            const len = 3.5 + rand() * 5;
            const start = a0 + 1 + rand() * Math.max(0, a1 - a0 - 2 - len);
            for (let a = start + 0.8; a < start + len && a < a1 - 0.8; a += 1.75) {
              if (lampGap(a) < 1.3) continue;
              const [x, z] = at(a, KIT_D.cafe);
              furniture(x, z, toStreet, Furniture.CafePair, tone);
            }
          }
          // A bench or two along a park's edge, backs to the park
          if (bi.kind === PARK && rand() < 0.5) {
            const n = 1 + (rand() < 0.4 ? 1 : 0);
            for (let b = 0; b < n; b++) {
              const a = a0 + 6 + rand() * (a1 - a0 - 12);
              if (lampGap(a) < 1.5) continue;
              const [x, z] = at(a, KIT_D.parkBench);
              if (free(x, z, 0.8)) furniture(x, z, toStreet, Furniture.Bench, rand());
            }
          }
          // Bollards along the kerb just past the zebras
          for (const end of [0, 1]) {
            if (rand() >= 0.3) continue;
            const a = end === 0 ? a0 + ZEBRA + 1.3 : a1 - ZEBRA - 1.3;
            const [x, z] = at(a, KIT_D.bollard);
            furniture(x, z, toStreet, Furniture.Bollards, rand());
          }
          // Benches between the boulevard's plane trees, looking at the shops
          if (boulevard) {
            for (const a of [BOULEVARD_TREES.first + BOULEVARD_TREES.step / 2, BOULEVARD_TREES.first + (BOULEVARD_TREES.step * 3) / 2]) {
              if (rand() >= 0.4) continue;
              const [x, z] = at(a, KIT_D.bench);
              furniture(x, z, toStreet + Math.PI, Furniture.Bench, rand());
            }
          }
          // A bicycle at a rack by the kerb
          if (rand() < 0.16) {
            const a = a0 + ZEBRA + 5 + rand() * (a1 - a0 - 2 * ZEBRA - 10);
            if (!(boulevard && amongTrees(a, 2))) {
              const [x, z] = at(a, KIT_D.rack);
              if (free(x, z, 0.4)) furniture(x, z, toStreet, Furniture.BikeRack, rand());
            }
          }
          // Now and then a short run of parked cars along the kerb, clear of the zebras at both ends
          if (rand() < 0.3) {
            const heading = (axis === 0 ? 0 : Math.PI / 2) + (s > 0 === (axis === 0) ? Math.PI : 0);
            const lo = a0 + ZEBRA + 1.2;
            const hi = a1 - ZEBRA - 1.2;
            let a = lo + rand() * (hi - lo) * 0.6;
            for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
              const r = rand();
              const variant = r < 0.42 ? Fixture.CarSmall : r < 0.84 ? Fixture.CarSaloon : Fixture.CarVan;
              const len = CAR_LENGTH[variant];
              if (a + len > hi) break;
              const [x, z] = at(a + len / 2, KIT_D.car);
              if (!fixture(x, z, heading, variant, rand())) break;
              a += len + 0.8 + rand() * 1.6;
            }
          }
        }
      }
    }
  }

  return out;
}
