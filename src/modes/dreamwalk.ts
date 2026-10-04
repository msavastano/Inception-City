import * as THREE from 'three';
import { BLOCK, streetHalfWidth } from '../core/config';
import { foldPoint } from '../core/fold';
import { DreamContext } from './context';

const EYE = 1.65;
const RADIUS = 0.35;
const WALK = 5.5;
const SPRINT = 13;

/**
 * First person. The walker lives entirely in flat fabric space: movement,
 * collision and gravity never see a fold. Only the camera is pushed through
 * the fold transform, which is why you can stroll up a curling boulevard and
 * end up walking on the ceiling of the world.
 */
export class DreamWalk {
  active = false;
  x = 0;
  z = 0;
  h = 0;
  vh = 0;
  vx = 0;
  vz = 0;
  yaw = 0;
  pitch = 0;
  locked = false;
  private keys = new Set<string>();
  private stepPhase = 0;
  private bob = 0;
  private transition: { p0: THREE.Vector3; q0: THREE.Quaternion; t: number; dur: number } | null = null;
  private dragLook = false;
  private dragging: number | null = null;
  private lastPointer = { x: 0, y: 0 };
  private touchMove: { id: number; ox: number; oy: number; dx: number; dy: number } | null = null;
  private touchLook: { id: number; x: number; y: number } | null = null;
  private eye = new THREE.Vector3();
  private basis = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private targetQ = new THREE.Quaternion();
  private m = new THREE.Matrix4();
  onPause: (() => void) | null = null;
  fov = 74;

  constructor(private ctx: DreamContext) {
    window.addEventListener('keydown', (e) => {
      if (!this.active || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === ctx.canvas;
      if (was && !this.locked && this.active) this.onPause?.();
    });
    document.addEventListener('pointerlockerror', () => {
      this.dragLook = true;
      this.ctx.hint('Drag to look around. WASD to walk, Shift to run, Space to jump. F folds the street ahead, K is the kick.');
    });
    document.addEventListener('mousemove', (e) => {
      if (this.active && this.locked) this.look(e.movementX, e.movementY);
    });
    const el = ctx.canvas;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      if (e.pointerType === 'touch') return;
      if (!this.locked && !this.dragLook) this.lock();
      else if (this.dragLook) {
        this.dragging = e.pointerId;
        this.lastPointer = { x: e.clientX, y: e.clientY };
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.active || this.dragging !== e.pointerId) return;
      this.look(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y);
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', () => (this.dragging = null));

    // Touch: left half is a virtual stick, right half looks around.
    el.addEventListener('touchstart', (e) => this.onTouch(e, 'start'), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouch(e, 'move'), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouch(e, 'end'));
    el.addEventListener('touchcancel', (e) => this.onTouch(e, 'end'));
  }

  private onTouch(e: TouchEvent, phase: 'start' | 'move' | 'end'): void {
    if (!this.active) return;
    if (phase !== 'end') e.preventDefault();
    const w = window.innerWidth;
    for (const t of Array.from(e.changedTouches)) {
      if (phase === 'start') {
        if (t.clientX < w / 2 && !this.touchMove) this.touchMove = { id: t.identifier, ox: t.clientX, oy: t.clientY, dx: 0, dy: 0 };
        else if (!this.touchLook) this.touchLook = { id: t.identifier, x: t.clientX, y: t.clientY };
      } else if (phase === 'move') {
        if (this.touchMove?.id === t.identifier) {
          this.touchMove.dx = THREE.MathUtils.clamp((t.clientX - this.touchMove.ox) / 60, -1, 1);
          this.touchMove.dy = THREE.MathUtils.clamp((t.clientY - this.touchMove.oy) / 60, -1, 1);
        } else if (this.touchLook?.id === t.identifier) {
          this.look((t.clientX - this.touchLook.x) * 1.6, (t.clientY - this.touchLook.y) * 1.6);
          this.touchLook.x = t.clientX;
          this.touchLook.y = t.clientY;
        }
      } else {
        if (this.touchMove?.id === t.identifier) this.touchMove = null;
        if (this.touchLook?.id === t.identifier) this.touchLook = null;
      }
    }
  }

  lock(): void {
    if (this.dragLook) return;
    try {
      const p = this.ctx.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => (this.dragLook = true));
    } catch {
      this.dragLook = true;
    }
  }

  private look(dx: number, dy: number): void {
    this.yaw -= dx * 0.0022;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0022, -1.45, 1.45);
  }

  /** Put the dreamer on the nearest sidewalk to a fabric point, facing along the street. */
  enter(fx: number, fz: number): void {
    const lx = Math.round(fx / BLOCK);
    const lz = Math.round(fz / BLOCK);
    const dx = Math.abs(fx - lx * BLOCK);
    const dz = Math.abs(fz - lz * BLOCK);
    if (dx < dz) {
      const side = fx >= lx * BLOCK ? 1 : -1;
      this.x = lx * BLOCK + side * (streetHalfWidth(lx) - 1.8);
      this.z = fz;
      this.yaw = 0;
    } else {
      const side = fz >= lz * BLOCK ? 1 : -1;
      this.z = lz * BLOCK + side * (streetHalfWidth(lz) - 1.8);
      this.x = fx;
      this.yaw = Math.PI / 2;
    }
    const c = this.ctx.streamer.collide(this.x, this.z, RADIUS);
    this.x = c.x;
    this.z = c.z;
    this.h = 0;
    this.vh = 0;
    this.vx = this.vz = 0;
    this.pitch = 0.08;
    this.active = true;
    this.transition = { p0: this.ctx.camera.position.clone(), q0: this.ctx.camera.quaternion.clone(), t: 0, dur: 1.8 };
    this.ctx.hint('WASD to walk · Shift to run · Space to jump · F fold the street ahead · V drop it away · K the kick · Esc to pause');
    this.lock();
  }

  exit(): void {
    this.active = false;
    this.keys.clear();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Fold the street ahead of the dreamer (up and over with up = true, down into a cliff otherwise). */
  foldAhead(up: boolean): void {
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const alongX = Math.abs(fx) > Math.abs(fz);
    const nx = alongX ? Math.sign(fx) : 0;
    const nz = alongX ? 0 : Math.sign(fz);
    const ahead = 36;
    const coord = alongX ? this.x + nx * ahead : this.z + nz * ahead;
    const line = (alongX ? nx : nz) > 0 ? Math.ceil(coord / BLOCK) : Math.floor(coord / BLOCK);
    const hx = alongX ? line * BLOCK : this.x;
    const hz = alongX ? this.z : line * BLOCK;
    this.ctx.folds.add(hx, hz, nx, nz, up ? Math.PI : -Math.PI * 0.55, up ? 85 : 40, 2.6);
    this.ctx.foldCommitted(up ? 1 : 0.6);
  }

  /** Where the dreamer's eyes are and how they're oriented, after folding. */
  private pose(outPos: THREE.Vector3, outQ: THREE.Quaternion): void {
    const [bx, by, bz] = this.basis;
    bx.set(1, 0, 0);
    by.set(0, 1, 0);
    bz.set(0, 0, 1);
    outPos.set(this.x, this.h + EYE + this.bob, this.z);
    foldPoint(this.ctx.folds.active, this.x, this.z, outPos, this.basis);
    // camera looks down its -Z; build its frame in local fabric terms, then map through the fold basis
    const cp = Math.cos(this.pitch);
    const fl = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const fw = new THREE.Vector3().addScaledVector(bx, fl.x).addScaledVector(by, fl.y).addScaledVector(bz, fl.z).normalize();
    const right = new THREE.Vector3().crossVectors(fw, by).normalize();
    const up = new THREE.Vector3().crossVectors(right, fw).normalize();
    this.m.makeBasis(right, up, fw.clone().negate());
    outQ.setFromRotationMatrix(this.m);
  }

  update(dt: number): void {
    if (!this.active) return;
    const k = this.keys;
    let f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (this.touchMove) {
      f = -this.touchMove.dy;
      s = this.touchMove.dx;
    }
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight') || (this.touchMove ? Math.hypot(f, s) > 0.95 : false);
    const speed = sprint ? SPRINT : WALK;
    const fwx = Math.sin(this.yaw);
    const fwz = Math.cos(this.yaw);
    const rx = -Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    let dx = fwx * f + rx * s;
    let dz = fwz * f + rz * s;
    const dl = Math.hypot(dx, dz);
    if (dl > 1) {
      dx /= dl;
      dz /= dl;
    }
    const grounded = this.h <= 0;
    const accel = grounded ? 10 : 2;
    this.vx += (dx * speed - this.vx) * Math.min(1, dt * accel);
    this.vz += (dz * speed - this.vz) * Math.min(1, dt * accel);
    const c = this.ctx.streamer.collide(this.x + this.vx * dt, this.z + this.vz * dt, RADIUS);
    this.x = c.x;
    this.z = c.z;

    if (grounded && k.has('Space')) this.vh = 7.5;
    if (this.h > 0 || this.vh > 0) {
      this.vh -= 22 * dt;
      this.h += this.vh * dt;
      if (this.h <= 0) {
        this.h = 0;
        this.vh = 0;
        this.ctx.audio.step();
      }
    }

    const moving = Math.hypot(this.vx, this.vz);
    if (grounded && moving > 0.5) {
      const before = Math.floor(this.stepPhase / Math.PI);
      this.stepPhase += dt * moving * 1.35;
      if (Math.floor(this.stepPhase / Math.PI) !== before) this.ctx.audio.step();
    }
    this.bob = grounded ? Math.abs(Math.sin(this.stepPhase)) * 0.06 * Math.min(1, moving / WALK) : 0;
    this.fov += ((sprint && moving > 7 ? 84 : 74) - this.fov) * Math.min(1, dt * 4);

    const cam = this.ctx.camera;
    this.pose(this.eye, this.targetQ);
    if (this.transition) {
      const t = this.transition;
      t.t = Math.min(1, t.t + dt / t.dur);
      const e = t.t < 0.5 ? 4 * t.t * t.t * t.t : 1 - Math.pow(-2 * t.t + 2, 3) / 2;
      cam.position.lerpVectors(t.p0, this.eye, e);
      cam.quaternion.slerpQuaternions(t.q0, this.targetQ, e);
      if (t.t >= 1) this.transition = null;
    } else {
      cam.position.copy(this.eye);
      cam.quaternion.slerp(this.targetQ, Math.min(1, dt * 30));
    }
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  finishTransition(): void {
    if (this.transition) this.transition.t = 1;
  }

  get transitioning(): boolean {
    return !!this.transition;
  }
}
