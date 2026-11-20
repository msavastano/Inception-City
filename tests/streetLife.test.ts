import { describe, expect, it } from 'vitest';
import { BLOCK, SIDEWALK, SLAB, streetHalfWidth } from '../src/core/config';
import { generateChunk } from '../src/city/generator';
import { KIT_STRIDE, fixturesGeometry, furnitureGeometry } from '../src/city/geometry';
import { Fixture, Furniture, type KitRec, ZEBRA, kitFootprint } from '../src/city/streetLife';

/** Each model's vertices (model frame), from a kit mesh: aPart carries the model. */
function models(g: ReturnType<typeof furnitureGeometry>): Map<number, number[][]> {
  const out = new Map<number, number[][]>();
  const pos = g.attributes.position;
  const part = g.attributes.aPart;
  for (let i = 0; i < pos.count; i++) {
    const v = Math.floor(part.getX(i) / KIT_STRIDE + 0.01) - 1;
    if (!out.has(v)) out.set(v, []);
    out.get(v)!.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  }
  return out;
}
const FURNITURE = models(furnitureGeometry());
const FIXTURES = models(fixturesGeometry());
/** A placed piece's vertices in fabric space (the prop shader's rotY). */
function placed(p: KitRec, fixture: boolean): number[][] {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return (fixture ? FIXTURES : FURNITURE).get(p.variant)!.map(([x, y, z]) => [p.x + c * x + s * z, y, p.z - s * x + c * z]);
}

const AREA = 4;
function* chunks(seed: number) {
  for (let cx = -AREA; cx <= AREA; cx++) for (let cz = -AREA; cz <= AREA; cz++) yield generateChunk(cx, cz, seed);
}

/** The crowd's lanes on one axis near a coordinate: 1.7 m in from the building lines either side of a street line. */
function laneGap(v: number): number {
  let g = Infinity;
  const n = Math.round(v / BLOCK);
  for (let line = n - 1; line <= n + 1; line++) {
    const o = streetHalfWidth(line) - 1.7;
    g = Math.min(g, Math.abs(v - (line * BLOCK - o)), Math.abs(v - (line * BLOCK + o)));
  }
  return g;
}

/** Distance from a coordinate to the nearest street line, and that line's half-width. */
function nearestLine(v: number): { dist: number; half: number } {
  const n = Math.round(v / BLOCK);
  return { dist: Math.abs(v - n * BLOCK), half: streetHalfWidth(n) };
}

describe('street life kit', () => {
  it('is placed by seed, and fits its instance slabs', () => {
    expect(generateChunk(2, -1, 9).furniture).toEqual(generateChunk(2, -1, 9).furniture);
    expect(generateChunk(2, -1, 9).fixtures).not.toEqual(generateChunk(2, -1, 10).fixtures);
    let maxF = 0;
    let maxX = 0;
    for (const seed of [1, 7, 31337]) {
      for (const c of chunks(seed)) {
        maxF = Math.max(maxF, c.furniture.length);
        maxX = Math.max(maxX, c.fixtures.length);
      }
    }
    // full slabs would mean pieces were dropped
    expect(maxF).toBeLessThan(SLAB.furniture);
    expect(maxX).toBeLessThan(SLAB.fixtures);
  });

  it('has every kind of piece somewhere', () => {
    const seen = { f: new Set<number>(), x: new Set<number>() };
    for (const seed of [1, 7, 31337]) {
      for (const c of chunks(seed)) {
        c.furniture.forEach((p) => seen.f.add(p.variant));
        c.fixtures.forEach((p) => seen.x.add(p.variant));
      }
    }
    for (const v of [Furniture.CafePair, Furniture.CafeParasol, Furniture.Bollards, Furniture.Bench, Furniture.BikeRack]) expect(seen.f.has(v)).toBe(true);
    for (const v of [Fixture.Column, Fixture.Kiosk, Fixture.Metro, Fixture.CarSmall, Fixture.CarSaloon, Fixture.CarVan]) expect(seen.x.has(v)).toBe(true);
  });

  it("keeps the crowd's lanes clear", () => {
    for (const c of chunks(7)) {
      for (const [list, fixture] of [
        [c.furniture, false],
        [c.fixtures, true],
      ] as const) {
        for (const p of list) {
          for (const f of kitFootprint(p, fixture)) {
            expect(laneGap(f.x) - f.r).toBeGreaterThan(0.3);
            expect(laneGap(f.z) - f.r).toBeGreaterThan(0.3);
          }
        }
      }
    }
  });

  it('has a model for every kind of piece, every vertex of it in one', () => {
    expect([...FURNITURE.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...FIXTURES.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps the models themselves (below head height) off the crowd's lanes", () => {
    for (const cz of [-1, 0, 2]) {
      for (const cx of [-2, 1]) {
        const c = generateChunk(cx, cz, 7);
        for (const [list, fixture] of [
          [c.furniture, false],
          [c.fixtures, true],
        ] as const) {
          for (const p of list) {
            let worst = Infinity;
            for (const [x, y, z] of placed(p, fixture)) if (y < 2.1) worst = Math.min(worst, laneGap(x), laneGap(z));
            expect(worst).toBeGreaterThan(0.3);
          }
        }
      }
    }
  });

  it('parks the cars in the road, clear of the zebras and the kerb', () => {
    for (const c of chunks(7)) {
      for (const p of c.fixtures) {
        if (p.variant < Fixture.CarSmall) continue;
        const alongZ = Math.abs(Math.sin(p.yaw)) < 0.5;
        const across = nearestLine(alongZ ? p.x : p.z);
        // kerb side of the car is in the road (the kerb is SIDEWALK in from the building line)
        expect(across.half - SIDEWALK - (across.dist + 0.88)).toBeGreaterThan(0);
        for (const f of kitFootprint(p, true)) {
          const along = nearestLine(alongZ ? f.z : f.x);
          expect(along.dist - f.r).toBeGreaterThan(along.half + ZEBRA);
        }
      }
    }
  });

  it('keeps furniture on the sidewalk or inside the blocks, never in the road', () => {
    for (const c of chunks(31337)) {
      for (const p of c.furniture) {
        const gx = nearestLine(p.x);
        const gz = nearestLine(p.z);
        expect(gx.dist > gx.half - SIDEWALK || gz.dist > gz.half - SIDEWALK).toBe(true);
      }
    }
  });

  it("joins the chunk's collision, and keeps off the lamps and the trees", () => {
    for (const c of chunks(1)) {
      const kit = [...c.furniture.flatMap((p) => kitFootprint(p, false)), ...c.fixtures.flatMap((p) => kitFootprint(p, true))];
      const others = c.circles.slice(0, c.circles.length - kit.length);
      const order = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x - b.x || a.z - b.z;
      expect([...c.circles.slice(c.circles.length - kit.length)].sort(order)).toEqual([...kit].sort(order));
      let worst = Infinity;
      for (const k of kit) {
        for (const o of others) worst = Math.min(worst, Math.hypot(k.x - o.x, k.z - o.z) - k.r - o.r);
        for (const l of c.lamps) worst = Math.min(worst, Math.hypot(k.x - l.x, k.z - l.z) - k.r - 0.25);
      }
      expect(worst).toBeGreaterThan(-1e-6);
    }
  });

  it('marks the café furniture, and only that, as debris', () => {
    for (const c of chunks(7)) {
      for (const p of c.furniture) expect(p.debris).toBe(p.variant === Furniture.CafePair || p.variant === Furniture.CafeParasol);
      for (const p of c.fixtures) expect(p.debris).toBe(false);
    }
  });
});
