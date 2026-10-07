import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { foldPoint, FoldShape } from '../core/fold';

/**
 * THE ROTATING HALLWAY
 *
 * A hotel corridor that appears on a street and turns like a barrel, the way
 * the hallway turns when the van in the dream above is rolling. It is the one
 * place in the city where gravity ignores the fabric: inside, "down" is the
 * real world's down, so as the corridor turns you are carried up the floor,
 * slide when it tilts too far, and end up running along the walls and ceiling.
 *
 * Three frames are involved:
 * - fabric: where the corridor sits on the unfolded sheet (cx, cz, axis),
 * - B: the corridor's own non-spinning frame (x across, y up, z along the axis),
 *   carried rigidly through the folds at its centre,
 * - spin: B turned by the current angle, in which the four walls are fixed.
 * The rider is simulated in B, so world gravity and the moving walls are easy
 * to express, and collided against the walls in spin space.
 */

export const HALL_SIZE = 7;
export const HALL_LENGTH = 64;
export const HALL_HALF = HALL_SIZE / 2;
/** Axis height that lets the corners clear the street while it turns. */
export const HALL_AXIS = HALL_HALF * Math.SQRT2 + 0.6;
const GRAVITY = 22;
/** Grip while standing, and the drag once sliding: you stick until about 31°, then go quickly. */
const FRICTION = 0.6;
const SLIDE_FRICTION = 0.3;
const EYE = 1.6;
const SKIN = 0.05;

/** Inward wall normals in spin space: floor, +x wall, ceiling, -x wall. */
const FACE_N: [number, number][] = [
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 0],
];

export interface Rider {
  /** Position of the rider's feet in B. */
  p: THREE.Vector3;
  /** Velocity in B. */
  v: THREE.Vector3;
  /** The wall being stood on (0 floor, 1 and 3 walls, 2 ceiling), or -1 in the air. */
  face: number;
  /** The rider's sense of up in B, eased towards the wall they stand on. */
  up: THREE.Vector3;
  /** Speed relative to the wall underfoot, for footsteps. */
  pace: number;
}

export interface Release {
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  vh: number;
}

/** The van swerving in the dream above: a turning speed that never quite settles. */
export function hallwaySpin(t: number): number {
  return 0.42 + 0.22 * Math.sin(t * 0.17) + 0.12 * Math.sin(t * 0.43 + 1);
}

function corridorGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const face = (g: THREE.BufferGeometry, id: number) => {
    g.setAttribute('aFace', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(id), 1));
    parts.push(g);
  };
  face(new THREE.PlaneGeometry(HALL_SIZE, HALL_LENGTH).rotateX(-Math.PI / 2).translate(0, -HALL_HALF, 0), 0);
  face(new THREE.PlaneGeometry(HALL_LENGTH, HALL_SIZE).rotateY(-Math.PI / 2).translate(HALL_HALF, 0, 0), 1);
  face(new THREE.PlaneGeometry(HALL_SIZE, HALL_LENGTH).rotateX(Math.PI / 2).translate(0, HALL_HALF, 0), 2);
  face(new THREE.PlaneGeometry(HALL_LENGTH, HALL_SIZE).rotateY(Math.PI / 2).translate(-HALL_HALF, 0, 0), 3);
  const g = mergeGeometries(parts);
  if (!g) throw new Error('hallway geometry merge failed');
  return g;
}

const HALL_GLSL = /* glsl */ `
varying vec3 vHall;
varying float vFace;
uniform float uReveal;
uniform float uRevealZ;
uniform float uHallTime;

float hallHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Paints the corridor: patterned carpet, striped wallpaper with doors and
// sconces, a coffered ceiling with lamps, and weathered stone outside.
vec3 hallPaint(out vec3 glow) {
  const float H = ${HALL_HALF.toFixed(2)};
  vec3 p = vHall;
  glow = vec3(0.0);
  float face = floor(vFace + 0.5);
  float across = (face == 0.0 || face == 2.0) ? p.x : p.y;
  float edge = H - abs(across);

  if (!gl_FrontFacing) {
    vec3 c = vec3(0.43, 0.41, 0.38) * (0.88 + 0.12 * hallHash(floor(vec2(p.z * 0.5, across * 0.5) + face * 7.0)));
    c *= 0.9 + 0.1 * step(0.06, fract(p.z / 4.0));
    glow = vec3(1.0, 0.74, 0.4) * smoothstep(0.22, 0.0, edge) * 1.4;
    return c;
  }

  float lz = (fract(p.z / 8.0 + 0.5) - 0.5) * 8.0;
  vec3 c;
  if (face == 0.0) {
    vec2 d = abs(fract(vec2(p.x, p.z) * 0.6) - 0.5);
    float diamond = step(d.x + d.y, 0.34) - step(d.x + d.y, 0.24);
    c = mix(vec3(0.34, 0.06, 0.05), vec3(0.62, 0.44, 0.17), diamond * 0.75);
    float border = step(H - 0.95, abs(p.x)) * step(abs(p.x), H - 0.55);
    c = mix(c, vec3(0.58, 0.42, 0.16), border);
  } else if (face == 2.0) {
    c = vec3(0.84, 0.81, 0.74);
    float coffer = max(step(fract(p.z / 2.0), 0.05), step(abs(abs(p.x) - 1.6), 0.06));
    c *= 1.0 - 0.18 * coffer;
    float lamp = step(abs(lz), 0.9) * step(abs(p.x), 0.6);
    c = mix(c, vec3(1.0, 0.96, 0.86), lamp);
    glow += vec3(1.0, 0.84, 0.58) * lamp * 2.4;
  } else {
    float u = p.y + H;
    c = vec3(0.71, 0.61, 0.46) * (0.94 + 0.06 * step(0.5, fract(p.z * 1.4)));
    float wains = step(u, 1.1);
    c = mix(c, vec3(0.31, 0.18, 0.1), wains);
    c = mix(c, vec3(0.66, 0.5, 0.24), step(1.1, u) * step(u, 1.22));
    c = mix(c, vec3(0.86, 0.82, 0.74), step(${HALL_SIZE.toFixed(2)} - 0.45, u));
    float dz = (fract((p.z + 4.0) / 8.0) - 0.5) * 8.0;
    float door = step(abs(dz), 0.75) * step(u, 2.9);
    float frame = step(abs(dz), 0.92) * step(u, 3.06) - door;
    c = mix(c, vec3(0.88, 0.83, 0.72), frame);
    c = mix(c, vec3(0.24, 0.12, 0.07) * (0.9 + 0.1 * step(0.5, fract(u * 2.0))), door);
    float knob = exp(-((dz - 0.5) * (dz - 0.5) + (u - 1.05) * (u - 1.05)) * 500.0);
    glow += vec3(1.0, 0.75, 0.35) * knob * 1.5;
    float sconce = exp(-(lz * lz + (u - 2.7) * (u - 2.7) * 2.0) * 9.0);
    float flicker = 0.92 + 0.08 * sin(uHallTime * 23.0 + p.z);
    glow += vec3(1.0, 0.72, 0.4) * sconce * 2.6 * flicker;
  }
  // light pools under the lamps, and soft shadow where walls meet
  float pool = exp(-lz * lz * 0.1);
  c *= 0.62 + 0.38 * smoothstep(0.0, 1.3, edge);
  glow += c * (0.16 + 0.26 * pool);
  return c;
}
`;

function corridorMaterial(uniforms: Record<string, THREE.IUniform>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFace;\nvarying vec3 vHall;\nvarying float vFace;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHall = position;\nvFace = aFace;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${HALL_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (abs(vHall.z - uRevealZ) > uReveal) discard;
        vec3 hallGlow;
        vec3 hallCol = hallPaint(hallGlow);
        diffuseColor.rgb = hallCol * (gl_FrontFacing ? 0.55 : 1.0);`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += hallGlow;');
  };
  m.customProgramCacheKey = () => 'hallway';
  return m;
}

export class Hallway {
  readonly mesh: THREE.Mesh;
  active = false;
  cx = 0;
  cz = 0;
  /** The corridor runs along fabric x (true) or fabric z (false). */
  alongX = false;
  angle = 0;
  spin = 0;
  rider: Rider | null = null;
  readonly origin = new THREE.Vector3();
  /** B → world rotation (columns: across, up, along). */
  readonly basis = new THREE.Matrix4();
  private age = 0;
  private closing = false;
  private rise = 1;
  private readonly uniforms = {
    uReveal: { value: 0 },
    uRevealZ: { value: 0 },
    uHallTime: { value: 0 },
  };
  private readonly gB = new THREE.Vector3(0, -GRAVITY, 0);
  private readonly bx = new THREE.Vector3();
  private readonly by = new THREE.Vector3();
  private readonly bz = new THREE.Vector3();
  private readonly spinM = new THREE.Matrix4();

  constructor() {
    this.mesh = new THREE.Mesh(corridorGeometry(), corridorMaterial(this.uniforms));
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Axis and across directions in fabric (x, z) for a corridor along x or z. Across is up × axis. */
  static directions(alongX: boolean): { axis: [number, number]; across: [number, number] } {
    return alongX ? { axis: [1, 0], across: [0, -1] } : { axis: [0, 1], across: [1, 0] };
  }

  get axis(): [number, number] {
    return Hallway.directions(this.alongX).axis;
  }

  get across(): [number, number] {
    return Hallway.directions(this.alongX).across;
  }

  /** Standing in the world and not folding away. */
  get open(): boolean {
    return this.active && !this.closing;
  }

  /** Heading offset between fabric yaw and yaw measured from the corridor axis. */
  get axisYaw(): number {
    return this.alongX ? Math.PI / 2 : 0;
  }

  /** Build the corridor on the street at (cx, cz). It unrolls outwards from revealFrom (along the axis). */
  spawn(cx: number, cz: number, alongX: boolean, revealFrom = 0, rise = true): void {
    this.cx = cx;
    this.cz = cz;
    this.alongX = alongX;
    this.active = true;
    this.closing = false;
    this.age = 0;
    this.angle = 0;
    this.spin = 0;
    this.rise = rise ? 0 : 1;
    this.rider = null;
    this.uniforms.uReveal.value = 0;
    this.uniforms.uRevealZ.value = revealFrom;
    this.mesh.visible = true;
  }

  /** Fold the corridor away. Anyone inside drops back onto the street (see release()). */
  dismiss(): void {
    if (!this.active) return;
    this.closing = true;
    this.uniforms.uRevealZ.value = this.rider ? this.rider.p.z : 0;
    this.uniforms.uReveal.value = Math.min(this.uniforms.uReveal.value, HALL_LENGTH * 0.6);
  }

  /** Finish the opening animation now (screenshots and tests). */
  settle(): void {
    if (!this.active) return;
    this.rise = 1;
    this.age = Math.max(this.age, 4);
    this.uniforms.uReveal.value = HALL_LENGTH;
  }

  /** Put a rider inside at (x across, z along), standing on whichever wall is lowest. */
  capture(x: number, z: number): Rider {
    const face = this.lowestFace();
    const [nx, ny] = FACE_N[face];
    const lim = HALL_HALF - SKIN;
    // spin-space point on that wall, offset along it by x where the wall allows
    const sx = nx !== 0 ? -nx * lim : THREE.MathUtils.clamp(x, -lim + 0.4, lim - 0.4);
    const sy = ny !== 0 ? -ny * lim : THREE.MathUtils.clamp(x, -lim + 0.4, lim - 0.4);
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const p = new THREE.Vector3(c * sx - s * sy, s * sx + c * sy, THREE.MathUtils.clamp(z, -HALL_LENGTH / 2 + 0.5, HALL_LENGTH / 2 - 0.5));
    const up = this.faceNormal(face, new THREE.Vector3());
    this.rider = { p, v: new THREE.Vector3(), face, up, pace: 0 };
    return this.rider;
  }

  /** Take the rider out and say where they are on the street. */
  release(): Release | null {
    const r = this.rider;
    if (!r) return null;
    this.rider = null;
    const [ax, az] = this.axis;
    const [cx, cz] = this.across;
    return {
      x: this.cx + ax * r.p.z + cx * r.p.x,
      z: this.cz + az * r.p.z + cz * r.p.x,
      h: Math.max(0, this.axisHeight() + r.p.y),
      vx: ax * r.v.z + cx * r.v.x,
      vz: az * r.v.z + cz * r.v.x,
      vh: r.v.y,
    };
  }

  /** Fabric position of the rider, for streaming and the crowd. */
  riderFabric(): { x: number; z: number } | null {
    const r = this.rider;
    if (!r) return null;
    const [ax, az] = this.axis;
    const [cx, cz] = this.across;
    return { x: this.cx + ax * r.p.z + cx * r.p.x, z: this.cz + az * r.p.z + cz * r.p.x };
  }

  /**
   * Would a walker at fabric (x, z), h metres up and moving (vx, vz), step into
   * an open end? Returns their (across, along) position in B if so.
   */
  entering(x: number, z: number, vx: number, vz: number): { x: number; z: number } | null {
    if (!this.active || this.closing || this.rider || this.rise < 1) return null;
    const [ax, az] = this.axis;
    const [cx, cz] = this.across;
    const along = (x - this.cx) * ax + (z - this.cz) * az;
    const side = (x - this.cx) * cx + (z - this.cz) * cz;
    const inward = -Math.sign(along) * (vx * ax + vz * az);
    const end = Math.abs(along) - HALL_LENGTH / 2;
    if (end > 1.2 || end < -2 || Math.abs(side) > HALL_HALF + 1 || inward < 0.5) return null;
    return { x: side, z: Math.sign(along) * (HALL_LENGTH / 2 - 1) };
  }

  axisHeight(): number {
    const e = this.rise * this.rise * (3 - 2 * this.rise);
    return THREE.MathUtils.lerp(HALL_HALF, HALL_AXIS, e);
  }

  update(dt: number, time: number, folds: readonly FoldShape[]): void {
    if (!this.active) return;
    this.age += dt;
    this.uniforms.uHallTime.value = time;
    const u = this.uniforms;
    if (this.closing) {
      u.uReveal.value -= dt * HALL_LENGTH * 0.9;
      this.spin *= Math.exp(-dt * 3);
      if (u.uReveal.value <= 0) {
        this.active = false;
        this.mesh.visible = false;
        this.rider = null;
        return;
      }
    } else {
      u.uReveal.value = Math.min(HALL_LENGTH, u.uReveal.value + dt * HALL_LENGTH * 0.75);
      this.rise = Math.min(1, this.rise + dt / 1.4);
      const ramp = THREE.MathUtils.smoothstep(this.age, 1.6, 4.5);
      this.spin += (hallwaySpin(time) * ramp - this.spin) * Math.min(1, dt * 0.8);
    }
    this.angle += this.spin * dt;

    // Carry the corridor rigidly through the folds at its centre.
    this.bx.set(1, 0, 0);
    this.by.set(0, 1, 0);
    this.bz.set(0, 0, 1);
    this.origin.set(this.cx, this.axisHeight(), this.cz);
    foldPoint(folds, this.cx, this.cz, this.origin, [this.bx, this.by, this.bz]);
    const along = this.alongX ? this.bx : this.bz;
    const across = new THREE.Vector3().crossVectors(this.by, along);
    this.basis.makeBasis(across, this.by, along);
    // world gravity seen from B (B is a pure rotation, so its transpose is its inverse)
    this.gB.set(across.y, this.by.y, along.y).multiplyScalar(-GRAVITY);

    this.spinM.makeRotationZ(this.angle);
    this.mesh.matrix.copy(this.basis).multiply(this.spinM).setPosition(this.origin);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  /** Spin-space normal of a wall, turned into B. */
  private faceNormal(face: number, out: THREE.Vector3): THREE.Vector3 {
    const [nx, ny] = FACE_N[face];
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return out.set(c * nx - s * ny, s * nx + c * ny, 0);
  }

  /** The wall gravity presses into hardest right now. */
  lowestFace(): number {
    let best = 0;
    let bestDot = Infinity;
    const n = new THREE.Vector3();
    for (let f = 0; f < 4; f++) {
      const d = this.faceNormal(f, n).dot(this.gB);
      if (d < bestDot) {
        bestDot = d;
        best = f;
      }
    }
    return best;
  }

  /**
   * Advance the rider. f and s are forward and strafe input (-1..1), yaw is
   * measured from the corridor axis. Returns true when the rider has left
   * through an open end.
   */
  step(dt: number, f: number, s: number, speed: number, jump: boolean, yaw: number): boolean {
    const r = this.rider;
    if (!r) return false;
    const g = this.gB;
    const N = new THREE.Vector3();
    const dPhi = this.spin * dt;

    // walking direction, laid on the wall underfoot
    const U = r.up;
    const F0 = new THREE.Vector3(0, 0, 1).addScaledVector(U, -U.z);
    if (F0.lengthSq() < 1e-6) F0.set(0, 0, 1);
    F0.normalize();
    const X0 = new THREE.Vector3().crossVectors(U, F0);
    const fw = new THREE.Vector3().addScaledVector(X0, Math.sin(yaw)).addScaledVector(F0, Math.cos(yaw));
    const rt = new THREE.Vector3().addScaledVector(X0, -Math.cos(yaw)).addScaledVector(F0, Math.sin(yaw));
    const want = new THREE.Vector3().addScaledVector(fw, f).addScaledVector(rt, s);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(speed);

    if (r.face >= 0) {
      this.faceNormal(r.face, N);
      want.addScaledVector(N, -want.dot(N));
      const gn = g.dot(N);
      const vWall = new THREE.Vector3(-this.spin * r.p.y, this.spin * r.p.x, 0);
      const rel = r.v.clone().sub(vWall);
      rel.addScaledVector(N, -rel.dot(N));
      const gt = g.clone().addScaledVector(N, -gn);
      const grip = FRICTION * Math.max(0, -gn);
      if (gt.length() <= grip) {
        // standing: the wall carries you, your legs do the rest
        rel.lerp(want, Math.min(1, dt * 10));
      } else {
        // too steep: slide, with a little say in where
        rel.addScaledVector(gt, (1 - (SLIDE_FRICTION / FRICTION) * (grip / gt.length())) * dt);
        rel.addScaledVector(want, dt * 0.8);
      }
      r.pace = rel.length();
      // the wall carries the rider round exactly; their own motion is added on top
      const c = Math.cos(dPhi);
      const sn = Math.sin(dPhi);
      const px = r.p.x;
      r.p.x = c * px - sn * r.p.y;
      r.p.y = sn * px + c * r.p.y;
      r.p.addScaledVector(rel, dt);
      r.v.copy(vWall).add(rel);
      if (jump || gn > -1) {
        // jumped, or the wall has turned to face away from the ground
        if (jump) r.v.addScaledVector(N, 7.5);
        r.face = -1;
      }
    } else {
      r.pace = 0;
      r.v.addScaledVector(g, dt);
      const lateral = want.clone().addScaledVector(g, -want.dot(g) / g.lengthSq());
      r.v.addScaledVector(lateral, dt * 0.8);
      r.p.addScaledVector(r.v, dt);
    }

    // collide with the walls in spin space
    const c = Math.cos(this.angle);
    const sn = Math.sin(this.angle);
    let sx = c * r.p.x + sn * r.p.y;
    let sy = -sn * r.p.x + c * r.p.y;
    const lim = HALL_HALF - SKIN;
    const hit: number[] = [];
    if (sy < -lim) (sy = -lim), hit.push(0);
    if (sx > lim) (sx = lim), hit.push(1);
    if (sy > lim) (sy = lim), hit.push(2);
    if (sx < -lim) (sx = -lim), hit.push(3);
    if (hit.length) {
      r.p.x = c * sx - sn * sy;
      r.p.y = sn * sx + c * sy;
      let face = hit[0];
      let best = Infinity;
      for (const h of hit) {
        const d = this.faceNormal(h, N).dot(g);
        if (d < best) (best = d), (face = h);
      }
      const vWall = new THREE.Vector3(-this.spin * r.p.y, this.spin * r.p.x, 0);
      for (const h of hit) {
        this.faceNormal(h, N);
        const into = r.v.clone().sub(vWall).dot(N);
        if (into < 0) r.v.addScaledVector(N, -into);
      }
      if (best < -1) {
        if (r.face < 0 && r.v.clone().sub(vWall).length() > 2) this.landed = true;
        r.face = face;
      }
    }

    // ease the sense of up towards the wall underfoot (or away from gravity mid-air)
    const target = r.face >= 0 ? this.faceNormal(r.face, N) : g.clone().negate().normalize();
    r.up.lerp(target, Math.min(1, dt * 6)).normalize();

    return Math.abs(r.p.z) > HALL_LENGTH / 2 + 0.3;
  }

  /** Set by step() when the rider lands hard; the walker plays a footstep and clears it. */
  landed = false;

  /** Eye position (world) and camera orientation for a rider looking at yaw/pitch from the axis. */
  pose(yaw: number, pitch: number, outPos: THREE.Vector3, outQ: THREE.Quaternion, bob = 0): void {
    const r = this.rider;
    if (!r) return;
    // keep the eye inside the walls
    const eye = this.clampInside(r.p.clone().addScaledVector(r.up, EYE + bob), 0.25);
    this.toWorld(eye, outPos);

    const look = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.viewAxes(yaw, pitch, look, right, up);
    for (const v of [look, right, up]) v.transformDirection(this.basis);
    outQ.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, look.negate()));
  }

  /**
   * The rider's view in B for a heading (yaw, from the axis) and pitch: the
   * way they look, their right and their up. With pitch 0, look is the way
   * they face along the wall underfoot.
   */
  viewAxes(yaw: number, pitch: number, look: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): void {
    const U = this.rider ? this.rider.up : new THREE.Vector3(0, 1, 0);
    const F0 = new THREE.Vector3(0, 0, 1).addScaledVector(U, -U.z);
    if (F0.lengthSq() < 1e-6) F0.set(0, 0, 1);
    F0.normalize();
    const X0 = new THREE.Vector3().crossVectors(U, F0);
    const cp = Math.cos(pitch);
    look
      .set(0, 0, 0)
      .addScaledVector(X0, Math.sin(yaw) * cp)
      .addScaledVector(F0, Math.cos(yaw) * cp)
      .addScaledVector(U, Math.sin(pitch));
    right.crossVectors(look, U).normalize();
    up.crossVectors(right, look).normalize();
  }

  /** Move a point in B (in place) to at least `margin` inside the corridor's walls. */
  clampInside(p: THREE.Vector3, margin: number): THREE.Vector3 {
    const lim = HALL_HALF - margin;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const sx = THREE.MathUtils.clamp(c * p.x + s * p.y, -lim, lim);
    const sy = THREE.MathUtils.clamp(-s * p.x + c * p.y, -lim, lim);
    p.x = c * sx - s * sy;
    p.y = s * sx + c * sy;
    return p;
  }

  /** Is a point in B inside the corridor's walls, at least `margin` from all four? (The ends are open.) */
  inside(p: THREE.Vector3, margin: number): boolean {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const lim = HALL_HALF - margin;
    return Math.abs(c * p.x + s * p.y) <= lim && Math.abs(-s * p.x + c * p.y) <= lim;
  }

  /** A point in B, in the world. */
  toWorld(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).applyMatrix4(this.basis).add(this.origin);
  }
}
