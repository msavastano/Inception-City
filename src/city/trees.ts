import * as THREE from 'three';
import { rng } from '../core/rng';

/**
 * London plane trees, grown in code.
 *
 * Nothing here is downloaded: the trunk, the limbs and the branches are tubes along
 * a skeleton grown from a seed, and the leaves are cards cut from an atlas of leaf
 * clusters that is drawn pixel by pixel when the game starts (leafAtlas()). There are
 * two shapes. The boulevard tree is pruned the Paris way: its crown leans out over the
 * road and is cut flat on the side that faces the buildings, 2.5 m behind its trunk.
 * The park tree is free-grown, broad and round. Each comes in two versions: near
 * (about 1,500 triangles: every branch, a few hundred leaf cards) and far (about 150:
 * the trunk and limbs, and a few dozen big cards that turn to face the camera).
 *
 * The model's frame: y up, the trunk's foot at the origin, +x towards the road (for a
 * boulevard tree; its flat side is at x = SHAPES[0].back). Lengths in metres, before
 * the per-tree scale. Every vertex carries what the tree shader needs (TREE_VERT_HEAD):
 *
 *   aWood  part (0 bark, 1 leaves), sky (how much of the sky it sees, 0 to 1), sway (0 the foot, 1 the crown's top), limb (-1 the trunk)
 *   aLeaf  atlas u, v (leaves), flutter phase (radians), shape (0 boulevard, 1 park)
 *   aCard  far version only: the corner's offset from its card's centre (metres), the card's roll (radians), unused
 */

type V3 = [number, number, number];

export const TREE_CLASS = { boulevard: 0, park: 1 } as const;

export interface TreeShape {
  /** Height at which the trunk divides into its limbs. */
  fork: number;
  /** The crown: an ellipsoid (centre and radii, metres). */
  centre: V3;
  radii: V3;
  /** No leaves below this height. */
  floor: number;
  /** No leaves behind this x: the side pruned flat to clear the facades (boulevard trees only). */
  back: number;
  limbs: number;
  /** How far each tree turns its limbs from the model's, radians either way (per tree, in the shader). */
  turn: number;
}

export const SHAPES: readonly TreeShape[] = [
  { fork: 4.4, centre: [1.0, 9.8, 0], radii: [4.0, 5.0, 4.7], floor: 5.3, back: -1.6, limbs: 4, turn: 0.16 },
  { fork: 3.4, centre: [0, 9.2, 0], radii: [6.0, 5.6, 6.0], floor: 3.6, back: -Infinity, limbs: 5, turn: 0.4 },
];

/** Leaf cards in each shape's near and far versions. */
const NEAR_CARDS = [470, 560];
const FAR_CARDS = [44, 54];

/** The leaf atlas: 2 x 2 cells. The first row holds the near cards' clusters, the second the far cards' denser ones. */
export const ATLAS_SIZE = 512;
const CELL = ATLAS_SIZE / 2;
/** Texels kept clear round each cell, so mip levels do not run one cell into the next. */
const GUTTER = 6;

// ---------------------------------------------------------------- vectors

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Where a point sits in a crown: 0 at its centre, 1 on its surface. */
export function crownDepth(s: TreeShape, p: V3): number {
  return len([(p[0] - s.centre[0]) / s.radii[0], (p[1] - s.centre[1]) / s.radii[1], (p[2] - s.centre[2]) / s.radii[2]]);
}

/** The crown's outward direction at a point (the ellipsoid's gradient). */
function outward(s: TreeShape, p: V3): V3 {
  const r = s.radii;
  return norm([(p[0] - s.centre[0]) / (r[0] * r[0]), (p[1] - s.centre[1]) / (r[1] * r[1]), (p[2] - s.centre[2]) / (r[2] * r[2])]);
}

/** Bring a point inside the crown (at most `limit` deep) and in front of its flat side. */
function inside(s: TreeShape, p: V3, limit: number, margin = 0): V3 {
  const d = crownDepth(s, p);
  let q = d > limit ? add(s.centre, mul(sub(p, s.centre), limit / d)) : p;
  if (q[0] < s.back + margin) q = [s.back + margin, q[1], q[2]];
  if (q[1] < s.floor) q = [q[0], s.floor, q[2]];
  return q;
}

// ---------------------------------------------------------------- the skeleton

interface Node {
  p: V3;
  r: number;
}
interface Tube {
  nodes: Node[];
  limb: number;
  /** 0 trunk, 1 limb, 2 branch. */
  order: number;
}
interface Skeleton {
  tubes: Tube[];
  /** Where the leaves gather, and which limb carries them. */
  clusters: { p: V3; limb: number }[];
  top: number;
}

function randUnit(rand: () => number): V3 {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

/** A tube along a path that bends from one heading towards another, shortened until it stays inside the crown. */
function bough(s: TreeShape, start: V3, from: V3, to: V3, length: number, r0: number, r1: number, segments: number, wobble: number, rand: () => number): Node[] {
  const jit: V3[] = Array.from({ length: segments + 1 }, () => mul(randUnit(rand), wobble));
  let L = length;
  for (let attempt = 0; attempt < 6; attempt++) {
    const nodes: Node[] = [{ p: start, r: r0 }];
    let p = start;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const dir = norm(add(lerp3(from, to, Math.pow(t, 1.2)), jit[i]));
      p = add(p, mul(dir, L / segments));
      nodes.push({ p, r: r0 + (r1 - r0) * t });
    }
    const worst = Math.max(...nodes.map((n) => crownDepth(s, n.p)));
    const behind = Math.min(...nodes.map((n) => n.p[0])) < s.back + 0.25;
    if (worst <= 0.93 && !behind) return nodes;
    L *= behind ? 0.85 : Math.max(0.6, 0.93 / worst);
  }
  // as a last resort, pull the tips in
  return [{ p: start, r: r0 }, ...Array.from({ length: segments }, (_, i) => ({ p: inside(s, lerp3(start, add(start, mul(to, L)), (i + 1) / segments), 0.93, 0.25), r: r0 + ((r1 - r0) * (i + 1)) / segments }))];
}

function grow(cls: number, seed: number): Skeleton {
  const s = SHAPES[cls];
  const rand = rng(seed);
  const tubes: Tube[] = [];
  const clusters: { p: V3; limb: number }[] = [];
  const boulevard = cls === TREE_CLASS.boulevard;

  // The trunk: a clear stem that flares into the ground, leaning a little towards the light over the road.
  const top: V3 = boulevard ? [0.3, s.fork, 0.06] : [0.12, s.fork, -0.1];
  const trunkAt = [0, 0.06, 0.3, 0.62, 1];
  const trunkR = [0.37, 0.3, 0.26, 0.23, 0.21];
  tubes.push({
    order: 0,
    limb: -1,
    nodes: trunkAt.map((f, i) => {
      const wob: V3 = i > 0 && i < trunkAt.length - 1 ? [(rand() - 0.5) * 0.08, 0, (rand() - 0.5) * 0.08] : [0, 0, 0];
      return { p: add(lerp3([0, 0, 0], top, f), wob), r: trunkR[i] };
    }),
  });

  // The limbs climb steeply out of the fork, then spread. A boulevard tree sends none back towards the facade.
  const azimuths = boulevard
    ? [-1.72, -0.62, 0.6, 1.75].map((a) => a + (rand() - 0.5) * 0.3)
    : Array.from({ length: s.limbs }, (_, i) => (i / s.limbs) * Math.PI * 2 + 0.4 + (rand() - 0.5) * 0.5);
  azimuths.forEach((az, limb) => {
    const flat: V3 = [Math.cos(az), 0, Math.sin(az)];
    const e0 = 1.15 + rand() * 0.15;
    const e1 = 0.72 + rand() * 0.22;
    const from = norm(add(mul(flat, Math.cos(e0)), [0, Math.sin(e0), 0]));
    const to = norm(add(mul(flat, Math.cos(e1)), [0, Math.sin(e1), 0]));
    const start = add(top, add(mul(flat, 0.08), [0, rand() * 0.6, 0]));
    const length = boulevard ? 6.2 + rand() * 1.0 : 6.8 + rand() * 1.4;
    const nodes = bough(s, start, from, to, length, boulevard ? 0.14 : 0.16, 0.035, 5, 0.12, rand);
    tubes.push({ order: 1, limb, nodes });
    // where along the limb something grows, and which way it is heading there
    const at = (t: number): { p: V3; dir: V3 } => {
      const f = t * (nodes.length - 1);
      const i = Math.min(nodes.length - 2, Math.floor(f));
      const p = lerp3(nodes[i].p, nodes[i + 1].p, f - i);
      return { p, dir: norm(sub(nodes[i + 1].p, nodes[i].p)) };
    };

    // Branches off the limb, alternating sides, shorter towards its tip.
    const count = boulevard ? 4 : 5;
    for (let b = 0; b < count; b++) {
      const t = 0.3 + (0.62 * (b + 0.5 + (rand() - 0.5) * 0.5)) / count;
      const { p, dir } = at(t);
      const side = norm(cross(dir, b % 2 ? [0, 1, 0] : [0, -1, 0]));
      const roll = (rand() - 0.5) * 1.2;
      const away = norm(add(mul(side, Math.cos(roll)), mul(norm(cross(dir, side)), Math.sin(roll))));
      const tilt = 0.6 + rand() * 0.35;
      const bFrom = norm(add(mul(dir, Math.cos(tilt)), mul(away, Math.sin(tilt))));
      const bTo = norm(add(bFrom, [0, 0.35, 0]));
      const bl = (2.7 - 1.3 * t) * (0.85 + rand() * 0.3);
      const twig = bough(s, p, bFrom, bTo, bl, 0.05, 0.016, 2, 0.15, rand);
      tubes.push({ order: 2, limb, nodes: twig });
      const tip = twig[twig.length - 1].p;
      for (const u of [0.45, 0.8, 1]) clusters.push({ p: lerp3(twig[0].p, tip, u + (rand() - 0.5) * 0.12), limb });
    }
    for (const t of [0.72, 1]) clusters.push({ p: at(t).p, limb });
  });

  // Fill the crown where the branches left it thin, so it reads as one mass from every side.
  for (let i = 0; i < 400 && clusters.length < (boulevard ? 70 : 100); i++) {
    const u = randUnit(rand);
    const depth = 0.55 + rand() * 0.38;
    const p = inside(s, add(s.centre, [u[0] * s.radii[0] * depth, u[1] * s.radii[1] * depth, u[2] * s.radii[2] * depth]), 0.95, 0.3);
    let best = Infinity;
    let limb = 0;
    for (const c of clusters) {
      const d = len(sub(c.p, p));
      if (d < best) {
        best = d;
        limb = c.limb;
      }
    }
    if (best > 1.7) clusters.push({ p, limb });
  }

  const topY = Math.max(...clusters.map((c) => c.p[1])) + 0.8;
  return { tubes, clusters, top: topY };
}

// ---------------------------------------------------------------- geometry

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  wood: number[] = [];
  leaf: number[] = [];
  card: number[] = [];
  idx: number[] = [];

  vertex(p: V3, n: V3, wood: [number, number, number, number], leaf: [number, number, number, number], card: [number, number, number, number] = [0, 0, 0, 0]): number {
    this.pos.push(...p);
    this.nrm.push(...n);
    this.wood.push(...wood);
    this.leaf.push(...leaf);
    this.card.push(...card);
    return this.pos.length / 3 - 1;
  }

  get count(): number {
    return this.pos.length / 3;
  }

  geometry(withCard: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aWood', new THREE.Float32BufferAttribute(this.wood, 4));
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(this.leaf, 4));
    if (withCard) g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.card, 4));
    g.setIndex(this.idx);
    return g;
  }
}

/** How much sky a point in the tree sees: little deep in the crown and under it, all of it at the top. */
function skyAt(s: TreeShape, p: V3, top: number): number {
  const shell = smoothstep(0.2, 1.0, crownDepth(s, p));
  const height = clamp((p[1] - s.floor) / (top - s.floor), 0, 1);
  return clamp((0.4 + 0.6 * shell) * (0.75 + 0.25 * height), 0.3, 1);
}

function swayAt(p: V3, top: number): number {
  return Math.pow(clamp((p[1] - 1.5) / (top - 1.5), 0, 1), 1.5);
}

/** A tube round a path, its rings carried along without twisting. Open at both ends. */
function tube(b: Builder, s: TreeShape, cls: number, t: Tube, sides: number, top: number, keep?: number[]): void {
  const nodes = keep ? keep.map((i) => t.nodes[Math.min(i, t.nodes.length - 1)]) : t.nodes;
  const first = b.count;
  let n: V3 = [0, 0, 0];
  nodes.forEach((node, i) => {
    const ahead = nodes[Math.min(i + 1, nodes.length - 1)].p;
    const behind = nodes[Math.max(i - 1, 0)].p;
    const tan = norm(sub(ahead, behind));
    if (i === 0) {
      const ref: V3 = Math.abs(tan[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      n = norm(cross(ref, tan));
    } else {
      n = norm(sub(n, mul(tan, dot(n, tan))));
    }
    const bn = cross(tan, n);
    const sky = t.order === 0 ? 0.55 + 0.45 * smoothstep(0, s.fork, node.p[1]) : skyAt(s, node.p, top) * 0.85;
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const dir = add(mul(n, Math.cos(a)), mul(bn, Math.sin(a)));
      b.vertex(add(node.p, mul(dir, node.r)), dir, [0, sky, swayAt(node.p, top), t.limb], [0, 0, 0, cls]);
    }
  });
  for (let i = 0; i < nodes.length - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const A = first + i * sides + j;
      const B = first + i * sides + ((j + 1) % sides);
      const C = B + sides;
      const D = A + sides;
      b.idx.push(A, B, D, B, C, D);
    }
  }
}

/** The atlas cell a card shows: 0 and 1 the near clusters, 2 and 3 the far ones. Corners in u, v. */
function cellUV(cell: number, cu: number, cv: number): [number, number] {
  const ox = (cell % 2) * CELL;
  const oy = Math.floor(cell / 2) * CELL;
  return [(ox + GUTTER + cu * (CELL - 2 * GUTTER)) / ATLAS_SIZE, (oy + GUTTER + cv * (CELL - 2 * GUTTER)) / ATLAS_SIZE];
}

/**
 * Where the leaf cards go. A third gather round the branches' tips; the rest are spread through the crown's
 * outer layer (thickest just under its surface, which is lumpy rather than a smooth ellipsoid), each carried by
 * the limb nearest it, so the crown reads as one mass. The far version's cards stand where these gather.
 */
function leafSpots(cls: number, seed: number, sk: Skeleton): { p: V3; limb: number }[] {
  const s = SHAPES[cls];
  const rand = rng(seed * 5 + 1);
  // a few broad bulges and hollows in the crown's outline
  const bumps = Array.from({ length: 5 }, () => ({ d: randUnit(rand), k: 0.1 + rand() * 0.1 }));
  const lump = (u: V3) => 0.84 + bumps.reduce((sum, b) => sum + b.k * Math.max(0, dot(u, b.d)) ** 3, 0);
  const total = NEAR_CARDS[cls];
  const spots: { p: V3; limb: number }[] = [];
  for (let k = 0; spots.length < total; k++) {
    if (k % 3 === 0) {
      const c = sk.clusters[(k / 3) % sk.clusters.length];
      spots.push({ p: inside(s, add(c.p, mul(randUnit(rand), 0.35 + rand() * 0.5)), 1.0, 0.45), limb: c.limb });
    } else {
      const u = randUnit(rand);
      const depth = Math.min(1, (0.6 + 0.38 * Math.pow(rand(), 0.55)) * lump(u));
      const p = inside(s, add(s.centre, [u[0] * s.radii[0] * depth, u[1] * s.radii[1] * depth, u[2] * s.radii[2] * depth]), 1.0, 0.45);
      const near = sk.clusters.reduce((best, c) => (len(sub(c.p, p)) < len(sub(best.p, p)) ? c : best));
      spots.push({ p, limb: near.limb });
    }
  }
  return spots;
}

function nearTree(b: Builder, cls: number, seed: number): void {
  const s = SHAPES[cls];
  const sk = grow(cls, seed);
  const rand = rng(seed * 7 + 3);
  for (const t of sk.tubes) tube(b, s, cls, t, t.order === 0 ? 8 : t.order === 1 ? 6 : 4, sk.top);
  const spots = leafSpots(cls, seed, sk);
  for (const c of spots) {
    {
      const q = c.p;
      const size = (cls === TREE_CLASS.boulevard ? 1.25 : 1.35) + rand() * 0.5;
      // cards face out of the crown (more sideways than up, so few are seen edge-on against the sky), give or take
      const out = outward(s, q);
      const facing = norm(add(mul(norm([out[0], out[1] * 0.45, out[2]]), 0.75), mul(randUnit(rand), 0.5)));
      const t1 = norm(cross(facing, randUnit(rand)));
      const t2 = cross(facing, t1);
      const cell = rand() < 0.5 ? 0 : 1;
      const flip = rand() < 0.5;
      const sky = skyAt(s, q, sk.top) * (0.88 + 0.12 * facing[1]);
      const sway = swayAt(q, sk.top);
      const phase = rand() * Math.PI * 2;
      const first = b.count;
      for (const [cu, cv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const p = add(q, add(mul(t1, (cu - 0.5) * size), mul(t2, (cv - 0.5) * size)));
        // the crown is lit as one rounded mass, each card only a little by its own facing
        const nn = norm(add(mul(facing, 0.35), mul(outward(s, p), 0.65)));
        const [u, v] = cellUV(cell, flip ? 1 - cu : cu, cv);
        b.vertex(p, nn, [1, sky, sway, c.limb], [u, v, phase, cls]);
      }
      b.idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  }
}

/** A few k-means groups of the near version's leaves: the far version's cards stand where they gather. */
function gather(points: V3[], k: number): { c: V3; spread: number; limb: number }[] {
  const n = points.length;
  const centres: V3[] = Array.from({ length: k }, (_, i) => [...points[Math.floor((i * n) / k)]] as V3);
  const owner = new Int32Array(n);
  const sum = new Float64Array(k * 4);
  const assign = () => {
    for (let i = 0; i < n; i++) {
      const [px, py, pz] = points[i];
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const c = centres[j];
        const d = (px - c[0]) ** 2 + (py - c[1]) ** 2 + (pz - c[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      owner[i] = best;
    }
  };
  for (let it = 0; it < 12; it++) {
    assign();
    sum.fill(0);
    for (let i = 0; i < n; i++) {
      const o = owner[i] * 4;
      sum[o] += points[i][0];
      sum[o + 1] += points[i][1];
      sum[o + 2] += points[i][2];
      sum[o + 3]++;
    }
    for (let j = 0; j < k; j++) {
      const m = sum[j * 4 + 3];
      if (m) centres[j] = [sum[j * 4] / m, sum[j * 4 + 1] / m, sum[j * 4 + 2] / m];
    }
  }
  // (the owners from before the last move, as the spread has always been measured)
  const spread = new Float64Array(k * 2);
  for (let i = 0; i < n; i++) {
    const j = owner[i];
    const c = centres[j];
    spread[j * 2] += (points[i][0] - c[0]) ** 2 + (points[i][1] - c[1]) ** 2 + (points[i][2] - c[2]) ** 2;
    spread[j * 2 + 1]++;
  }
  return centres.map((c, j) => ({ c, spread: spread[j * 2 + 1] ? Math.sqrt(spread[j * 2] / spread[j * 2 + 1]) : 0, limb: j }));
}

function farTree(b: Builder, cls: number, seed: number): void {
  const s = SHAPES[cls];
  const sk = grow(cls, seed);
  const rand = rng(seed * 13 + 5);
  for (const t of sk.tubes) {
    if (t.order === 0) tube(b, s, cls, t, 5, sk.top, [0, 1, 4]);
    else if (t.order === 1) tube(b, s, cls, t, 4, sk.top, [0, 2, 5]);
  }
  const spots = leafSpots(cls, seed, sk);
  const limbOf = (p: V3) => spots.reduce((best, c) => (len(sub(c.p, p)) < len(sub(best.p, p)) ? c : best)).limb;
  for (const g of gather(
    spots.map((c) => c.p),
    FAR_CARDS[cls],
  )) {
    const q = inside(s, g.c, 0.97, 0.9);
    const size = clamp(2.2 + 1.5 * g.spread, 2.6, 4.0);
    const n = outward(s, q);
    const sky = skyAt(s, q, sk.top);
    const roll = rand() * Math.PI * 2;
    const cell = 2 + (rand() < 0.5 ? 0 : 1);
    const limb = limbOf(q);
    const first = b.count;
    for (const [cu, cv] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      const [u, v] = cellUV(cell, cu, cv);
      b.vertex(q, n, [1, sky, swayAt(q, sk.top), limb], [u, v, roll, cls], [(cu - 0.5) * size, (cv - 0.5) * size, roll, 0]);
    }
    b.idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
}

/** The seeds the two shapes are grown from (picked by eye in the lab: /lab.html#trees). */
const SEEDS = [11, 23];

/** Both shapes in one geometry; the tree shader drops the shape a tree is not. */
export function treeGeometry(lod: 'near' | 'far'): THREE.BufferGeometry {
  const b = new Builder();
  SHAPES.forEach((_, cls) => (lod === 'near' ? nearTree : farTree)(b, cls, SEEDS[cls]));
  return b.geometry(lod === 'far');
}

/** Triangles of one shape at one level of detail (the geometry holds both shapes). */
export function treeTriangles(lod: 'near' | 'far', cls: number): number {
  const g = treeGeometry(lod);
  const leaf = g.getAttribute('aLeaf');
  const idx = g.index!;
  let n = 0;
  for (let i = 0; i < idx.count; i += 3) if (leaf.getW(idx.getX(i)) === cls) n++;
  return n;
}

// ---------------------------------------------------------------- the leaves

/**
 * The leaf atlas, drawn texel by texel: in each of four cells a cluster of
 * London plane leaves (palmate, five-lobed) on a twig. Channels:
 *
 *   r  which leaf (a random number per leaf: its shade of green, and whether the season has dropped it)
 *   g  twig (what is left of the cluster when the leaves have fallen)
 *   b  light on the leaf (the leaves behind are in their neighbours' shade; veins a little darker)
 *   a  leaf
 *
 * Returns every mip level, largest first. Going down the levels, the leaf and twig coverage is
 * rescaled so that as much of each cell passes the alpha test as at full size; otherwise a tree's
 * crown would thin out as it moves away.
 */
export function leafAtlas(): Uint8Array[] {
  const S = ATLAS_SIZE;
  const r = new Float32Array(S * S);
  const g = new Float32Array(S * S);
  const bl = new Float32Array(S * S).fill(0.5);
  const a = new Float32Array(S * S);
  const rand = rng(424242);

  const twig = (ox: number, oy: number, x0: number, y0: number, x1: number, y1: number, w: number) => {
    const minX = Math.max(ox + GUTTER, Math.floor(Math.min(x0, x1) - w));
    const maxX = Math.min(ox + CELL - GUTTER - 1, Math.ceil(Math.max(x0, x1) + w));
    const minY = Math.max(oy + GUTTER, Math.floor(Math.min(y0, y1) - w));
    const maxY = Math.min(oy + CELL - GUTTER - 1, Math.ceil(Math.max(y0, y1) + w));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = clamp(((px - x0) * dx + (py - y0) * dy) / l2, 0, 1);
        const d = Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
        const width = w * (1 - 0.45 * t);
        const cov = clamp(width / 2 - d + 0.5, 0, 1);
        const i = y * S + x;
        g[i] = Math.max(g[i], cov);
      }
    }
  };

  // A five-lobed leaf: its outline as a radius for each direction from where the stalk joins
  // (0 towards the tip). Pointed lobes on a rounded blade, a notch at the stalk.
  const lobes: [number, number][] = [
    [0, 1],
    [0.95, 0.86],
    [-0.95, 0.86],
    [1.9, 0.52],
    [-1.9, 0.52],
  ];
  const outline = (th: number): number => {
    const at = Math.abs(th);
    let rr = at < 2.25 ? 0.47 : 0.47 * (1 - ((at - 2.25) / (Math.PI - 2.25)) * 0.75);
    for (const [c, l] of lobes) {
      const k = 1 - Math.abs(th - c) / 0.52;
      if (k > 0) rr = Math.max(rr, l * k * (1.15 - 0.15 * k));
    }
    return rr;
  };
  // (looked up rather than worked out per texel: 1,024 directions round the stalk)
  const LUT = 1024;
  const shapeLut = new Float32Array(LUT + 1);
  for (let k = 0; k <= LUT; k++) shapeLut[k] = outline((k / LUT) * 2 * Math.PI - Math.PI);
  const veinAt = lobes.map(([c]) => c);
  const leaf = (ox: number, oy: number, jx: number, jy: number, R: number, phi: number, id: number, shade: number) => {
    const reach = R * 1.05;
    const minX = Math.max(ox + GUTTER, Math.floor(jx - reach));
    const maxX = Math.min(ox + CELL - GUTTER - 1, Math.ceil(jx + reach));
    const minY = Math.max(oy + GUTTER, Math.floor(jy - reach));
    const maxY = Math.min(oy + CELL - GUTTER - 1, Math.ceil(jy + reach));
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - jx;
        const dy = y + 0.5 - jy;
        const u = dx * c + dy * s;
        const v = -dx * s + dy * c;
        const d = Math.sqrt(u * u + v * v);
        if (d > R + 0.5) continue;
        const th = Math.atan2(v, u);
        const edge = R * shapeLut[Math.round(((th + Math.PI) / (2 * Math.PI)) * LUT)];
        const cov = clamp(edge - d + 0.5, 0, 1);
        if (cov <= 0) continue;
        // the five main veins run out to the lobes' points
        let vein = 0;
        if (d < edge * 0.85) {
          for (let k = 0; k < 5; k++) {
            const off = Math.abs(th - veinAt[k]) * d;
            const w = 1 - off * off * 0.8;
            if (w > vein) vein = w;
          }
          vein *= vein;
        }
        const tone = shade * (0.86 + 0.14 * (d / Math.max(edge, 1e-3))) * (1 - 0.13 * vein);
        const i = y * S + x;
        r[i] = r[i] + (id - r[i]) * cov;
        bl[i] = bl[i] + (tone - bl[i]) * cov;
        a[i] = a[i] + cov * (1 - a[i]);
      }
    }
  };

  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * CELL;
    const oy = Math.floor(cell / 2) * CELL;
    const far = cell >= 2;
    // The twig rises from the bottom of the cell (v = 0) through the cluster.
    const baseX = ox + CELL * (0.5 + (rand() - 0.5) * 0.1);
    const baseY = oy + GUTTER + 2;
    const midX = ox + CELL * (0.5 + (rand() - 0.5) * 0.12);
    const midY = oy + CELL * 0.5;
    const tipX = ox + CELL * (0.5 + (rand() - 0.5) * 0.2);
    const tipY = oy + CELL * 0.78;
    twig(ox, oy, baseX, baseY, midX, midY, far ? 3 : 4.2);
    twig(ox, oy, midX, midY, tipX, tipY, far ? 2.2 : 3);
    const n = far ? 170 : 64;
    const leaves: { jx: number; jy: number; R: number; phi: number; id: number; depth: number }[] = [];
    for (let i = 0; i < n; i++) {
      const ang = rand() * Math.PI * 2;
      const rad = Math.sqrt(rand()) * (far ? 0.37 : 0.33);
      const jx = ox + CELL * (0.5 + Math.cos(ang) * rad);
      const jy = oy + CELL * (0.53 + Math.sin(ang) * rad * 0.95);
      // the stalk joins a side twig off the stem; the leaf points away from the stem and a little up
      const stemX = midX + (tipX - midX) * clamp((jy - midY) / (tipY - midY), 0, 1);
      const awayX = jx - stemX;
      const phi = Math.atan2(0.6 * CELL * 0.1 + (jy - midY) * 0.3, awayX) + (rand() - 0.5) * 0.9;
      const R = CELL * (far ? 0.058 + rand() * 0.024 : 0.09 + rand() * 0.04);
      leaves.push({ jx, jy, R, phi, id: 0.04 + rand() * 0.92, depth: rand() });
      // its side twig leaves the stem lower down and climbs out to it
      const fromY = clamp(jy - Math.abs(awayX) * 0.7 - R * 0.3, baseY + CELL * 0.15, tipY);
      if (!far || i % 4 === 0) twig(ox, oy, stemX, fromY, jx - Math.cos(phi) * R * 0.15, jy - Math.sin(phi) * R * 0.15, far ? 1.6 : 2.2);
    }
    // the ones at the back first, in the shade of those in front
    leaves.sort((p, q) => p.depth - q.depth);
    for (const l of leaves) leaf(ox, oy, l.jx, l.jy, l.R, l.phi, l.id, 0.62 + 0.38 * l.depth);
  }

  const level0 = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    level0[i * 4] = Math.round(clamp(r[i], 0, 1) * 255);
    level0[i * 4 + 1] = Math.round(clamp(g[i], 0, 1) * 255);
    level0[i * 4 + 2] = Math.round(clamp(bl[i], 0, 1) * 255);
    level0[i * 4 + 3] = Math.round(clamp(a[i], 0, 1) * 255);
  }
  return mipChain(level0, S);
}

/** Share of a cell's texels whose channel passes the alpha test (0.5). */
function coverage(data: Uint8Array | Float32Array, size: number, x0: number, y0: number, w: number, ch: number, scale = 1, max = 255): number {
  let n = 0;
  for (let y = y0; y < y0 + w; y++) for (let x = x0; x < x0 + w; x++) if (Math.min(max, data[(y * size + x) * 4 + ch] * scale) > max * 0.5) n++;
  return n / (w * w);
}

function mipChain(level0: Uint8Array, size0: number): Uint8Array[] {
  const levels = [level0];
  // what each cell's leaves and twigs cover at full size
  const target = [0, 1, 2, 3].map((cell) => [3, 1].map((ch) => coverage(level0, size0, (cell % 2) * CELL, Math.floor(cell / 2) * CELL, CELL, ch)));
  let prev = level0;
  let size = size0;
  while (size > 1) {
    const half = size / 2;
    const next = new Float32Array(half * half * 4);
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        for (let c = 0; c < 4; c++) {
          const at = (xx: number, yy: number) => prev[(yy * size + xx) * 4 + c];
          next[(y * half + x) * 4 + c] = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
        }
      }
    }
    const cell = half / 2;
    if (cell >= 2) {
      for (let k = 0; k < 4; k++) {
        const x0 = (k % 2) * cell;
        const y0 = Math.floor(k / 2) * cell;
        [3, 1].forEach((ch, j) => {
          // the scale that lets the same share of texels through: the value at that quantile, lifted to the threshold
          const vals = new Float32Array(cell * cell);
          for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) vals[y * cell + x] = next[((y0 + y) * half + x0 + x) * 4 + ch];
          vals.sort();
          const want = target[k][j];
          const q = vals[Math.min(vals.length - 1, Math.max(0, Math.floor((1 - want) * vals.length)))];
          const scale = want > 0 && q > 0 ? clamp(127.5 / q, 1, 6) : 1;
          for (let y = y0; y < y0 + cell; y++) for (let x = x0; x < x0 + cell; x++) next[(y * half + x) * 4 + ch] *= scale;
        });
      }
    }
    const out = new Uint8Array(half * half * 4);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(clamp(next[i], 0, 255));
    levels.push(out);
    prev = out;
    size = half;
  }
  return levels;
}

let atlas: THREE.DataTexture | null = null;

/** The leaf atlas as a texture, with its mip levels; drawn the first time it is asked for. */
export function leafTexture(): THREE.DataTexture {
  if (atlas) return atlas;
  const levels = leafAtlas();
  const tex = new THREE.DataTexture(levels[0], ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = levels.map((data, i) => ({ data, width: ATLAS_SIZE >> i, height: ATLAS_SIZE >> i })) as unknown as typeof tex.mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  atlas = tex;
  return tex;
}
