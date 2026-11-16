import * as THREE from 'three';
import { Figure } from '../people/figure';
import { blendPose, bone, clip, ClipName, GAIT_CLIPS, gaitWeights, newPose, samplePose, strideAt, turnInBody } from '../people/rig';

/** How the dreamer is moving this frame, as the body animation sees it. */
export interface Gait {
  /** Ground speed, m/s. */
  speed: number;
  /** Stride phase: a footfall every π (the walker's footstep clock, see stridePhaseRate). The left foot lands at 0. */
  phase: number;
  /** Feet on the ground (or on a hallway wall). */
  grounded: boolean;
  /** Where the dreamer is looking, relative to where the body faces (radians, positive to the left), and how far up. */
  lookYaw: number;
  lookPitch: number;
}

/**
 * How fast the stride phase turns at a ground speed (radians a second, π a
 * step): a stride covers the ground the legs were animated to cover, so the
 * feet stay where they land and the footsteps are heard as they do.
 */
export function stridePhaseRate(speed: number): number {
  return (speed / strideAt(speed)) * Math.PI * 2;
}

/** The rig is 1.83 m tall; the dreamer's eyes are at 1.65 m (src/modes/dreamwalk.ts). */
const HEIGHT = 0.96;

/** Ease a value towards a target at a rate (1/s), frame-rate independent. */
function ease(v: number, target: number, rate: number, dt: number): number {
  return v + (target - v) * (1 - Math.exp(-rate * dt));
}

const IDLE = clip('idle');
const AIR = clip('air');
const LAND = clip('land');
const NECK = bone('neck');
const HEAD = bone('head');

/**
 * The dreamer's own body, seen in the third-person view: a man in a dark suit
 * and tie (src/people/figure.ts) on the skeleton everyone in the dream shares,
 * moved by its walking, running and jumping clips. The clips follow the walker's
 * stride clock, which turns with the ground covered, so the feet do not slide.
 * It faces +z with +y up and its feet at the origin; the walker places it each
 * frame (through the folds, or inside the hallway) with place().
 */
export class DreamerBody {
  readonly group = new THREE.Group();
  readonly figure = new Figure();
  private air = 0;
  private airTime = 0;
  private landing = 1;
  private pace = 0;
  private clock = 0;
  private turn = 0;
  private nod = 0;
  private shot: { clip: ClipName; t: number } | null = null;
  private readonly pose = newPose();
  private readonly other = newPose();
  private readonly stride = newPose();
  private readonly m = new THREE.Matrix4();
  private readonly side = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.figure.mesh.scale.setScalar(HEIGHT);
    this.group.add(this.figure.mesh);
    this.animate(0, { speed: 0, phase: 0, grounded: true, lookYaw: 0, lookPitch: 0 });
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }

  /** Stand the body with its feet at a world point, up along `up`, facing `forward` (both unit, and at right angles). */
  place(feet: THREE.Vector3, up: THREE.Vector3, forward: THREE.Vector3): void {
    this.side.crossVectors(up, forward).normalize();
    this.fwd.crossVectors(this.side, up);
    this.m.makeBasis(this.side, up, this.fwd).setPosition(feet);
    this.group.matrix.copy(this.m);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** Play a clip once over whatever the body is doing (reaching for something, taking a blow). */
  play(name: ClipName): void {
    this.shot = { clip: name, t: 0 };
  }

  animate(dt: number, gait: Gait): void {
    this.clock += dt;
    const pose = this.pose;
    const other = this.other;
    // standing: breathing, the weight shifting
    samplePose(IDLE, this.clock / IDLE.duration, pose);

    // walking to sprinting: the clips share a phase, so they are mixed frame for frame
    this.pace = ease(this.pace, gait.speed, 9, dt);
    const moving = THREE.MathUtils.smoothstep(this.pace, 0.15, 0.9);
    if (moving > 0) {
      const u = gait.phase / (Math.PI * 2);
      const w = gaitWeights(this.pace);
      const stride = this.stride;
      let sum = 0;
      for (let i = 0; i < w.length; i++) {
        if (w[i] <= 0) continue;
        sum += w[i];
        if (sum === w[i]) samplePose(GAIT_CLIPS[i], u, stride);
        else blendPose(stride, samplePose(GAIT_CLIPS[i], u, other), w[i] / sum);
      }
      blendPose(pose, stride, moving);
    }

    // off the ground: legs tucked, arms out for balance
    this.air = ease(this.air, gait.grounded ? 0 : 1, gait.grounded ? 16 : 9, dt);
    if (gait.grounded) {
      if (this.airTime > 0.3) this.landing = 0;
      this.airTime = 0;
    } else {
      this.airTime += dt;
    }
    if (this.air > 0.001) blendPose(pose, samplePose(AIR, this.clock / AIR.duration, other), this.air);
    // coming down from a real jump at a standstill, the knees take it; at a run the stride carries on
    if (this.landing < 1) {
      this.landing = Math.min(1, this.landing + dt / 0.5);
      const give = (1 - THREE.MathUtils.smoothstep(this.landing, 0.25, 1)) * (1 - THREE.MathUtils.clamp(this.pace / 4, 0, 1));
      if (give > 0.001) blendPose(pose, samplePose(LAND, 0.12 + this.landing * 0.3, other), give * (1 - this.air));
    }

    if (this.shot) {
      const c = clip(this.shot.clip);
      this.shot.t += dt;
      const t = this.shot.t;
      const w = Math.min(1, t / 0.12, (c.duration - t) / 0.2);
      if (t >= c.duration) this.shot = null;
      else blendPose(pose, samplePose(c, t / c.duration, other), Math.max(0, w));
    }

    // The head turns towards where the dreamer is looking, as far as a neck goes. Looking
    // right behind (walking back towards the camera) it faces front: no craning, and no
    // flicking from shoulder to shoulder as the angle wraps past ±π.
    const front = 1 - THREE.MathUtils.smoothstep(Math.abs(gait.lookYaw), 1.9, 2.6);
    this.turn = ease(this.turn, THREE.MathUtils.clamp(gait.lookYaw, -1.1, 1.1) * front, 10, dt);
    this.nod = ease(this.nod, THREE.MathUtils.clamp(-gait.lookPitch * 0.6, -0.5, 0.45) * front, 10, dt);
    // the neck takes some of the turn and the head the rest
    for (const [b, share] of [
      [NECK, 0.4],
      [HEAD, 0.6],
    ] as const) {
      const yaw = this.turn * share * 0.5;
      const pitch = this.nod * share * 0.5;
      // yaw about +y, then the nod about the turned head's own side-to-side axis
      const [sy, cy, sp, cp] = [Math.sin(yaw), Math.cos(yaw), Math.sin(pitch), Math.cos(pitch)];
      turnInBody(pose, b, cy * sp, sy * cp, -sy * sp, cy * cp);
    }
    this.figure.pose(pose);
  }
}
