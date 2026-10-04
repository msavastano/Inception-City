/**
 * World constants. Everything is measured in metres in *fabric space*:
 * the flat, unfolded sheet the city is generated on (see docs/CITY_PLAN.md).
 */

/** Distance between street centrelines. */
export const BLOCK = 64;
/** Blocks per chunk edge. Every CHUNK_BLOCKS-th street is a boulevard. */
export const CHUNK_BLOCKS = 4;
/** Chunk edge length: the unit of generation, streaming and allocation. */
export const CHUNK = BLOCK * CHUNK_BLOCKS;

/** Half-widths (centreline to building line) of ordinary streets and boulevards. */
export const STREET_HALF = 7;
export const BOULEVARD_HALF = 12;
/** Sidewalk width, measured inward from the building line. */
export const SIDEWALK = 3;

/** Maximum simultaneous folds (a uniform-array budget shared by CPU and GPU). */
export const MAX_FOLDS = 8;

/** Per-chunk instance slab sizes. A slab is reserved for each streamed chunk. */
export const SLAB = {
  building: 224,
  roof: 288,
  tree: 128,
  lamp: 128,
} as const;

/** Ground tile tessellation: coarse tiles are rigid, fine tiles can bend. */
export const GROUND_FINE_SEGMENTS = 40;
export const GROUND_COARSE_SEGMENTS = 2;

/** Lamp spacing along every street (lamps sit at 16 and 48 metres into each block). */
export const LAMP_SPACING = 32;
export const LAMP_OFFSET = 16;

export function streetHalfWidth(lineIndex: number): number {
  return mod(lineIndex, CHUNK_BLOCKS) === 0 ? BOULEVARD_HALF : STREET_HALF;
}

export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
