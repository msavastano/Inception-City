import { describe, expect, it } from 'vitest';
import { BLOCK, BOULEVARD_HALF, BOULEVARD_TREES, CHUNK_BLOCKS, LAMP_OFFSET, LAMP_SPACING, PLAZA_TREE_INSET, SLAB, streetHalfWidth } from '../src/core/config';
import { BlockKind, generateChunk } from '../src/city/generator';
import { LOOK, TONE_CURVES, readLook } from '../src/world/look';
import { LEVELS } from '../src/world/themes';

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Where a point is relative to its nearest street on one axis: distance from the centre line, and that street's half width. */
function street(v: number): { d: number; hw: number } {
  const line = Math.round(v / BLOCK);
  return { d: Math.abs(v - line * BLOCK), hw: streetHalfWidth(line) };
}

/**
 * The ground and facade shaders never look anything up: they work out where the trees and lamps
 * are from the same constants the generator places them with. These tests pin the two together,
 * so a change to the generator cannot leave shade and light pools standing where nothing is.
 */
describe('what the shaders assume about the street furniture', () => {
  const chunks = [-2, -1, 0, 1, 2].flatMap((cx) => [-2, -1, 0, 1, 2].map((cz) => generateChunk(cx, cz, 4242)));

  it('finds every boulevard tree on the lattice the ground shader shades', () => {
    let seen = 0;
    for (const chunk of chunks) {
      if (chunk.trees.length >= SLAB.tree) continue; // a full slab drops trees, which only leaves a little shade behind
      let onBoulevards = 0;
      for (const t of chunk.trees) {
        const x = street(t.x);
        const z = street(t.z);
        const inX = x.d < x.hw;
        const inZ = z.d < z.hw;
        if (!inX && !inZ) continue; // inside a block: a park's or a plaza's tree
        onBoulevards++;
        // the shader's boulevardTrees(lateral, along)
        const lateral = inX ? x.d : z.d;
        const along = mod(inX ? t.z : t.x, BLOCK);
        const nearest = Math.min(BOULEVARD_TREES.count - 1, Math.max(0, Math.floor((along - BOULEVARD_TREES.first) / BOULEVARD_TREES.step + 0.5))) * BOULEVARD_TREES.step + BOULEVARD_TREES.first;
        expect(inX ? x.hw : z.hw).toBe(BOULEVARD_HALF);
        expect(lateral).toBeCloseTo(BOULEVARD_HALF - BOULEVARD_TREES.inset, 6);
        expect(along).toBeCloseTo(nearest, 6);
      }
      // both sides of the two boulevards each chunk owns
      expect(onBoulevards).toBe(CHUNK_BLOCKS * BOULEVARD_TREES.count * 4);
      seen += onBoulevards;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('finds the plaza trees an inset in from each corner', () => {
    let seen = 0;
    for (const chunk of chunks) {
      for (const t of chunk.trees) {
        const x = street(t.x);
        const z = street(t.z);
        if (x.d < x.hw || z.d < z.hw) continue;
        const bx = mod(Math.floor(t.x / BLOCK), CHUNK_BLOCKS);
        const bz = mod(Math.floor(t.z / BLOCK), CHUNK_BLOCKS);
        if (chunk.kinds[bx + bz * CHUNK_BLOCKS] !== BlockKind.Plaza) continue;
        expect(x.d - x.hw).toBeCloseTo(PLAZA_TREE_INSET, 6);
        expect(z.d - z.hw).toBeCloseTo(PLAZA_TREE_INSET, 6);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('finds every lamp a metre inside the building line, on the lamp spacing', () => {
    for (const chunk of chunks) {
      expect(chunk.lamps.length).toBeGreaterThan(0);
      for (const l of chunk.lamps) {
        const x = street(l.x);
        const z = street(l.z);
        const alongZ = Math.abs(x.d - (x.hw - 1)) < 1e-6 && Math.abs(mod(l.z - LAMP_OFFSET, LAMP_SPACING)) < 1e-6;
        const alongX = Math.abs(z.d - (z.hw - 1)) < 1e-6 && Math.abs(mod(l.x - LAMP_OFFSET, LAMP_SPACING)) < 1e-6;
        expect(alongZ || alongX).toBe(true);
      }
    }
  });
});

describe('the look dials', () => {
  it('reads overrides from the link and ignores nonsense', () => {
    const before = { ...LOOK };
    readLook(new URLSearchParams('tone=agx&ao=0.5&haze=2&glow=-3&contrast=abc&exposure='));
    expect(LOOK.tone).toBe('agx');
    expect(LOOK.ao).toBe(0.5);
    expect(LOOK.haze).toBe(2);
    expect(LOOK.glow).toBe(0);
    expect(LOOK.contrast).toBe(before.contrast);
    expect(LOOK.exposure).toBe(before.exposure);
    readLook(new URLSearchParams('tone=technicolor'));
    expect(LOOK.tone).toBe('agx');
    Object.assign(LOOK, before);
  });

  it('has a tone curve for every name, and the default one needs no trim', () => {
    expect(TONE_CURVES[LOOK.tone]).toEqual({ ...TONE_CURVES[LOOK.tone], exposure: 1, contrast: 1, saturation: 1 });
    for (const curve of Object.values(TONE_CURVES)) expect(curve.exposure).toBeGreaterThan(0);
  });

  it('gives every level its own air and exposure', () => {
    for (const level of LEVELS) {
      expect(level.haze).toBeGreaterThan(0);
      expect(level.mist).toBeGreaterThanOrEqual(0);
      expect(level.exposure).toBeGreaterThan(0.3);
      expect(level.exposure).toBeLessThan(2);
    }
  });
});
