import { bone, BoneName, restJoint } from './rig';

/**
 * Bodies, built in code on the shared skeleton (src/people/rig.ts).
 *
 * A body is a handful of lofts: rings of vertices strung along a limb, the
 * torso or the head, each ring tied to one or two bones. Clothes are part of the
 * shape (a jacket with a hem, trouser legs, shoes with heels), and the things that
 * differ from one person to the next (a hat, long hair, a skirt, a long coat, a
 * bag) are extra pieces in the same mesh that each person shows or hides. The
 * same builder makes the dreamer (more rings, more sides) and the crowd (fewer).
 *
 * The rest pose is a T: +y up, facing +z, the left arm along +x, feet at the origin.
 */

/** What a vertex is made of. The shaders and the dreamer's palette colour by it. */
export const PART = { jacket: 0, trousers: 1, shirt: 2, tie: 3, skin: 4, hair: 5, shoes: 6, hat: 7, bag: 8, skirt: 9 } as const;
/**
 * Optional pieces. A person wears piece k when bit k-1 of their flags is set; 0 is always worn.
 * The thighs are the exception: they are there unless a skirt is (they would only poke through it).
 */
export const PIECE = { always: 0, longHair: 1, hat: 2, skirt: 3, coat: 4, bag: 5, shirtFront: 6, shortHair: 7, thighs: 8 } as const;
export const pieceBit = (piece: number): number => (piece > 0 ? 1 << (piece - 1) : 0);
/** Does someone with these flags show this piece? */
export const wears = (pieces: number, piece: number): boolean =>
  piece === PIECE.always || (piece === PIECE.thighs ? (pieces & pieceBit(PIECE.skirt)) === 0 : (pieces & pieceBit(piece)) !== 0);

type V3 = [number, number, number];
type Weights = [number, number][];

/** Proportions. Lengths come from the skeleton; these are the girths and the cut of the clothes. */
export interface BodyShape {
  /** Half-widths of the torso at the hem, hips, waist, ribs, chest and shoulders. */
  hem: number;
  hips: number;
  waist: number;
  ribs: number;
  chest: number;
  shoulders: number;
  /** Front-to-back depth of the torso, as a multiple of the default. */
  depth: number;
  /** Chest pushed forward (a bust), metres. */
  bust: number;
  /** Girth of the arms and of the legs, as multiples of the default. */
  arm: number;
  leg: number;
  /** Girth of the neck, and size of the head, hands and feet. */
  neck: number;
  head: number;
  hand: number;
  foot: number;
  /** Size of the bag (a briefcase at 1, a handbag below). */
  bag: number;
  /** How far the long hair falls below the crown, metres. */
  hairLength: number;
}

export const MAN: BodyShape = {
  hem: 0.18,
  hips: 0.175,
  waist: 0.158,
  ribs: 0.168,
  chest: 0.19,
  shoulders: 0.202,
  depth: 1,
  bust: 0,
  arm: 1,
  leg: 1,
  neck: 1.12,
  head: 1.07,
  hand: 0.92,
  foot: 1,
  bag: 1,
  hairLength: 0.3,
};

/** The same number of vertices in the same order as MAN, so one can be morphed into the other. */
export const WOMAN: BodyShape = {
  hem: 0.184,
  hips: 0.178,
  waist: 0.132,
  ribs: 0.142,
  chest: 0.158,
  shoulders: 0.168,
  depth: 0.9,
  bust: 0.022,
  arm: 0.8,
  leg: 0.86,
  neck: 0.9,
  head: 1.03,
  hand: 0.8,
  foot: 0.88,
  bag: 0.62,
  hairLength: 0.34,
};

export interface BodyDetail {
  /** Sides of a limb, of the torso and of the head. */
  limb: number;
  torso: number;
  head: number;
  /** Extra rings between the ones the shape defines (0 for the crowd). */
  refine: number;
  /** Ears, lapels, pocket square: only worth it close up. */
  fine: boolean;
}

export const CROWD_DETAIL: BodyDetail = { limb: 5, torso: 8, head: 8, refine: 0, fine: false };
export const HERO_DETAIL: BodyDetail = { limb: 12, torso: 18, head: 16, refine: 2, fine: true };

export interface BodyMesh {
  position: Float32Array;
  normal: Float32Array;
  /** Up to four (bone, weight) pairs a vertex, heaviest first. */
  bones: Uint8Array;
  weights: Float32Array;
  part: Uint8Array;
  piece: Uint8Array;
  /** 1 on the head (it turns to look), part way down the neck, 0 elsewhere. */
  look: Float32Array;
  index: Uint32Array;
}

interface Ring {
  c: V3;
  /** Radii towards +u, -u, +v, -v. */
  r: [number, number, number, number];
  /** The ring's plane is tipped: this much rise along the loft per metre towards +u. */
  slope?: number;
  w: Weights | ((cos: number, sin: number) => Weights);
  part?: number;
  look?: number;
}

interface LoftOptions {
  u: V3;
  v: V3;
  sides: number;
  part: number;
  piece?: number;
  look?: number;
  /** Close the ends with a point this far beyond them (0 is flat). */
  capStart?: number;
  capEnd?: number;
  refine?: number;
  /** Turn the ring by this much of a side, so no vertex sits on the centre line (a skirt parts between the legs, not on one). */
  turn?: number;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

class Builder {
  pos: number[] = [];
  bones: number[] = [];
  weights: number[] = [];
  part: number[] = [];
  piece: number[] = [];
  look: number[] = [];
  index: number[] = [];

  vertex(p: V3, w: Weights, part: number, piece: number, look: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    const merged = new Map<number, number>();
    for (const [bn, v] of w) merged.set(bn, (merged.get(bn) ?? 0) + v);
    const sorted = [...merged.entries()].filter((x) => x[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = sorted.reduce((s, x) => s + x[1], 0);
    for (let k = 0; k < 4; k++) {
      this.bones.push(sorted[k] ? sorted[k][0] : sorted[0][0]);
      this.weights.push(sorted[k] ? sorted[k][1] / total : 0);
    }
    this.part.push(part);
    this.piece.push(piece);
    this.look.push(look);
    return i;
  }

  tri(a: number, b: number, c: number, flip: boolean): void {
    if (flip) this.index.push(a, c, b);
    else this.index.push(a, b, c);
  }

  /** String rings into a tube. Rings share the frame (u, v); the loft runs along u x v or against it. */
  loft(rings: Ring[], o: LoftOptions): void {
    const along = cross(o.u, o.v);
    const list = o.refine ? refine(rings, o.refine) : rings;
    const dir = [0, 1, 2].reduce((s, k) => s + (list[list.length - 1].c[k] - list[0].c[k]) * along[k], 0);
    const flip = dir < 0;
    const piece = o.piece ?? 0;
    const start: number[] = [];
    list.forEach((ring, ri) => {
      start.push(this.pos.length / 3);
      for (let k = 0; k < o.sides; k++) {
        const th = ((k + (o.turn ?? 0)) / o.sides) * Math.PI * 2;
        const cos = Math.cos(th);
        const sin = Math.sin(th);
        const a = cos * (cos >= 0 ? ring.r[0] : ring.r[1]);
        const b = sin * (sin >= 0 ? ring.r[2] : ring.r[3]);
        const rise = (ring.slope ?? 0) * a;
        const p: V3 = [0, 1, 2].map((j) => ring.c[j] + o.u[j] * a + o.v[j] * b + along[j] * rise) as V3;
        const w = typeof ring.w === 'function' ? ring.w(cos, sin) : ring.w;
        this.vertex(p, w, ring.part ?? o.part, piece, ring.look ?? o.look ?? 0);
      }
      if (ri > 0) {
        const s0 = start[ri - 1];
        const s1 = start[ri];
        for (let k = 0; k < o.sides; k++) {
          const k1 = (k + 1) % o.sides;
          this.tri(s0 + k, s0 + k1, s1 + k, flip);
          this.tri(s0 + k1, s1 + k1, s1 + k, flip);
        }
      }
    });
    const cap = (ring: Ring, s: number, beyond: number, end: boolean) => {
      const sign = (end ? 1 : -1) * (flip ? -1 : 1);
      const p: V3 = [0, 1, 2].map((j) => ring.c[j] + along[j] * beyond * sign) as V3;
      const w = typeof ring.w === 'function' ? ring.w(1, 0) : ring.w;
      const c = this.vertex(p, w, ring.part ?? o.part, piece, ring.look ?? o.look ?? 0);
      for (let k = 0; k < o.sides; k++) {
        const k1 = (k + 1) % o.sides;
        if (end) this.tri(s + k, s + k1, c, flip);
        else this.tri(s + k1, s + k, c, flip);
      }
    };
    if (o.capStart !== undefined) cap(list[0], start[0], o.capStart, false);
    if (o.capEnd !== undefined) cap(list[list.length - 1], start[start.length - 1], o.capEnd, true);
  }

  /** A patch of quads from rows of points (each row the same length), facing the way `front` points. */
  sheet(rows: { p: V3; w: Weights }[][], part: number, piece: number, front: V3, look = 0): void {
    const ids = rows.map((row) => row.map((v) => this.vertex(v.p, v.w, part, piece, look)));
    for (let r = 0; r < rows.length - 1; r++) {
      for (let k = 0; k < rows[r].length - 1; k++) {
        const a = rows[r][k].p;
        const b = rows[r][k + 1].p;
        const c = rows[r + 1][k].p;
        const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        const flip = n[0] * front[0] + n[1] * front[1] + n[2] * front[2] < 0;
        this.tri(ids[r][k], ids[r][k + 1], ids[r + 1][k], flip);
        this.tri(ids[r][k + 1], ids[r + 1][k + 1], ids[r + 1][k], flip);
      }
    }
  }

  /** A box with flat faces. */
  box(min: V3, max: V3, w: Weights, part: number, piece: number): void {
    const corner = (i: number): V3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const faces = [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ];
    for (const f of faces) {
      const ids = f.map((i) => this.vertex(corner(i), w, part, piece, 0));
      this.index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
  }
}

/** Insert `n` rings between each pair, on a smooth curve through the rings' own values. */
function refine(rings: Ring[], n: number): Ring[] {
  const out: Ring[] = [];
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
    0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[Math.max(0, i - 1)];
    const b = rings[i];
    const c = rings[i + 1];
    const d = rings[Math.min(rings.length - 1, i + 2)];
    out.push(b);
    for (let s = 1; s <= n; s++) {
      const t = s / (n + 1);
      const wOf = (ring: Ring, cos: number, sin: number) => (typeof ring.w === 'function' ? ring.w(cos, sin) : ring.w);
      out.push({
        c: [0, 1, 2].map((j) => cr(a.c[j], b.c[j], c.c[j], d.c[j], t)) as V3,
        // girths must not overshoot into a pinch or a bulge between two equal rings
        r: [0, 1, 2, 3].map((j) => Math.max(Math.min(b.r[j], c.r[j]) * 0.96, cr(a.r[j], b.r[j], c.r[j], d.r[j], t))) as Ring['r'],
        slope: lerp(b.slope ?? 0, c.slope ?? 0, t),
        w: (cos, sin) => [...wOf(b, cos, sin).map(([bn, w]) => [bn, w * (1 - t)] as [number, number]), ...wOf(c, cos, sin).map(([bn, w]) => [bn, w * t] as [number, number])],
        part: t < 0.5 ? b.part : c.part,
        look: lerp(b.look ?? NaN, c.look ?? NaN, t),
      });
      const last = out[out.length - 1];
      if (Number.isNaN(last.look)) delete last.look;
    }
  }
  out.push(rings[rings.length - 1]);
  // merge duplicate bones in blended weights
  for (const ring of out) {
    if (typeof ring.w !== 'function') continue;
    const f = ring.w;
    ring.w = (cos, sin) => {
      const m = new Map<number, number>();
      for (const [bn, w] of f(cos, sin)) m.set(bn, (m.get(bn) ?? 0) + w);
      return [...m.entries()];
    };
  }
  return out;
}

const FRONT: V3 = [0, 0, 1];
const LEFT: V3 = [1, 0, 0];
const UP: V3 = [0, 1, 0];

/** Build a body. Two shapes built with the same detail have the same vertices in the same order. */
export function buildBody(shape: BodyShape, detail: BodyDetail): BodyMesh {
  const B = new Builder();
  const b = (n: BoneName) => bone(n);
  const J = (n: BoneName) => restJoint(n);
  const one = (n: BoneName): Weights => [[b(n), 1]];
  const mix = (n0: BoneName, n1: BoneName, w0: number): Weights => [
    [b(n0), w0],
    [b(n1), 1 - w0],
  ];
  const D = shape.depth;

  // --- torso: the jacket ---------------------------------------------------
  // y, half-width, depth to the front, depth to the back, centre z, bones
  const sideOf = (sin: number) => (sin >= 0 ? 'L' : 'R');
  // the hem follows the thigh on its own side, so a raised knee lifts the jacket instead of poking through it
  const hemW = (thigh: number) => (cos: number, sin: number): Weights => {
    const k = thigh * (0.45 + 0.55 * Math.max(0, cos)) * Math.min(1, Math.abs(sin) * 3 + 0.35);
    return [
      [b('hips'), 1 - k],
      [b(`thigh${sideOf(sin)}` as BoneName), k],
    ];
  };
  // the ends of the shoulder line belong to the collar bones
  const shoulderW = (amount: number) => (_cos: number, sin: number): Weights => {
    const k = amount * Math.min(1, Math.abs(sin) * 1.6);
    return [
      [b('spine3'), 1 - k],
      [b(`shoulder${sideOf(sin)}` as BoneName), k],
    ];
  };
  const torso: { y: number; w: number; f: number; k: number; z: number; bones: Ring['w'] }[] = [
    { y: 0.8, w: shape.hem, f: 0.114, k: 0.114, z: -0.034, bones: hemW(0.5) },
    { y: 0.865, w: (shape.hem + shape.hips) / 2, f: 0.113, k: 0.111, z: -0.037, bones: hemW(0.25) },
    { y: 0.935, w: shape.hips, f: 0.112, k: 0.108, z: -0.04, bones: one('hips') },
    { y: 1.05, w: shape.waist, f: 0.104, k: 0.096, z: -0.02, bones: one('spine1') },
    { y: 1.17, w: shape.ribs, f: 0.112 + shape.bust * 0.5, k: 0.1, z: -0.006, bones: one('spine2') },
    { y: 1.3, w: shape.chest, f: 0.122 + shape.bust, k: 0.106, z: -0.006, bones: one('spine3') },
    { y: 1.395, w: shape.shoulders, f: 0.112 + shape.bust * 0.3, k: 0.104, z: -0.012, bones: shoulderW(0.5) },
    { y: 1.448, w: shape.shoulders * 0.985, f: 0.094, k: 0.097, z: -0.016, bones: shoulderW(0.65) },
    { y: 1.474, w: shape.shoulders * 0.8, f: 0.078, k: 0.086, z: -0.016, bones: shoulderW(0.4) },
    { y: 1.498, w: 0.08 * shape.neck, f: 0.066 * shape.neck, k: 0.072 * shape.neck, z: -0.012, bones: mix('spine3', 'neck', 0.6) },
  ];
  B.loft(
    torso.map((t) => ({ c: [0, t.y, t.z] as V3, r: [t.f * D, t.k * D, t.w, t.w] as Ring['r'], w: t.bones })),
    { u: FRONT, v: LEFT, sides: detail.torso, part: PART.jacket, refine: detail.refine, capStart: 0, capEnd: 0 },
  );
  /** The front of the jacket at a height and an offset from the centre line. */
  const chestAt = (y: number, x: number): { p: V3; w: Weights } => {
    let i = 0;
    while (i < torso.length - 2 && torso[i + 1].y < y) i++;
    const t0 = torso[i];
    const t1 = torso[i + 1];
    const k = Math.min(1, Math.max(0, (y - t0.y) / (t1.y - t0.y)));
    const w = lerp(t0.w, t1.w, k);
    const f = lerp(t0.f, t1.f, k) * D;
    const z = lerp(t0.z, t1.z, k) + f * Math.sqrt(Math.max(0, 1 - (x / w) * (x / w)));
    const w0 = typeof t0.bones === 'function' ? t0.bones(1, 0) : t0.bones;
    const w1 = typeof t1.bones === 'function' ? t1.bones(1, 0) : t1.bones;
    return { p: [x, y, z], w: [...w0.map(([n, v]) => [n, v * (1 - k)] as [number, number]), ...w1.map(([n, v]) => [n, v * k] as [number, number])] };
  };
  const lift = (v: { p: V3; w: Weights }, d: number) => ({ p: [v.p[0], v.p[1], v.p[2] + d] as V3, w: v.w });

  // --- shirt front, collar and tie (hidden on a dress) -------------------------
  const vee = [1.2, 1.27, 1.34, 1.41, 1.47];
  const veeHalf = (y: number) => 0.004 + (0.062 * (y - vee[0])) / (vee[vee.length - 1] - vee[0]);
  B.sheet(
    vee.map((y) => [-1, -0.5, 0, 0.5, 1].map((s) => lift(chestAt(y, s * veeHalf(y)), 0.004))),
    PART.shirt,
    PIECE.shirtFront,
    FRONT,
  );
  const tie = [
    { y: 1.205, h: 0.002 },
    { y: 1.245, h: 0.021 },
    { y: 1.36, h: 0.016 },
    { y: 1.435, h: 0.012 },
    { y: 1.455, h: 0.02 },
    { y: 1.478, h: 0.016 },
  ];
  B.sheet(
    tie.map((t) => [-1, 0, 1].map((s) => lift(chestAt(t.y, s * t.h), 0.009 + (s === 0 ? 0.004 : 0)))),
    PART.tie,
    PIECE.shirtFront,
    FRONT,
  );
  if (detail.fine) {
    // lapels: two darker folds either side of the shirt, and a pocket square
    for (const s of [-1, 1]) {
      B.sheet(
        vee.map((y) => {
          const inner = veeHalf(y) * 0.9;
          const outer = inner + 0.012 + 0.03 * Math.sin(((y - vee[0]) / (vee[vee.length - 1] - vee[0])) * Math.PI * 0.85);
          return [lift(chestAt(y, s * inner), 0.0075), lift(chestAt(y, s * outer), 0.004)];
        }),
        PART.jacket,
        PIECE.shirtFront,
        FRONT,
      );
    }
    B.sheet(
      [1.335, 1.35].map((y) => [0.075, 0.115].map((x) => lift(chestAt(y, x), 0.004))),
      PART.shirt,
      PIECE.shirtFront,
      FRONT,
    );
  }

  // --- neck and shirt collar ---------------------------------------------------
  const neck = J('neck');
  const head = J('head');
  const nr = shape.neck;
  B.loft(
    [
      { c: [0, 1.47, neck[2] - 0.004], r: [0.05 * nr, 0.052 * nr, 0.05 * nr, 0.05 * nr], w: mix('spine3', 'neck', 0.5), look: 0 },
      { c: [0, 1.54, neck[2] + 0.004], r: [0.046 * nr, 0.05 * nr, 0.047 * nr, 0.047 * nr], w: one('neck'), look: 0.35 },
      { c: [0, 1.63, head[2] + 0.004], r: [0.046 * nr, 0.052 * nr, 0.048 * nr, 0.048 * nr], w: one('head'), look: 1 },
    ],
    { u: FRONT, v: LEFT, sides: detail.limb, part: PART.skin },
  );
  B.loft(
    [
      { c: [0, 1.478, neck[2] - 0.006], r: [0.066 * nr, 0.066 * nr, 0.068 * nr, 0.068 * nr], w: mix('spine3', 'neck', 0.6) },
      { c: [0, 1.518, neck[2] - 0.002], r: [0.057 * nr, 0.06 * nr, 0.058 * nr, 0.058 * nr], slope: -0.25, w: mix('spine3', 'neck', 0.4) },
      { c: [0, 1.52, neck[2] - 0.002], r: [0.049 * nr, 0.053 * nr, 0.05 * nr, 0.05 * nr], slope: -0.25, w: mix('spine3', 'neck', 0.4) },
    ],
    { u: FRONT, v: LEFT, sides: detail.limb, part: PART.shirt, piece: PIECE.shirtFront },
  );

  // --- head ----------------------------------------------------------------------
  const hs = shape.head;
  const hy = (y: number) => head[1] + (y - 1.569) * hs;
  // y, half-width, depth to the front, depth to the back, centre z
  const skull: [number, number, number, number, number][] = [
    [1.588, 0.04, 0.044, 0.032, 0.034],
    [1.616, 0.058, 0.066, 0.052, 0.022],
    [1.66, 0.068, 0.081, 0.075, 0.009],
    [1.71, 0.071, 0.089, 0.088, 0.002],
    [1.76, 0.073, 0.09, 0.094, -0.003],
    [1.8, 0.065, 0.078, 0.087, -0.008],
    [1.83, 0.04, 0.048, 0.056, -0.012],
  ];
  const skullRing = (row: number[], grow = 1, slope = 0): Ring => ({
    c: [0, hy(row[0]), head[2] - 0.005 + row[4] * hs],
    r: [row[2] * hs * grow, row[3] * hs * grow, row[1] * hs * grow, row[1] * hs * grow],
    slope,
    w: one('head'),
  });
  B.loft(skull.map((r) => skullRing(r)), {
    u: FRONT,
    v: LEFT,
    sides: detail.head,
    part: PART.skin,
    look: 1,
    refine: detail.refine,
    capStart: 0.006,
    capEnd: 0.01 * hs,
  });
  // a nose, so the head has a front
  {
    const z0 = head[2] - 0.005;
    const tip: V3 = [0, hy(1.688), z0 + 0.112 * hs];
    const top: V3 = [0, hy(1.728), z0 + 0.086 * hs];
    const l: V3 = [0.016 * hs, hy(1.678), z0 + 0.082 * hs];
    const r: V3 = [-0.016 * hs, hy(1.678), z0 + 0.082 * hs];
    const ids = [tip, top, l, r].map((p) => B.vertex(p, one('head'), PART.skin, 0, 1));
    B.index.push(ids[0], ids[2], ids[1], ids[0], ids[1], ids[3], ids[0], ids[3], ids[2]);
  }
  if (detail.fine) {
    for (const s of [-1, 1]) {
      B.loft(
        [
          { c: [s * 0.066 * hs, hy(1.705), head[2] - 0.012], r: [0.012, 0.014, 0.021, 0.019], w: one('head') },
          { c: [s * 0.079 * hs, hy(1.708), head[2] - 0.02], r: [0.013, 0.016, 0.026, 0.022], w: one('head') },
          { c: [s * 0.083 * hs, hy(1.708), head[2] - 0.024], r: [0.006, 0.008, 0.014, 0.012], w: one('head') },
        ],
        { u: FRONT, v: UP, sides: 8, part: PART.skin, look: 1, capEnd: 0.002 },
      );
    }
  }

  // --- hair ----------------------------------------------------------------------
  // a short cut: a cap whose edge runs from the forehead down to the nape
  B.loft(
    [
      { ...skullRing([1.7, 0.0745, 0.0905, 0.093, 0.001], 1.035, 0.6), part: PART.hair },
      { ...skullRing([1.76, 0.0745, 0.092, 0.097, -0.003], 1.05, 0.2), part: PART.hair },
      { ...skullRing([1.803, 0.066, 0.08, 0.089, -0.008], 1.07, 0.06), part: PART.hair },
      { ...skullRing([1.834, 0.04, 0.05, 0.058, -0.012], 1.09, 0), part: PART.hair },
    ],
    { u: FRONT, v: LEFT, sides: detail.head, part: PART.hair, piece: PIECE.shortHair, look: 1, refine: detail.refine ? 1 : 0, capEnd: 0.012 * hs },
  );
  // long hair: the same crown, falling past the jaw at the sides and the back and open at the face
  {
    const drop = shape.hairLength;
    B.loft(
      [
        { ...skullRing([1.84 - drop, 0.08, 0.036, 0.1, -0.03], 1.02, 0.35), part: PART.hair, look: 0.6 },
        { ...skullRing([1.84 - drop * 0.6, 0.09, 0.06, 0.108, -0.014], 1.03, 0.75), part: PART.hair },
        { ...skullRing([1.752, 0.081, 0.094, 0.1, -0.003], 1.07, 0.5), part: PART.hair },
        { ...skullRing([1.806, 0.068, 0.082, 0.091, -0.008], 1.1, 0.12), part: PART.hair },
        { ...skullRing([1.838, 0.04, 0.05, 0.058, -0.012], 1.12, 0), part: PART.hair },
      ],
      { u: FRONT, v: LEFT, sides: detail.head, part: PART.hair, piece: PIECE.longHair, look: 1, capEnd: 0.014 * hs },
    );
  }

  // --- hat: a brim and a crown ---------------------------------------------------
  {
    const z = head[2] - 0.012;
    const y0 = hy(1.792);
    const brim = (y: number, r: number): Ring => ({ c: [0, y, z], r: [r * 1.12, r * 1.05, r, r], slope: -0.1, w: one('head') });
    B.loft([brim(y0 + 0.004, 0.082 * hs), brim(y0, 0.15 * hs), brim(y0 - 0.006, 0.146 * hs), brim(y0 - 0.004, 0.08 * hs)], {
      u: FRONT,
      v: LEFT,
      sides: detail.head,
      part: PART.hat,
      piece: PIECE.hat,
      look: 1,
    });
    B.loft(
      [
        { c: [0, y0, z], r: [0.1 * hs, 0.104 * hs, 0.086 * hs, 0.086 * hs], slope: -0.1, w: one('head') },
        { c: [0, y0 + 0.06 * hs, z], r: [0.094 * hs, 0.1 * hs, 0.08 * hs, 0.08 * hs], slope: -0.08, w: one('head') },
        { c: [0, y0 + 0.105 * hs, z - 0.004], r: [0.082 * hs, 0.092 * hs, 0.07 * hs, 0.07 * hs], slope: -0.14, w: one('head') },
      ],
      { u: FRONT, v: LEFT, sides: detail.head, part: PART.hat, piece: PIECE.hat, look: 1, capEnd: -0.012 },
    );
  }

  // --- arms and hands ------------------------------------------------------------
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const sh = J(`upperarm${side}`);
    const el = J(`forearm${side}`);
    const wr = J(`hand${side}`);
    const upper = `upperarm${side}` as BoneName;
    const fore = `forearm${side}` as BoneName;
    const hand = `hand${side}` as BoneName;
    const a = shape.arm;
    const at = (x: number): V3 => {
      const ax = Math.abs(x);
      const k = ax <= Math.abs(el[0]) ? (ax - Math.abs(sh[0])) / (Math.abs(el[0]) - Math.abs(sh[0])) : 1 + (ax - Math.abs(el[0])) / (Math.abs(wr[0]) - Math.abs(el[0]));
      const y = k <= 1 ? lerp(sh[1], el[1], k) : lerp(el[1], wr[1], k - 1);
      const z = k <= 1 ? lerp(sh[2], el[2], k) : lerp(el[2], wr[2], k - 1);
      return [s * ax, y, z];
    };
    const ring = (x: number, ry: number, rz: number, w: Weights, part?: number): Ring => ({ c: at(x), r: [ry * a, ry * a, rz * a, rz * a], w, part });
    const e = Math.abs(el[0]);
    const w = Math.abs(wr[0]);
    const j = Math.abs(sh[0]);
    // The shoulder is a ball centred on the joint: turning a ball about its centre leaves
    // it where it was, so the shoulder keeps its shape whether the arm is out or down.
    const R = 0.05;
    const ball = (d: number): Ring => {
      const r = Math.sqrt(R * R - d * d);
      return { c: [s * (j + d), sh[1] - 0.016, sh[2]], r: [r * a, r * a, r * a * 1.04, r * a * 1.04], w: one(upper) };
    };
    const armU: V3 = UP;
    const armV: V3 = [0, 0, s];
    const sleeve = detail.fine
      ? [
          ball(-0.042),
          ball(-0.022),
          ball(0),
          ball(0.024),
          ring(j + 0.06, 0.048, 0.052, one(upper)),
          ring(0.3, 0.05, 0.054, one(upper)),
          ring(e - 0.05, 0.048, 0.052, mix(upper, fore, 0.9)),
          ring(e, 0.046, 0.049, mix(upper, fore, 0.5)),
          ring(e + 0.05, 0.045, 0.048, mix(upper, fore, 0.1)),
          ring(0.62, 0.04, 0.043, one(fore)),
          ring(w - 0.02, 0.037, 0.041, one(fore)),
          ring(w - 0.016, 0.03, 0.033, one(fore)),
        ]
      : // the crowd's sleeve: the same line with half the rings
        [
          ball(-0.036),
          ball(0.004),
          ring(j + 0.06, 0.048, 0.052, one(upper)),
          ring(e - 0.045, 0.048, 0.052, mix(upper, fore, 0.85)),
          ring(e + 0.045, 0.045, 0.048, mix(upper, fore, 0.15)),
          ring(w - 0.02, 0.037, 0.041, one(fore)),
          ring(w - 0.016, 0.03, 0.033, one(fore)),
        ];
    B.loft(sleeve, { u: armU, v: armV, sides: detail.limb, part: PART.jacket, refine: detail.refine, capStart: 0.012 });
    // a line of shirt cuff
    B.loft([ring(w - 0.03, 0.032, 0.035, one(fore), PART.shirt), ring(w - 0.004, 0.031, 0.034, mix(fore, hand, 0.6), PART.shirt)], {
      u: armU,
      v: armV,
      sides: detail.limb,
      part: PART.shirt,
    });
    const h = shape.hand;
    const hr = (x: number, ry: number, rz: number, dz = 0): Ring => ({ c: [s * (w + x * h), wr[1] - 0.002, wr[2] + dz * h], r: [ry * h, ry * h, rz * h, rz * h], w: one(hand) });
    const palm = detail.fine
      ? [hr(-0.012, 0.017, 0.026), hr(0.025, 0.02, 0.04, 0.004), hr(0.075, 0.018, 0.045, 0.004), hr(0.135, 0.013, 0.039, 0.002), hr(0.178, 0.008, 0.022)]
      : [hr(-0.012, 0.017, 0.026), hr(0.06, 0.02, 0.044, 0.004), hr(0.165, 0.01, 0.03, 0.002)];
    B.loft(palm, { u: armU, v: armV, sides: detail.limb, part: PART.skin, capStart: 0.004, capEnd: 0.008 });
    if (detail.fine) {
      // the thumb, forward of the palm
      const th = (x: number, z: number, r: number): Ring => ({ c: [s * (w + x * h), wr[1] - 0.006, wr[2] + z * h], r: [r * h, r * h, r * h, r * h], w: one(hand) });
      B.loft([th(0.02, 0.03, 0.013), th(0.055, 0.058, 0.012), th(0.085, 0.074, 0.007)], {
        u: UP,
        v: [s * 0.64, 0, -0.77],
        sides: Math.max(4, detail.limb - 2),
        part: PART.skin,
        capEnd: 0.006,
      });
    }
  }

  // --- legs: trousers and shoes ---------------------------------------------------
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const hip = J(`thigh${side}`);
    const knee = J(`shin${side}`);
    const ankle = J(`foot${side}`);
    const toe = J(`toe${side}`);
    const thigh = `thigh${side}` as BoneName;
    const shin = `shin${side}` as BoneName;
    const foot = `foot${side}` as BoneName;
    const g = shape.leg;
    const zAt = (y: number) => (y >= knee[1] ? lerp(knee[2], hip[2], (y - knee[1]) / (hip[1] - knee[1])) : lerp(ankle[2], knee[2], (y - ankle[1]) / (knee[1] - ankle[1])));
    const ring = (y: number, rx: number, rz: number, w: Weights, dz = 0, dx = 0): Ring => ({
      c: [hip[0] + s * dx, y, zAt(y) + dz],
      r: [rz * g, rz * g, rx * g, rx * g],
      w,
    });
    const ky = knee[1];
    const leg = [
      ring(0.955, 0.088, 0.1, mix('hips', thigh, 0.5), -0.01, 0.004),
      ring(0.84, 0.089, 0.098, one(thigh), -0.004, 0.002),
      ring(0.7, 0.077, 0.085, one(thigh)),
      ring(ky + 0.055, 0.065, 0.071, mix(thigh, shin, 0.9)),
      ring(ky, 0.061, 0.067, mix(thigh, shin, 0.5), 0.004),
      ring(ky - 0.055, 0.058, 0.064, mix(thigh, shin, 0.1)),
      ring(0.36, 0.056, 0.062, one(shin), -0.004),
      ring(0.2, 0.051, 0.057, one(shin)),
      ring(0.09, 0.053, 0.064, one(shin), 0.012),
      ring(0.086, 0.04, 0.05, one(shin), 0.012),
    ];
    const legs = { u: FRONT, v: LEFT, sides: detail.limb, part: PART.trousers, refine: detail.refine };
    if (detail.refine) {
      B.loft(leg, { ...legs, capStart: 0.01 });
    } else {
      // In the crowd the leg is two pieces, so that under a skirt the thigh can go (see PIECE.thighs).
      B.loft(leg.slice(0, 4), { ...legs, piece: PIECE.thighs, capStart: 0.01 });
      B.loft([leg[3], leg[4], leg[6], leg[8], leg[9]], { ...legs, capStart: 0 });
    }
    const f = shape.foot;
    const az = ankle[2];
    // z, half-width, top, bones
    const shoe = (z: number, hw: number, top: number, w: Weights): Ring => ({
      c: [ankle[0], 0.022, az + (z - az) * f],
      r: [top - 0.022, 0.02, hw * f, hw * f],
      w,
    });
    const last = [
      shoe(az - 0.07, 0.03, 0.06, one(foot)),
      shoe(az - 0.045, 0.041, 0.1, one(foot)),
      shoe(az + 0.015, 0.045, 0.108, one(foot)),
      shoe(az + 0.085, 0.048, 0.078, one(foot)),
      shoe(toe[2], 0.05, 0.052, mix(foot, `toe${side}` as BoneName, 0.5)),
      shoe(toe[2] + 0.07, 0.044, 0.04, one(`toe${side}` as BoneName)),
      shoe(toe[2] + 0.105, 0.026, 0.03, one(`toe${side}` as BoneName)),
    ];
    B.loft(detail.fine ? last : [last[0], last[2], last[4], last[6]], { u: UP, v: [s, 0, 0], sides: detail.limb, part: PART.shoes, capStart: 0.004, capEnd: 0.008 });
  }

  // --- a skirt, and the skirts of a long coat --------------------------------------
  // each side of a skirt hangs from the thigh under it: all of it at the front, where the knee comes through
  const skirtW = (thigh: number) => (cos: number, sin: number): Weights => {
    const k = thigh * (0.6 + 0.4 * Math.max(0, cos));
    return [
      [b('hips'), 1 - k],
      [b(`thigh${sideOf(sin)}` as BoneName), k],
    ];
  };
  const drape = (y: number, w: number, f: number, k: number, z: number, bones: Ring['w']): Ring => ({ c: [0, y, z], r: [f, k, w, w], w: bones });
  B.loft(
    [
      drape(1.06, shape.waist * 1.03, 0.108 * D, 0.1 * D, -0.02, mix('spine1', 'hips', 0.5)),
      drape(0.93, shape.hips * 1.07, 0.125, 0.122, -0.04, one('hips')),
      drape(0.74, 0.212, 0.156, 0.152, -0.03, skirtW(0.6)),
      drape(0.54, 0.232, 0.18, 0.172, -0.022, skirtW(0.92)),
    ],
    { u: FRONT, v: LEFT, sides: detail.torso, part: PART.skirt, piece: PIECE.skirt, refine: detail.refine ? 1 : 0, capStart: 0, turn: 0.5 },
  );
  B.loft(
    [
      drape(0.8, shape.hem * 1.03, 0.122, 0.12, -0.032, hemW(0.5)),
      drape(0.66, shape.hem * 1.08, 0.136, 0.134, -0.03, skirtW(0.7)),
      drape(0.5, shape.hem * 1.14, 0.152, 0.148, -0.026, skirtW(0.92)),
    ],
    { u: FRONT, v: LEFT, sides: detail.torso, part: PART.jacket, piece: PIECE.coat, refine: detail.refine ? 1 : 0, turn: 0.5 },
  );

  // --- a bag in the right hand ------------------------------------------------------
  {
    const wr = J('handR');
    const g = shape.bag;
    const x0 = wr[0] - 0.085;
    const grip: Weights = one('handR');
    B.box([x0 - 0.05 * g - 0.01, wr[1] - 0.012, wr[2] - 0.05 * g], [x0 + 0.03, wr[1] + 0.012, wr[2] + 0.05 * g], grip, PART.bag, PIECE.bag);
    B.box([x0 - 0.05 * g - 0.01 - 0.3 * g, wr[1] - 0.05 * g, wr[2] - 0.21 * g], [x0 - 0.05 * g - 0.01, wr[1] + 0.05 * g, wr[2] + 0.21 * g], grip, PART.bag, PIECE.bag);
  }

  return finish(B);
}

function finish(B: Builder): BodyMesh {
  const n = B.pos.length / 3;
  const position = new Float32Array(B.pos);
  const normal = new Float32Array(n * 3);
  const index = new Uint32Array(B.index);
  for (let t = 0; t < index.length; t += 3) {
    const [i, j, k] = [index[t] * 3, index[t + 1] * 3, index[t + 2] * 3];
    const e1: V3 = [position[j] - position[i], position[j + 1] - position[i + 1], position[j + 2] - position[i + 2]];
    const e2: V3 = [position[k] - position[i], position[k + 1] - position[i + 1], position[k + 2] - position[i + 2]];
    const c = cross(e1, e2);
    for (const v of [i, j, k]) {
      normal[v] += c[0];
      normal[v + 1] += c[1];
      normal[v + 2] += c[2];
    }
  }
  for (let v = 0; v < n * 3; v += 3) {
    const l = Math.hypot(normal[v], normal[v + 1], normal[v + 2]) || 1;
    normal[v] /= l;
    normal[v + 1] /= l;
    normal[v + 2] /= l;
  }
  return {
    position,
    normal,
    bones: new Uint8Array(B.bones),
    weights: new Float32Array(B.weights),
    part: new Uint8Array(B.part),
    piece: new Uint8Array(B.piece),
    look: new Float32Array(B.look),
    index,
  };
}
