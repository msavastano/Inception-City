import * as THREE from 'three';

/** How the dreamer is moving this frame, as the body animation sees it. */
export interface Gait {
  /** Ground speed, m/s. */
  speed: number;
  /** Stride phase: a footfall every π (the walker's footstep clock). */
  phase: number;
  /** Feet on the ground (or on a hallway wall). */
  grounded: boolean;
  /** Where the dreamer is looking, relative to where the body faces (radians, positive to the left), and how far up. */
  lookYaw: number;
  lookPitch: number;
}

/** Fully into a jog at the walker's walking pace, fully into the sprint at its running pace (src/modes/dreamwalk.ts). */
const JOG = 5.5;
const RUN_FROM = 6.5;
const RUN_SPAN = 6;

const SUIT = new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.72 });
const SHIRT = new THREE.MeshStandardMaterial({ color: 0xe2ded5, roughness: 0.6 });
const TIE = new THREE.MeshStandardMaterial({ color: 0x5c1a1c, roughness: 0.5 });
const SKIN = new THREE.MeshStandardMaterial({ color: 0xc89f86, roughness: 0.65 });
const HAIR = new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.85 });
const SHOES = new THREE.MeshStandardMaterial({ color: 0x0d0d10, roughness: 0.35, metalness: 0.1 });

function part(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function joint(parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/** Ease a value towards a target at a rate (1/s), frame-rate independent. */
function ease(v: number, target: number, rate: number, dt: number): number {
  return v + (target - v) * (1 - Math.exp(-rate * dt));
}

/**
 * Stride angles for a gait, in radians. Forward is positive for thighs and
 * arms, knees and elbows bend positive. Pure, so the tests can check it.
 */
export function strideAngles(speed: number, phase: number): {
  thigh: [number, number];
  knee: [number, number];
  arm: [number, number];
  elbow: number;
  lean: number;
  drop: number;
  twist: number;
} {
  const g = THREE.MathUtils.clamp(speed / JOG, 0, 1);
  const run = THREE.MathUtils.clamp((speed - RUN_FROM) / RUN_SPAN, 0, 1);
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const leg = (0.5 + 0.38 * run) * g;
  // a knee folds while its leg swings through, and is nearly straight while it carries the weight
  const fold = (0.55 + 0.75 * run) * g;
  const arm = (0.3 + 0.5 * run) * g;
  return {
    thigh: [leg * s, -leg * s],
    knee: [0.08 * g + fold * Math.max(0, c), 0.08 * g + fold * Math.max(0, -c)],
    arm: [-arm * s, arm * s],
    elbow: 0.2 + 0.85 * g + 0.45 * run,
    lean: 0.05 * g + 0.2 * run,
    // lowest with the legs spread, highest as they pass
    drop: (0.03 + 0.05 * run) * g * Math.abs(s),
    twist: (0.1 + 0.06 * run) * g * s,
  };
}

/**
 * The dreamer's own body, seen in the third-person view: a figure in a dark
 * suit built from a few capsules, animated from the walker's speed and stride
 * clock. It faces +z with +y up and its feet at the origin; the walker places
 * it each frame (through the folds, or inside the hallway) with place().
 */
export class DreamerBody {
  readonly group = new THREE.Group();
  private readonly root = new THREE.Group();
  private readonly torso: THREE.Group;
  private readonly hips: THREE.Group;
  private readonly head: THREE.Group;
  private readonly hip: [THREE.Group, THREE.Group];
  private readonly knee: [THREE.Group, THREE.Group];
  private readonly shoulder: [THREE.Group, THREE.Group];
  private readonly elbow: [THREE.Group, THREE.Group];
  private air = 0;
  private clock = 0;
  private readonly m = new THREE.Matrix4();
  private readonly side = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.add(this.root);

    // Legs hang from the hips (0.95 m), knees half way down.
    this.hips = joint(this.root, 0, 0.95);
    this.hips.add(part(new THREE.CapsuleGeometry(0.1, 0.13, 3, 8).rotateZ(Math.PI / 2), SUIT, 0, -0.02, 0));
    const thigh = new THREE.CapsuleGeometry(0.075, 0.36, 3, 8);
    const shin = new THREE.CapsuleGeometry(0.06, 0.34, 3, 8);
    const shoe = new THREE.BoxGeometry(0.11, 0.08, 0.27);
    const legs = [0, 1].map((i) => {
      const hip = joint(this.hips, i === 0 ? 0.1 : -0.1, 0);
      hip.add(part(thigh, SUIT, 0, -0.225, 0));
      const knee = joint(hip, 0, -0.45);
      knee.add(part(shin, SUIT, 0, -0.22, 0));
      knee.add(part(shoe, SHOES, 0, -0.46, 0.045));
      return { hip, knee };
    });
    this.hip = [legs[0].hip, legs[1].hip];
    this.knee = [legs[0].knee, legs[1].knee];

    // The torso bends at the hips, so leaning into a run carries the head and arms with it.
    this.torso = joint(this.root, 0, 0.95);
    const jacket = new THREE.CylinderGeometry(0.19, 0.165, 0.56, 12).scale(1, 1, 0.64);
    this.torso.add(part(jacket, SUIT, 0, 0.25, 0));
    this.torso.add(part(new THREE.CapsuleGeometry(0.078, 0.29, 3, 8).rotateZ(Math.PI / 2), SUIT, 0, 0.47, 0));
    this.torso.add(part(new THREE.BoxGeometry(0.085, 0.22, 0.02), SHIRT, 0, 0.42, 0.112));
    this.torso.add(part(new THREE.BoxGeometry(0.036, 0.19, 0.012), TIE, 0, 0.4, 0.124));
    this.torso.add(part(new THREE.CylinderGeometry(0.048, 0.055, 0.12, 8), SKIN, 0, 0.58, 0));
    this.head = joint(this.torso, 0, 0.69);
    this.head.add(part(new THREE.SphereGeometry(0.108, 14, 10).scale(0.9, 1.08, 1), SKIN));
    this.head.add(part(new THREE.SphereGeometry(0.114, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.92, 1.05, 1.02), HAIR, 0, 0.012, -0.012));

    const upper = new THREE.CapsuleGeometry(0.055, 0.22, 3, 8);
    const lower = new THREE.CapsuleGeometry(0.047, 0.2, 3, 8);
    const hand = new THREE.SphereGeometry(0.045, 8, 6);
    const arms = [0, 1].map((i) => {
      const shoulder = joint(this.torso, i === 0 ? 0.215 : -0.215, 0.47);
      shoulder.add(part(upper, SUIT, 0, -0.15, 0));
      const elbow = joint(shoulder, 0, -0.3);
      elbow.add(part(lower, SUIT, 0, -0.13, 0));
      elbow.add(part(hand, SKIN, 0, -0.29, 0));
      return { shoulder, elbow };
    });
    this.shoulder = [arms[0].shoulder, arms[1].shoulder];
    this.elbow = [arms[0].elbow, arms[1].elbow];
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

  animate(dt: number, gait: Gait): void {
    this.clock += dt;
    const k = 14;
    this.air = ease(this.air, gait.grounded ? 0 : 1, gait.grounded ? 18 : 8, dt);
    const a = this.air;
    const st = strideAngles(gait.grounded ? gait.speed : 0, gait.phase);
    // standing still, the dreamer breathes and the arms hang a little away from the body
    const still = 1 - THREE.MathUtils.clamp(gait.speed / 1.5, 0, 1);
    const breath = Math.sin(this.clock * 1.7) * 0.012 * still;

    this.root.position.y = ease(this.root.position.y, -st.drop * (1 - a), k, dt);
    this.torso.rotation.x = ease(this.torso.rotation.x, st.lean * (1 - a) + 0.12 * a + breath, k, dt);
    this.torso.rotation.y = ease(this.torso.rotation.y, -0.7 * st.twist, k, dt);
    this.hips.rotation.y = ease(this.hips.rotation.y, st.twist, k, dt);

    // in the air: one knee up, the other trailing, arms out for balance
    const tuckThigh = [0.75, -0.15];
    const tuckKnee = [1.1, 0.55];
    for (let i = 0; i < 2; i++) {
      const out = i === 0 ? 1 : -1;
      this.hip[i].rotation.x = ease(this.hip[i].rotation.x, -THREE.MathUtils.lerp(st.thigh[i], tuckThigh[i], a), k, dt);
      this.knee[i].rotation.x = ease(this.knee[i].rotation.x, THREE.MathUtils.lerp(st.knee[i], tuckKnee[i], a), k, dt);
      this.shoulder[i].rotation.x = ease(this.shoulder[i].rotation.x, -THREE.MathUtils.lerp(st.arm[i], 0.35, a), k, dt);
      this.shoulder[i].rotation.z = ease(this.shoulder[i].rotation.z, out * (0.07 + 0.04 * still + 0.75 * a), k, dt);
      this.elbow[i].rotation.x = ease(this.elbow[i].rotation.x, -THREE.MathUtils.lerp(st.elbow, 0.5, a), k, dt);
    }

    // The head turns towards where the dreamer is looking, as far as a neck goes. Looking
    // right behind (walking back towards the camera) it faces front: no craning, and no
    // flicking from shoulder to shoulder as the angle wraps past ±π.
    const front = 1 - THREE.MathUtils.smoothstep(Math.abs(gait.lookYaw), 1.9, 2.6);
    const turn = THREE.MathUtils.clamp(gait.lookYaw, -1.1, 1.1) * front;
    const nod = THREE.MathUtils.clamp(-gait.lookPitch * 0.6, -0.5, 0.45) * front - st.lean * 0.6;
    this.head.rotation.y = ease(this.head.rotation.y, turn, 10, dt);
    this.head.rotation.x = ease(this.head.rotation.x, nod, 10, dt);
  }
}
