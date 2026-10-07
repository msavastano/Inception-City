import * as THREE from 'three';
import { BLOCK, streetHalfWidth } from '../core/config';
import { Fold, foldPoint } from '../core/fold';
import { DreamerBody } from '../world/dreamer';
import { HALL_LENGTH, Hallway } from '../world/hallway';
import { CHASE, boomFollow, clearance } from './chase';
import { DreamContext } from './context';
import { rideSpec } from './ride';

const EYE = 1.65;
const RADIUS = 0.35;
const WALK = 5.5;
const SPRINT = 13;
const WALK_HINT = 'WASD walk · Shift run · Space jump · F fold ahead · V drop it · E ride the fold · H the hallway · C camera · K kick · Esc pause';
const VIEW_KEY = 'inception-view';

/** First person, or the third-person camera behind the dreamer's shoulder. */
export type View = 'first' | 'third';

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'third' ? 'third' : 'first';
  } catch {
    // no storage (private window): first person, as always
    return 'first';
  }
}

/** Turn an angle towards another the short way round. */
function turnTowards(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * Math.min(1, k);
}

/**
 * Dream Walk. The walker lives entirely in flat fabric space: movement,
 * collision and gravity never see a fold. Only the camera is pushed through
 * the fold transform, which is why you can stroll up a curling boulevard and
 * end up walking on the ceiling of the world.
 *
 * The third-person view (C) works the same way: the camera's boom is laid out
 * and collided in fabric space, beside the walker, and only then folded, so it
 * keeps out of buildings and stays on the street's side of a curl however the
 * city is bent. The body is placed through the folds at the walker's feet.
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
  private rideFold: Fold | null = null;
  private jumpQueued = false;
  onPause: (() => void) | null = null;
  fov = 74;
  /** Off while the dreamer is limping (Heist mode). */
  canSprint = true;
  view: View = savedView();
  readonly body = new DreamerBody();
  /** Fabric heading the body faces (it turns to where you walk; the camera looks where you look). */
  private bodyYaw = 0;
  /** How much of the camera's shoulder offset and boom are in use (0 to 1), after walls pulled them in. */
  private sideT = 1;
  private backT = 1;
  /** Switching back to first person: the body stays until the camera has flown into its head. */
  private leavingBody = false;
  private feetW = new THREE.Vector3();
  private headW = new THREE.Vector3();
  private upW = new THREE.Vector3();

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
      this.ctx.hint('Drag to look around. WASD to walk, Shift to run, Space to jump. F folds the street ahead, E rides it, H the hallway, C the camera, K the kick.');
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
    this.ctx.hallway.release();
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
    this.bodyYaw = this.yaw;
    this.active = true;
    this.transition = { p0: this.ctx.camera.position.clone(), q0: this.ctx.camera.quaternion.clone(), t: 0, dur: 1.8 };
    this.ctx.hint(WALK_HINT);
    this.lock();
  }

  /**
   * Put an active dreamer straight down somewhere else (a new dream, under cover
   * of a fade). With swoop, a camera move already under way carries on to the new spot.
   */
  teleport(x: number, z: number, yaw: number, swoop = false): void {
    this.ctx.hallway.release();
    this.rideFold = null;
    const c = this.ctx.streamer.collide(x, z, RADIUS);
    this.x = c.x;
    this.z = c.z;
    this.yaw = yaw;
    this.bodyYaw = yaw;
    this.pitch = 0.08;
    this.h = 0;
    this.vh = 0;
    this.vx = this.vz = 0;
    if (!swoop) this.transition = null;
  }

  /** Knocked back from a fabric point (a projection's blow). */
  shove(fromX: number, fromZ: number): void {
    if (this.ctx.hallway.rider) return;
    const dx = this.x - fromX;
    const dz = this.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    this.vx = (dx / d) * 11;
    this.vz = (dz / d) * 11;
    if (this.h <= 0) this.vh = 3.5;
  }

  exit(): void {
    this.leaveHallway();
    this.active = false;
    this.body.visible = false;
    this.keys.clear();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Switch between first person and the camera behind the dreamer (remembered for next time). */
  toggleView(): View {
    this.view = this.view === 'first' ? 'third' : 'first';
    try {
      localStorage.setItem(VIEW_KEY, this.view);
    } catch {
      // no storage: the choice lasts until the page closes
    }
    this.sideT = this.backT = 1;
    if (!this.transition) this.startTransition(0.45);
    this.leavingBody = this.view === 'first' && !!this.transition;
    return this.view;
  }

  /** Fold the street ahead of the dreamer (up and over with up = true, down into a cliff otherwise). */
  foldAhead(up: boolean): void {
    if (this.inHallway()) return;
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

  /** Fold the street under the dreamer so it carries them up and over the city. Again to come back down. */
  ride(): void {
    if (this.inHallway()) return;
    const folds = this.ctx.folds;
    const f = this.rideFold;
    if (f && !f.removing && folds.folds.includes(f)) {
      folds.remove(f);
      this.rideFold = null;
      this.ctx.hint('The street lowers you back down.');
      return;
    }
    const r = rideSpec(this.x, this.z, this.yaw);
    this.rideFold = folds.add(r.hx, r.hz, r.nx, r.nz, r.target, r.radius, 1.3);
    this.ctx.foldCommitted(0.8);
    this.ctx.hint('Hold on. The street under you is folding up and over the city. Press E to come back down.');
  }

  jump(): void {
    if (this.ctx.hallway.rider) this.jumpQueued = true;
    else if (this.h <= 0) this.vh = 7.5;
  }

  /** Raise the rotating hallway around the dreamer, or let it go. */
  toggleHallway(): void {
    const hall = this.ctx.hallway;
    if (hall.open) {
      this.collapseHallway();
      this.ctx.hint(WALK_HINT);
      return;
    }
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const alongX = Math.abs(fx) > Math.abs(fz);
    const sign = (alongX ? Math.sign(fx) : Math.sign(fz)) || 1;
    // centre it on the street the dreamer is on, starting just behind them
    const cross = alongX ? this.z : this.x;
    const line = Math.round(cross / BLOCK) * BLOCK;
    const centreCross = Math.abs(cross - line) < 14 ? line : cross;
    const centreAlong = (alongX ? this.x : this.z) + sign * (HALL_LENGTH / 2 - 6);
    const cx = alongX ? centreAlong : centreCross;
    const cz = alongX ? centreCross : centreAlong;
    const { axis, across } = Hallway.directions(alongX);
    const [ax, az] = axis;
    const [kx, kz] = across;
    const bz = (this.x - cx) * ax + (this.z - cz) * az;
    const bx = (this.x - cx) * kx + (this.z - cz) * kz;
    hall.spawn(cx, cz, alongX, bz);
    hall.update(0, this.ctx.time, this.ctx.folds.active);
    hall.capture(bx, bz);
    this.vh = 0;
    this.h = 0;
    this.startTransition(0.5);
    this.ctx.foldCommitted(0.5);
    this.ctx.hint('The hallway turns with the dream above, and in here gravity is real. Run along the walls. Walk out of an end, or press H to let it go.');
  }

  /** Let the hallway go, dropping the dreamer back onto the street if they were inside. */
  collapseHallway(): void {
    this.leaveHallway();
    this.ctx.hallway.dismiss();
  }

  private inHallway(): boolean {
    if (!this.ctx.hallway.rider) return false;
    this.ctx.hint('The hallway keeps its own gravity. Walk out of an end to fold the street again.');
    return true;
  }

  /** Step out of the hallway onto the street, wherever the dreamer is. */
  private leaveHallway(): void {
    const r = this.ctx.hallway.release();
    if (!r) return;
    this.x = r.x;
    this.z = r.z;
    this.h = r.h;
    this.vh = r.vh;
    this.vx = r.vx;
    this.vz = r.vz;
    const c = this.ctx.streamer.collide(this.x, this.z, RADIUS);
    this.x = c.x;
    this.z = c.z;
    this.startTransition(0.35);
  }

  private startTransition(dur: number): void {
    if (!this.active) return;
    this.transition = { p0: this.ctx.camera.position.clone(), q0: this.ctx.camera.quaternion.clone(), t: 0, dur };
  }

  /** Where the dreamer's eyes are and how they're oriented, after folding. */
  private pose(outPos: THREE.Vector3, outQ: THREE.Quaternion, pitch: number): void {
    const [bx, by, bz] = this.basis;
    bx.set(1, 0, 0);
    by.set(0, 1, 0);
    bz.set(0, 0, 1);
    this.feetW.set(this.x, this.h, this.z);
    foldPoint(this.ctx.folds.active, this.x, this.z, this.feetW, this.basis);
    outPos.copy(this.feetW).addScaledVector(by, EYE + this.bob);
    // camera looks down its -Z; build its frame in local fabric terms, then map through the fold basis
    const cp = Math.cos(pitch);
    const fl = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(pitch), Math.cos(this.yaw) * cp);
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
    const sprint = this.canSprint && (k.has('ShiftLeft') || k.has('ShiftRight') || (this.touchMove ? Math.hypot(f, s) > 0.95 : false));
    const speed = sprint ? SPRINT : WALK;
    const jump = k.has('Space') || this.jumpQueued;
    this.jumpQueued = false;

    const hall = this.ctx.hallway;
    let grounded: boolean;
    let moving: number;
    if (hall.rider) {
      const out = hall.step(dt, f, s, speed, jump, this.yaw - hall.axisYaw);
      if (hall.landed) {
        hall.landed = false;
        this.ctx.audio.step();
      }
      const fab = hall.riderFabric();
      if (fab) {
        this.x = fab.x;
        this.z = fab.z;
      }
      grounded = !!hall.rider && hall.rider.face >= 0;
      moving = hall.rider ? hall.rider.pace : 0;
      if (out) {
        this.leaveHallway();
        this.ctx.hint(WALK_HINT);
      }
    } else {
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
      grounded = this.h <= 0;
      const accel = grounded ? 10 : 2;
      this.vx += (dx * speed - this.vx) * Math.min(1, dt * accel);
      this.vz += (dz * speed - this.vz) * Math.min(1, dt * accel);
      const c = this.ctx.streamer.collide(this.x + this.vx * dt, this.z + this.vz * dt, RADIUS);
      this.x = c.x;
      this.z = c.z;

      if (grounded && jump) this.vh = 7.5;
      if (this.h > 0 || this.vh > 0) {
        this.vh -= 22 * dt;
        this.h += this.vh * dt;
        if (this.h <= 0) {
          this.h = 0;
          this.vh = 0;
          this.ctx.audio.step();
        }
      }
      moving = Math.hypot(this.vx, this.vz);

      // walking into an open end of the hallway takes you inside
      const into = hall.entering(this.x, this.z, this.vx, this.vz);
      if (into) {
        hall.capture(into.x, into.z);
        this.startTransition(0.6);
        this.ctx.hint('Inside the hallway gravity is real. Run along the walls as it turns. Walk out of an end, or press H to let it go.');
      }
    }

    // the body turns to face the way you walk
    if (Math.hypot(f, s) > 0.1) {
      const want = Math.atan2(Math.sin(this.yaw) * f - Math.cos(this.yaw) * s, Math.cos(this.yaw) * f + Math.sin(this.yaw) * s);
      this.bodyYaw = turnTowards(this.bodyYaw, want, dt * 10);
    }

    if (grounded && moving > 0.5) {
      const before = Math.floor(this.stepPhase / Math.PI);
      this.stepPhase += dt * moving * 1.35;
      if (Math.floor(this.stepPhase / Math.PI) !== before) this.ctx.audio.step();
    }
    this.bob = grounded ? Math.abs(Math.sin(this.stepPhase)) * 0.06 * Math.min(1, moving / WALK) : 0;
    // the world rushes past while a fold carries you
    const carried = this.rideFold && this.ctx.folds.folds.includes(this.rideFold) ? Math.min(1, Math.abs(this.rideFold.vel) * 2.5) : 0;
    this.fov += ((sprint && moving > 7 ? 84 : 74) + carried * 12 - this.fov) * Math.min(1, dt * 4);

    const cam = this.ctx.camera;
    const third = this.view === 'third';
    // from behind, the view tips down a little so the whole body is in the picture
    const pitch = third ? Math.max(-1.5, this.pitch - CHASE.tilt) : this.pitch;
    if (hall.rider) hall.pose(this.yaw - hall.axisYaw, pitch, this.eye, this.targetQ, this.bob);
    else this.pose(this.eye, this.targetQ, pitch);
    // the camera keeps the view's orientation and moves back over the shoulder
    if (third && hall.rider) this.chaseInHallway(dt, pitch);
    else if (third) this.chaseOnStreet(dt, pitch);
    const showBody = third || (this.leavingBody && !!this.transition);
    if (showBody) {
      this.placeBody();
      this.body.animate(dt, {
        speed: moving,
        phase: this.stepPhase,
        grounded,
        lookYaw: Math.atan2(Math.sin(this.yaw - this.bodyYaw), Math.cos(this.yaw - this.bodyYaw)),
        lookPitch: this.pitch,
      });
    }
    if (this.transition) {
      const t = this.transition;
      t.t = Math.min(1, t.t + dt / t.dur);
      const e = t.t < 0.5 ? 4 * t.t * t.t * t.t : 1 - Math.pow(-2 * t.t + 2, 3) / 2;
      cam.position.lerpVectors(t.p0, this.eye, e);
      cam.quaternion.slerpQuaternions(t.q0, this.targetQ, e);
      if (t.t >= 1) {
        this.transition = null;
        this.leavingBody = false;
      }
    } else {
      cam.position.copy(this.eye);
      cam.quaternion.slerp(this.targetQ, Math.min(1, dt * 30));
    }
    // with a wall right behind, the camera ends up in the dreamer's head: hide the body there
    this.body.visible = showBody && cam.position.distanceTo(this.headW) > CHASE.hideWithin;
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Third person on the street. The boom (head, over the right shoulder, then
   * back along the view) is laid out and collided in fabric space next to the
   * walker, and the camera is then folded at its own spot on the sheet, so it
   * stays on the street's side of any curl. Sets this.eye.
   */
  private chaseOnStreet(dt: number, pitch: number): void {
    const [bx, by, bz] = this.basis;
    const cp = Math.cos(pitch);
    const look = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(pitch), Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const up = new THREE.Vector3().crossVectors(right, look);
    const head = new THREE.Vector3(this.x, this.h + CHASE.head, this.z);
    const back = up.multiplyScalar(CHASE.rise).addScaledVector(look, -CHASE.back);
    // looking up, the camera slides along the street towards the feet instead of going under it
    const low = head.y + back.y - CHASE.floor;
    if (low < 0) back.y -= low;
    const streamer = this.ctx.streamer;
    const blocked = (x: number, y: number, z: number) => y < CHASE.floor * 0.5 || streamer.solid(x, z, CHASE.skin);
    const folds = this.ctx.folds.active;
    const rigid = new THREE.Vector3();
    this.boom(dt, head, right, back, blocked, (p, out) => {
      out.copy(p);
      foldPoint(folds, p.x, p.z, out);
      // Where crossing folds cut the sheet, a spot a few metres away can land somewhere else
      // entirely. Carried rigidly with the dreamer's own frame it can't, so use that there.
      rigid.copy(this.feetW).addScaledVector(bx, p.x - this.x).addScaledVector(by, p.y - this.h).addScaledVector(bz, p.z - this.z);
      if (out.distanceToSquared(rigid) > 1.5 * 1.5) out.copy(rigid);
    });
  }

  /** Third person inside the rotating hallway: the same boom, laid out in the corridor's frame and kept inside its walls. */
  private chaseInHallway(dt: number, pitch: number): void {
    const hall = this.ctx.hallway;
    const r = hall.rider!;
    const look = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    hall.viewAxes(this.yaw - hall.axisYaw, pitch, look, right, up);
    // the boom starts from the head (moved off the wall if the dreamer is crouched into a corner)
    const head = hall.clampInside(r.p.clone().addScaledVector(r.up, CHASE.head), CHASE.skin + 0.01);
    const back = up.multiplyScalar(CHASE.rise).addScaledVector(look, -CHASE.back);
    const probe = new THREE.Vector3();
    const blocked = (x: number, y: number, z: number) => !hall.inside(probe.set(x, y, z), CHASE.skin);
    this.boom(dt, head, right, back, blocked, (p, out) => hall.toWorld(p, out));
  }

  /** Stand the body at the walker's feet (folded, or in the hallway) facing bodyYaw, and note where its head is. */
  private placeBody(): void {
    const hall = this.ctx.hallway;
    const r = hall.rider;
    const forward = new THREE.Vector3();
    if (r) {
      const right = new THREE.Vector3();
      hall.viewAxes(this.bodyYaw - hall.axisYaw, 0, forward, right, this.upW);
      forward.transformDirection(hall.basis);
      this.upW.copy(r.up).transformDirection(hall.basis);
      hall.toWorld(r.p, this.feetW);
    } else {
      // pose() has just folded the feet and the frame there
      const [bx, by, bz] = this.basis;
      forward.addScaledVector(bx, Math.sin(this.bodyYaw)).addScaledVector(bz, Math.cos(this.bodyYaw));
      this.upW.copy(by);
    }
    this.body.place(this.feetW, this.upW, forward);
    this.headW.copy(this.feetW).addScaledVector(this.upW, CHASE.head);
  }

  /**
   * Swing the camera out from the head: first sideways to the shoulder (a wall
   * at your side pulls it in behind your head), then back. Points are in the
   * walker's simulation frame; toWorld folds the result into this.eye.
   */
  private boom(
    dt: number,
    head: THREE.Vector3,
    right: THREE.Vector3,
    back: THREE.Vector3,
    blocked: (x: number, y: number, z: number) => boolean,
    toWorld: (p: THREE.Vector3, out: THREE.Vector3) => void,
  ): void {
    const shoulder = head.clone().addScaledVector(right, CHASE.side);
    this.sideT = boomFollow(this.sideT, clearance(head, shoulder, blocked), dt);
    shoulder.copy(head).addScaledVector(right, CHASE.side * this.sideT);
    const end = shoulder.clone().add(back);
    this.backT = boomFollow(this.backT, clearance(shoulder, end, blocked), dt);
    toWorld(shoulder.addScaledVector(back, this.backT), this.eye);
  }

  finishTransition(): void {
    if (this.transition) this.transition.t = 1;
  }

  get transitioning(): boolean {
    return !!this.transition;
  }
}
