import { BLOCK, BOULEVARD_HALF, GUTTER, SIDEWALK, streetHalfWidth } from '../core/config';
import { BlockKind, blockKind } from './generator';

/**
 * What is underfoot at a point of the fabric. The ground is painted by a
 * shader (paintGround in shaders.ts) from the same layout rules; this is the
 * same reading of them on the CPU, for the things that are heard and not seen:
 * footsteps, the rain on an awning, birds in the trees.
 */
export type Ground = 'paving' | 'asphalt' | 'grass' | 'gravel' | 'water';

/** Distance from the nearest street centre line along each axis, and that street's half-width. */
function street(v: number): { d: number; hw: number } {
  const line = Math.floor(v / BLOCK + 0.5);
  return { d: Math.abs(v - line * BLOCK), hw: streetHalfWidth(line) };
}

export function groundAt(x: number, z: number, seed: number): Ground {
  // the circus around the origin: paved hub, a ring of lawn, the roadway, then pavement
  const r0 = Math.hypot(x, z);
  if (r0 < 46) {
    if (r0 < 14) return 'paving';
    if (r0 < 24) return 'grass';
    if (r0 < 25) return 'paving';
    return r0 < 40 ? 'asphalt' : 'paving';
  }
  const sx = street(x);
  const sz = street(z);
  if (sx.d <= sx.hw || sz.d <= sz.hw) {
    const roadX = sx.d <= sx.hw - SIDEWALK;
    const roadZ = sz.d <= sz.hw - SIDEWALK;
    if (!roadX && !roadZ) return 'paving';
    // the last half metre before a kerb is a gutter of granite setts (but not where the street crosses another)
    const gutter = (roadX && sz.d > sz.hw && sx.d > sx.hw - SIDEWALK - GUTTER) || (roadZ && sx.d > sx.hw && sz.d > sz.hw - SIDEWALK - GUTTER);
    return gutter ? 'paving' : 'asphalt';
  }
  const bx = Math.floor(x / BLOCK);
  const bz = Math.floor(z / BLOCK);
  if (blockKind(bx, bz, seed) !== BlockKind.Park) return 'paving';
  // a park: lawn, crossed by diagonal gravel paths and a ring path round the pond
  const qx = x - (bx + 0.5) * BLOCK;
  const qz = z - (bz + 0.5) * BLOCK;
  const r = Math.hypot(qx, qz);
  if (r < 6) return 'water';
  if (r < 7) return 'paving';
  if (Math.abs(Math.abs(qx) - Math.abs(qz)) < 2.2 || Math.abs(r - 11) < 2) return 'gravel';
  return 'grass';
}

/**
 * How far under cover a walker is, 0 (open sky) to 1 (against a facade, under
 * its awnings and cornices). Only the sidewalks of built-up blocks give any.
 */
export function shelterAt(x: number, z: number, seed: number): number {
  if (Math.hypot(x, z) < 46) return 0;
  const sx = street(x);
  const sz = street(z);
  const built = (bx: number, bz: number) => {
    const k = blockKind(bx, bz, seed);
    return k === BlockKind.Perimeter || k === BlockKind.Towers;
  };
  let best = 0;
  // on a sidewalk, the block on this side of the street's centre line owns the facade
  const bx = Math.floor(x / BLOCK);
  const bz = Math.floor(z / BLOCK);
  for (const s of [sx, sz]) {
    if (s.d > s.hw || s.d <= s.hw - SIDEWALK) continue;
    if (!built(bx, bz)) continue;
    const gap = s.hw - s.d; // metres out from the building line
    best = Math.max(best, 1 - smooth(0.8, 2.8, gap));
  }
  return best;
}

/** How much greenery is in earshot, 0 to 1: parks and the circus lawn, then tree-lined boulevards. */
export function greenAt(x: number, z: number, seed: number): number {
  const r0 = Math.hypot(x, z);
  if (r0 < 60) return 0.8;
  const bx = Math.floor(x / BLOCK);
  const bz = Math.floor(z / BLOCK);
  let green = 0.15;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (blockKind(bx + dx, bz + dz, seed) !== BlockKind.Park) continue;
      // distance from the point to that block's square
      const cx = Math.max((bx + dx) * BLOCK, Math.min(x, (bx + dx + 1) * BLOCK));
      const cz = Math.max((bz + dz) * BLOCK, Math.min(z, (bz + dz + 1) * BLOCK));
      green = Math.max(green, 1 - 0.75 * smooth(0, 70, Math.hypot(x - cx, z - cz)));
    }
  }
  // boulevards carry a row of trees down each side
  const sx = street(x);
  const sz = street(z);
  if ((sx.hw >= BOULEVARD_HALF && sx.d < sx.hw + 6) || (sz.hw >= BOULEVARD_HALF && sz.d < sz.hw + 6)) green = Math.max(green, 0.55);
  return green;
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
