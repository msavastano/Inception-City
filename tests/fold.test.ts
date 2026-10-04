import { describe, expect, it } from 'vitest';
import { FoldShape, FoldStack, Fold, foldPoint, sortFolds } from '../src/core/fold';

function fold(shape: Partial<FoldShape>): FoldShape {
  return { hx: 0, hz: 0, nx: 0, nz: 1, angle: Math.PI / 2, radius: 100, ...shape };
}

function map(folds: FoldShape[], fx: number, fz: number, h = 0) {
  const p = { x: fx, y: h, z: fz };
  const basis = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
  ];
  foldPoint(folds, fx, fz, p, basis);
  return { p, basis };
}

describe('fold algebra', () => {
  it('leaves everything behind the hinge untouched', () => {
    const { p } = map([fold({})], 40, -10, 7);
    expect(p).toEqual({ x: 40, y: 7, z: -10 });
  });

  it('a 90° fold stands the far side up as a wall', () => {
    const R = 100;
    const L = (R * Math.PI) / 2;
    const { p, basis } = map([fold({ radius: R })], 5, L + 30);
    expect(p.x).toBeCloseTo(5);
    expect(p.y).toBeCloseTo(R + 30);
    expect(p.z).toBeCloseTo(R);
    // local "up" now points back towards the anchor
    expect(basis[1].z).toBeCloseTo(-1);
  });

  it('a 180° fold hangs the far side upside down overhead (the Paris fold)', () => {
    const R = 100;
    const L = R * Math.PI;
    const { p, basis } = map([fold({ angle: Math.PI, radius: R })], 0, L + 50);
    expect(p.y).toBeCloseTo(2 * R);
    expect(p.z).toBeCloseTo(-50);
    expect(basis[1].y).toBeCloseTo(-1);
  });

  it('a negative fold curls downward', () => {
    const R = 50;
    const { p } = map([fold({ angle: -Math.PI / 2, radius: R })], 0, R * (Math.PI / 2) + 10);
    expect(p.y).toBeCloseTo(-(R + 10));
    expect(p.z).toBeCloseTo(R);
  });

  it('is continuous across the hinge and the end of the curl', () => {
    const f = [fold({ angle: 2.3, radius: 70 })];
    const L = 70 * 2.3;
    for (const z of [0, L]) {
      const a = map(f, 3, z - 1e-4, 12).p;
      const b = map(f, 3, z + 1e-4, 12).p;
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-3);
    }
  });

  it('maps the street surface isometrically, so walking distances survive folding', () => {
    // Nested and disjoint folds bend the sheet without stretching it. (Folds whose
    // curls cross each other must stretch the corner between them, like real paper.)
    const f = sortFolds([
      { ...fold({ hz: 300, angle: 1.4, radius: 40 }), id: 1 },
      { ...fold({ angle: Math.PI, radius: 60 }), id: 2 },
      { ...fold({ hz: -50, nz: -1, angle: -0.8, radius: 30 }), id: 3 },
    ]);
    const step = 0.01;
    for (const [fx, fz] of [
      [10, 30],
      [70, 120],
      [-20, 400],
      [55, 320],
      [5, -80],
    ]) {
      const a = map(f, fx, fz).p;
      const bx = map(f, fx + step, fz).p;
      const bz = map(f, fx, fz + step).p;
      expect(Math.hypot(bx.x - a.x, bx.y - a.y, bx.z - a.z)).toBeCloseTo(step, 5);
      expect(Math.hypot(bz.x - a.x, bz.y - a.y, bz.z - a.z)).toBeCloseTo(step, 5);
    }
  });

  it('composes nested folds like paper: two 90° folds flip the far city', () => {
    const near = { ...fold({ hz: 100, radius: 30 }), id: 1 };
    const far = { ...fold({ hz: 300, radius: 30 }), id: 2 };
    const ordered = sortFolds([near, far]);
    expect(ordered.map((f) => f.id)).toEqual([2, 1]);
    const { basis } = map(ordered, 0, 1000);
    expect(basis[1].y).toBeCloseTo(-1);
    expect(basis[2].z).toBeCloseTo(-1);
  });
});

describe('crossing folds', () => {
  it('cut the corner instead of stretching it: the first fold keeps the corner', () => {
    const north = { ...fold({ hz: 100, radius: 20 }), id: 1 };
    const east = { ...fold({ hx: 100, nx: 1, nz: 0, radius: 20 }), id: 2 };
    const both = map([north, east], 400, 400).p;
    const northOnly = map([north], 400, 400).p;
    expect(both.x).toBeCloseTo(northOnly.x);
    expect(both.y).toBeCloseTo(northOnly.y);
    expect(both.z).toBeCloseTo(northOnly.z);
    // and the east wall still stands south of the cut
    const wall = map([north, east], 400, 0).p;
    expect(wall.y).toBeGreaterThan(100);
  });
});

describe('FoldStack', () => {
  it('springs folds to their target and removes unfolded ones', () => {
    const stack = new FoldStack();
    const f: Fold = stack.add(0, 100, 0, 1, Math.PI, 80);
    for (let i = 0; i < 600; i++) stack.update(1 / 60);
    expect(f.angle).toBeCloseTo(Math.PI, 3);
    expect(stack.count).toBe(1);
    stack.clear();
    for (let i = 0; i < 900; i++) stack.update(1 / 60);
    expect(stack.folds.length).toBe(0);
    expect(stack.count).toBe(0);
  });

  it('round-trips through its share-link form', () => {
    const a = new FoldStack();
    a.add(10, 128, 0, 1, 3.14159, 90);
    a.add(-64, 0, -1, 0, -1.2, 40);
    const b = new FoldStack();
    b.deserialize(a.serialize());
    expect(b.serialize()).toBe(a.serialize());
  });
});
