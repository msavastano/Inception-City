import { MAX_FOLDS } from './config';

/**
 * THE FOLD ALGEBRA
 *
 * A fold is a hinge line drawn on the flat fabric (point h, unit normal n).
 * Everything on the far side (d = (p - h)·n > 0) is bent upward (angle > 0)
 * or downward (angle < 0) around a cylinder of radius R that sits on the hinge.
 *
 * For a fabric point at distance d past the hinge, the fold is a *rigid*
 * transform M(d):
 *
 *     M(d) = T(C) · Rot_n(a) · T(-C) · T(-min(d, L)·n)
 *     a    = sign(θ) · min(d / R, |θ|),   L = R·|θ|,   C = h + sign(θ)·R·up
 *
 * Because M depends only on the *fabric* coordinate, folds compose as plain
 * products (world = M₁ · M₂ · … · Mₙ · p), the result is always continuous,
 * and the street surface (height 0) is mapped isometrically: walking distances
 * are preserved, which is what lets a pedestrian walk up the curl and onto the
 * ceiling without the simulation ever knowing the city is folded.
 *
 * This file is the CPU mirror of FOLD_GLSL in src/city/shaders.ts. The two must
 * stay in lock-step; tests/fold.test.ts pins the behaviour.
 */

export interface FoldShape {
  /** Hinge point, fabric metres. */
  hx: number;
  hz: number;
  /** Unit normal pointing at the side that moves. */
  nx: number;
  nz: number;
  /** Bend angle in radians. Positive curls up (towards the sky), negative curls down. */
  angle: number;
  /** Radius of the curl. Larger radii make gentler, longer bends. */
  radius: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Rotate v in the plane spanned by (n, up), turning n towards up by the angle (c = cos, s = sin). */
function rotate(v: Vec3Like, nx: number, nz: number, c: number, s: number): void {
  const vn = v.x * nx + v.z * nz;
  const vu = v.y;
  const tx = v.x - vn * nx;
  const tz = v.z - vn * nz;
  const rn = vn * c - vu * s;
  v.x = tx + rn * nx;
  v.y = vn * s + vu * c;
  v.z = tz + rn * nz;
}

/**
 * Apply an ordered fold list to point p (in place). fx/fz are the point's
 * *fabric* coordinates, which decide how far past each hinge it lies.
 * If a basis is given, its three vectors are rotated along with the point,
 * which yields the local frame (tangent, up, bitangent) at that spot.
 */
export function foldPoint(
  folds: readonly FoldShape[],
  fx: number,
  fz: number,
  p: Vec3Like,
  basis?: readonly Vec3Like[],
): void {
  // The first fold to move a point claims it. A later fold that crosses the
  // claimant (rather than nesting parallel to it) leaves the point alone: the
  // sheet is cut along the crossing, the way you cut the corners out of paper
  // before folding it into a box. Without the cut, the corner would have to stretch.
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < folds.length; i++) {
    const f = folds[i];
    const d = (fx - f.hx) * f.nx + (fz - f.hz) * f.nz;
    if (d <= 0 || f.angle === 0) continue;
    if (cx !== 0 || cz !== 0) {
      if (Math.abs(cx * f.nx + cz * f.nz) < CROSSING_DOT) continue;
    } else {
      cx = f.nx;
      cz = f.nz;
    }
    const sgn = f.angle < 0 ? -1 : 1;
    const absA = Math.abs(f.angle);
    const L = f.radius * absA;
    const shift = Math.min(d, L);
    const a = sgn * Math.min(d / f.radius, absA);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const cy = sgn * f.radius;
    p.x -= shift * f.nx + f.hx;
    p.y -= cy;
    p.z -= shift * f.nz + f.hz;
    rotate(p, f.nx, f.nz, c, s);
    p.x += f.hx;
    p.y += cy;
    p.z += f.hz;
    if (basis) for (const b of basis) rotate(b, f.nx, f.nz, c, s);
  }
}

/** Folds whose normals are within ~25° of each other nest; anything else crosses. */
export const CROSSING_DOT = 0.9;

/** Signed distance of the fabric origin (the dream's anchor) from the hinge. */
export function anchorDistance(f: FoldShape): number {
  return -(f.hx * f.nx + f.hz * f.nz);
}

/**
 * Order folds so that composition matches paper intuition: a fold further from
 * the anchor is applied first, so a nearer fold carries it along rigidly.
 */
export function sortFolds<T extends FoldShape & { id: number }>(folds: readonly T[]): T[] {
  return [...folds].sort((a, b) => anchorDistance(a) - anchorDistance(b) || a.id - b.id);
}

let nextId = 1;

export class Fold implements FoldShape {
  readonly id = nextId++;
  angle = 0;
  vel = 0;
  removing = false;
  /** Let go by a kick (or a new city): it unwinds without straining the dream. */
  released = false;
  constructor(
    public hx: number,
    public hz: number,
    public nx: number,
    public nz: number,
    public radius: number,
    public target: number,
    public stiffness = 7,
  ) {
    const len = Math.hypot(nx, nz) || 1;
    this.nx = nx / len;
    this.nz = nz / len;
  }
}

/**
 * The live set of folds: animates each one with a critically damped spring
 * and packs the result into uniform arrays for the GPU.
 */
export class FoldStack {
  folds: Fold[] = [];
  /** The exact list (and order) the GPU is using this frame. Use it for CPU queries. */
  active: Fold[] = [];
  readonly uA = new Float32Array(MAX_FOLDS * 4);
  readonly uB = new Float32Array(MAX_FOLDS * 4);
  count = 0;
  /** Sum of |angular velocity| this frame: drives the audio rumble. */
  motion = 0;
  /** Like motion, but only for folds the dream still holds (not released ones): drives dream instability. */
  strain = 0;
  /** Total |angle| of the active folds the dream still holds, in half turns: sets the instability floor. */
  load = 0;
  /** Incremented whenever folds are added or removed (cheap change detection). */
  version = 0;

  add(hx: number, hz: number, nx: number, nz: number, target: number, radius = 90, stiffness = 7): Fold {
    const live = this.folds.filter((f) => !f.removing);
    if (live.length >= MAX_FOLDS) this.remove(live[0]);
    const fold = new Fold(hx, hz, nx, nz, Math.max(8, radius), target, stiffness);
    this.folds.push(fold);
    this.version++;
    return fold;
  }

  remove(fold: Fold): void {
    fold.removing = true;
    fold.target = 0;
  }

  /** Unfold everything (the kick). The dream lets go, so the unwinding costs no stability. */
  clear(stiffness?: number): void {
    for (const f of this.folds) {
      this.remove(f);
      f.released = true;
      if (stiffness) f.stiffness = stiffness;
    }
  }

  /** Remove instantly, without animation. */
  reset(): void {
    this.folds = [];
    this.active = [];
    this.count = 0;
    this.version++;
  }

  live(): Fold[] {
    return this.folds.filter((f) => !f.removing);
  }

  update(dt: number): void {
    let motion = 0;
    let strain = 0;
    for (const f of this.folds) {
      const k = f.stiffness;
      const acc = k * k * (f.target - f.angle) - 2 * k * f.vel;
      f.vel += acc * dt;
      f.angle += f.vel * dt;
      if (Math.abs(f.target - f.angle) < 1e-4 && Math.abs(f.vel) < 1e-4) {
        f.angle = f.target;
        f.vel = 0;
      }
      motion += Math.abs(f.vel);
      if (!f.released) strain += Math.abs(f.vel);
    }
    const before = this.folds.length;
    this.folds = this.folds.filter((f) => !(f.removing && f.angle === 0));
    if (this.folds.length !== before) this.version++;
    this.motion = motion;
    this.strain = strain;

    this.active = sortFolds(this.folds.filter((f) => f.angle !== 0)).slice(0, MAX_FOLDS);
    this.count = this.active.length;
    this.load = this.active.reduce((s, f) => (f.released ? s : s + Math.abs(f.angle)), 0) / Math.PI;
    this.uA.fill(0);
    this.uB.fill(0);
    this.active.forEach((f, i) => {
      this.uA.set([f.hx, f.hz, f.nx, f.nz], i * 4);
      this.uB.set([f.angle, f.radius, 0, 0], i * 4);
    });
  }

  /** Compact text form for shareable URLs. */
  serialize(): string {
    return this.live()
      .map((f) => [f.hx, f.hz, f.nx, f.nz, f.target, f.radius].map((v) => +v.toFixed(3)).join(','))
      .join(';');
  }

  deserialize(text: string): void {
    for (const part of text.split(';')) {
      const v = part.split(',').map(Number);
      if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) continue;
      this.add(v[0], v[1], v[2], v[3], v[4], v[5]);
    }
  }
}
