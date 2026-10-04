import { describe, expect, it } from 'vitest';
import { BLOCK, CHUNK, SLAB, streetHalfWidth } from '../src/core/config';
import { BlockKind, generateChunk } from '../src/city/generator';

describe('city generator', () => {
  it('is a pure function of (seed, chunk)', () => {
    expect(generateChunk(3, -2, 42)).toEqual(generateChunk(3, -2, 42));
    expect(generateChunk(3, -2, 42)).not.toEqual(generateChunk(3, -2, 43));
  });

  it('keeps every building off the streets and inside its chunk', () => {
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const chunk = generateChunk(cx, cz, 7);
        expect(chunk.buildings.length).toBeLessThanOrEqual(SLAB.building);
        expect(chunk.roofs.length).toBeLessThanOrEqual(SLAB.roof);
        for (const b of chunk.buildings) {
          const x0 = b.x - b.w / 2;
          const x1 = b.x + b.w / 2;
          const z0 = b.z - b.d / 2;
          const z1 = b.z + b.d / 2;
          expect(x0).toBeGreaterThanOrEqual(cx * CHUNK - 1e-6);
          expect(x1).toBeLessThanOrEqual((cx + 1) * CHUNK + 1e-6);
          const bx = Math.floor(b.x / BLOCK);
          const bz = Math.floor(b.z / BLOCK);
          expect(x0).toBeGreaterThanOrEqual(bx * BLOCK + streetHalfWidth(bx) - 1e-6);
          expect(x1).toBeLessThanOrEqual((bx + 1) * BLOCK - streetHalfWidth(bx + 1) + 1e-6);
          expect(z0).toBeGreaterThanOrEqual(bz * BLOCK + streetHalfWidth(bz) - 1e-6);
          expect(z1).toBeLessThanOrEqual((bz + 1) * BLOCK - streetHalfWidth(bz + 1) + 1e-6);
        }
      }
    }
  });

  it('builds the circus around the origin', () => {
    const chunk = generateChunk(0, 0, 1);
    expect(chunk.kinds[0]).toBe(BlockKind.Circus);
  });
});
