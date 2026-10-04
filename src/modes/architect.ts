import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BLOCK } from '../core/config';
import { Fold, foldPoint } from '../core/fold';
import { U } from '../city/materials';
import { DreamContext } from './context';

export type Tool = 'orbit' | 'fold' | 'raise';

interface FoldDrag {
  fold: Fold;
  hit: { x: number; z: number };
  origin: THREE.Vector3;
  plane: THREE.Plane;
  ax: THREE.Vector3;
  az: THREE.Vector3;
  pointerId: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * God's-eye mode. Orbit the city, drag across it to fold it, brush buildings
 * taller or shorter. Picking reads fabric coordinates off the GPU, so you can
 * fold a district that is already hanging upside down above you.
 */
export class ArchitectMode {
  readonly controls: OrbitControls;
  tool: Tool = 'fold';
  active = false;
  private drag: FoldDrag | null = null;
  private brushing = false;
  private pointer = { x: 0, y: 0, inside: false, shift: false };
  private lastHover = 0;
  private flight: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; t: number; dur: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(private ctx: DreamContext) {
    this.controls = new OrbitControls(ctx.camera, ctx.canvas);
    const c = this.controls;
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = 12;
    c.maxDistance = 1800;
    c.maxPolarAngle = Math.PI - 0.02;
    c.zoomToCursor = true;
    c.screenSpacePanning = false;
    c.enabled = false;
    this.applyButtons();

    const el = ctx.canvas;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => (this.pointer.inside = false));
    el.addEventListener('dblclick', (e) => this.onDouble(e));
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.applyButtons();
    U.uBrush.value.w = 0;
    this.ctx.hint(
      tool === 'fold'
        ? 'Drag across the city to fold it: the side you pull toward lifts. Shift-drag folds downward. Right-drag orbits.'
        : tool === 'raise'
          ? 'Hold and drag over buildings to raise them. Shift to sink. Right-drag orbits.'
          : 'Drag to orbit, right-drag to pan, scroll to zoom. Double-click to fly somewhere.',
    );
  }

  private applyButtons(): void {
    const c = this.controls;
    if (this.tool === 'orbit') {
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: -1 as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

  enter(): void {
    this.active = true;
    this.controls.enabled = true;
    this.setTool(this.tool);
  }

  exit(): void {
    this.active = false;
    this.controls.enabled = false;
    this.cancelDrag();
    U.uBrush.value.w = 0;
  }

  flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 2.2): void {
    this.flight = { p0: this.ctx.camera.position.clone(), t0: this.controls.target.clone(), p1: pos.clone(), t1: target.clone(), t: 0, dur };
  }

  finishFlight(): void {
    if (!this.flight) return;
    this.ctx.camera.position.copy(this.flight.p1);
    this.controls.target.copy(this.flight.t1);
    this.flight = null;
    this.controls.update();
  }

  get flying(): boolean {
    return !!this.flight;
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0 || this.tool === 'orbit') return;
    this.flight = null;
    const hit = this.ctx.picker.pick(this.ctx.camera, e.clientX, e.clientY);
    if (this.tool === 'raise') {
      this.brushing = true;
      this.ctx.canvas.setPointerCapture(e.pointerId);
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.shift = e.shiftKey;
      return;
    }
    if (!hit) return;
    // The local tangent frame at the grabbed point, so drags make sense on folded flaps too.
    const origin = new THREE.Vector3(hit.x, 0, hit.z);
    const basis = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    foldPoint(this.ctx.folds.active, hit.x, hit.z, origin, basis);
    const fold = this.ctx.folds.add(hit.x, hit.z, 0, 1, 0, 90, 13);
    this.drag = {
      fold,
      hit: { x: hit.x, z: hit.z },
      origin,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(basis[1], origin),
      ax: basis[0],
      az: basis[2],
      pointerId: e.pointerId,
    };
    this.ctx.canvas.setPointerCapture(e.pointerId);
    U.uCreaseOn.value = 0;
  }

  private onMove(e: PointerEvent): void {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.inside = true;
    this.pointer.shift = e.shiftKey;
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(d.plane, p)) return;
    p.sub(d.origin);
    let fx = p.dot(d.ax);
    let fz = p.dot(d.az);
    const len = Math.hypot(fx, fz);
    if (len < 4) {
      d.fold.target = 0;
      U.uCreaseOn.value = 0;
      return;
    }
    fx /= len;
    fz /= len;
    let hx = d.hit.x;
    let hz = d.hit.z;
    if (this.ctx.snap) {
      const ang = Math.atan2(fz, fx);
      const snapped = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(ang - snapped) < THREE.MathUtils.degToRad(24)) {
        fx = Math.round(Math.cos(snapped));
        fz = Math.round(Math.sin(snapped));
        // hinges snap to street centrelines, so creases run down the middle of a street
        if (fx !== 0) hx = Math.round(hx / BLOCK) * BLOCK;
        else hz = Math.round(hz / BLOCK) * BLOCK;
      }
    }
    const f = d.fold;
    f.hx = hx;
    f.hz = hz;
    f.nx = fx;
    f.nz = fz;
    const sign = e.shiftKey ? -1 : 1;
    f.target = sign * Math.min(1, (len - 4) / 130) * Math.PI;
    f.radius = 60 + Math.min(80, len * 0.25);
    U.uCrease.value.set(hx, hz, fx, fz);
    U.uCreaseOn.value = 1;
  }

  private onUp(e: PointerEvent): void {
    if (this.brushing) {
      this.brushing = false;
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    U.uCreaseOn.value = 0;
    if (Math.abs(d.fold.target) < 0.12) {
      this.ctx.folds.remove(d.fold);
      return;
    }
    d.fold.stiffness = 6;
    this.ctx.foldCommitted(Math.abs(d.fold.target) / Math.PI);
  }

  private cancelDrag(): void {
    if (this.drag) {
      this.ctx.folds.remove(this.drag.fold);
      this.drag = null;
    }
    this.brushing = false;
    U.uCreaseOn.value = 0;
  }

  private onDouble(e: MouseEvent): void {
    if (!this.active) return;
    const hit = this.ctx.picker.pick(this.ctx.camera, e.clientX, e.clientY);
    if (!hit) return;
    const p = new THREE.Vector3(hit.x, hit.h, hit.z);
    foldPoint(this.ctx.folds.active, hit.x, hit.z, p);
    const dir = this.ctx.camera.position.clone().sub(this.controls.target);
    const dist = Math.min(dir.length(), 260);
    this.flyTo(p.clone().add(dir.setLength(dist)), p, 1.4);
  }

  update(dt: number): void {
    if (!this.active) return;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = ease(f.t);
      this.ctx.camera.position.lerpVectors(f.p0, f.p1, k);
      this.controls.target.lerpVectors(f.t0, f.t1, k);
      if (f.t >= 1) this.flight = null;
    }
    this.controls.update(dt);

    if (this.tool === 'raise' && this.pointer.inside) {
      const now = performance.now();
      if (this.brushing || now - this.lastHover > 60) {
        this.lastHover = now;
        const hit = this.ctx.picker.pick(this.ctx.camera, this.pointer.x, this.pointer.y);
        if (hit) {
          U.uBrush.value.set(hit.x, hit.z, 34, 1);
          if (this.brushing) this.ctx.streamer.brush(hit.x, hit.z, 34, (this.pointer.shift ? -1.4 : 1.6) * dt);
        } else U.uBrush.value.w = 0;
      }
    }
  }

  /** Approximate fabric position of what the camera is looking at (streaming focus). */
  focus(): { x: number; z: number } {
    return { x: this.controls.target.x, z: this.controls.target.z };
  }
}
