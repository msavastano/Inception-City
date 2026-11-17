import { describe, expect, it } from 'vitest';
import { BOULEVARD_TREES, CHUNK, streetHalfWidth } from '../src/core/config';
import { generateChunk } from '../src/city/generator';
import { ATLAS_SIZE, crownDepth, leafAtlas, SHAPES, TREE_CLASS, treeGeometry, treeTriangles } from '../src/city/trees';

describe('plane trees', () => {
  it('stay inside their triangle budgets', () => {
    for (const cls of [TREE_CLASS.boulevard, TREE_CLASS.park]) {
      const near = treeTriangles('near', cls);
      const far = treeTriangles('far', cls);
      expect(near).toBeGreaterThan(1000);
      expect(near).toBeLessThanOrEqual(2000);
      expect(far).toBeGreaterThan(100);
      expect(far).toBeLessThanOrEqual(250);
    }
  });

  it('are the same every time they are grown', () => {
    const a = treeGeometry('near').attributes.position.array;
    const b = treeGeometry('near').attributes.position.array;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('carry what the shader needs on every vertex', () => {
    for (const lod of ['near', 'far'] as const) {
      const g = treeGeometry(lod);
      const n = g.attributes.position.count;
      for (const name of ['normal', 'aWood', 'aLeaf']) expect(g.attributes[name].count).toBe(n);
      if (lod === 'far') expect(g.attributes.aCard.count).toBe(n);
      const wood = g.attributes.aWood.array;
      const leaf = g.attributes.aLeaf.array;
      for (let i = 0; i < n; i++) {
        expect(wood[i * 4] === 0 || wood[i * 4] === 1).toBe(true);
        expect(wood[i * 4 + 1]).toBeGreaterThanOrEqual(0);
        expect(wood[i * 4 + 1]).toBeLessThanOrEqual(1);
        expect(leaf[i * 4 + 3] === 0 || leaf[i * 4 + 3] === 1).toBe(true);
        if (wood[i * 4] === 1) {
          // a leaf card samples inside the atlas
          expect(leaf[i * 4]).toBeGreaterThanOrEqual(0);
          expect(leaf[i * 4]).toBeLessThanOrEqual(1);
          expect(leaf[i * 4 + 1]).toBeGreaterThanOrEqual(0);
          expect(leaf[i * 4 + 1]).toBeLessThanOrEqual(1);
        }
      }
      for (const v of g.index!.array) expect(v).toBeLessThan(n);
    }
  });

  it('keep their leaves above the passers-by and in the crown', () => {
    const g = treeGeometry('near');
    const pos = g.attributes.position.array;
    const wood = g.attributes.aWood.array;
    const leaf = g.attributes.aLeaf.array;
    for (let i = 0; i < g.attributes.position.count; i++) {
      if (wood[i * 4] !== 1) continue;
      const s = SHAPES[leaf[i * 4 + 3]];
      const p: [number, number, number] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      // card corners stand a little out of the crown, no more
      expect(crownDepth(s, p)).toBeLessThan(1.35);
      expect(p[1]).toBeGreaterThan(s.floor - 1);
    }
    // the smallest tree's crown is still over a walker's head
    for (const s of SHAPES) expect((s.floor - 1) * 0.85).toBeGreaterThan(2.2);
  });

  it('stand on a trunk inside the circle the walkers collide with', () => {
    const g = treeGeometry('near');
    const pos = g.attributes.position.array;
    const wood = g.attributes.aWood.array;
    let foot = 0;
    for (let i = 0; i < g.attributes.position.count; i++) {
      if (wood[i * 4] === 0 && wood[i * 4 + 3] < 0 && pos[i * 3 + 1] < 0.5) foot = Math.max(foot, Math.hypot(pos[i * 3], pos[i * 3 + 2]));
    }
    expect(foot).toBeGreaterThan(0.2);
    // (src/city/generator.ts gives each tree a collision circle of 0.45 times its scale)
    expect(foot).toBeLessThan(0.45);
  });

  it('draws a leaf atlas whose smaller levels keep the leaves', () => {
    const levels = leafAtlas();
    expect(levels.length).toBe(Math.log2(ATLAS_SIZE) + 1);
    levels.forEach((l, i) => expect(l.length).toBe((ATLAS_SIZE >> i) ** 2 * 4));
    const cover = (l: Uint8Array) => {
      let c = 0;
      for (let i = 3; i < l.length; i += 4) c += l[i] >= 128 ? 1 : 0;
      return c / (l.length / 4);
    };
    const top = cover(levels[0]);
    expect(top).toBeGreaterThan(0.2);
    expect(top).toBeLessThan(0.6);
    // the alpha test cuts at a half: a mip level must not thin the crowns out (or fill them in) on its way down
    for (const k of [1, 2, 3, 4]) expect(Math.abs(cover(levels[k]) - top)).toBeLessThan(0.1);
  });
});

describe('the trees in the city', () => {
  const chunks = [-1, 0, 1].flatMap((cx) => [-1, 0, 1].map((cz) => generateChunk(cx, cz, 7)));

  it('tags boulevard trees and park trees with their shape', () => {
    let boulevard = 0;
    let park = 0;
    for (const c of chunks)
      for (const t of c.trees) {
        expect(t.shape === 0 || t.shape === 1).toBe(true);
        if (t.shape === 0) boulevard++;
        else park++;
      }
    expect(boulevard).toBeGreaterThan(0);
    expect(park).toBeGreaterThan(0);
  });

  it('turns each boulevard tree to lean over the road, its flat back clear of the facades', () => {
    const lat = streetHalfWidth(0) - BOULEVARD_TREES.inset;
    for (const c of chunks)
      for (const t of c.trees) {
        if (t.shape !== 0) continue;
        const mx = Math.round(t.x / CHUNK) * CHUNK;
        const mz = Math.round(t.z / CHUNK) * CHUNK;
        const alongZ = Math.abs(Math.abs(t.x - mx) - lat) < 1e-6;
        const centre = alongZ ? [Math.sign(mx - t.x), 0] : [0, Math.sign(mz - t.z)];
        // the model's +x after the shader's turn (see treeYaw)
        const lean = [Math.cos(t.yaw), -Math.sin(t.yaw)];
        const off = Math.acos(Math.min(1, lean[0] * centre[0] + lean[1] * centre[1]));
        expect(off).toBeLessThan(0.06);
        // worst case behind the trunk: the flat back, plus the crown's widest swing turned by that much
        const s = SHAPES[0];
        const widest = (Math.hypot(s.centre[0], s.centre[2]) + Math.max(s.radii[0], s.radii[2])) * 1.1;
        const reach = (-s.back * Math.cos(off) + widest * Math.sin(off)) * t.scale;
        expect(reach).toBeLessThan(BOULEVARD_TREES.inset);
      }
  });
});
