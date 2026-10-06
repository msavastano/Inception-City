import * as THREE from 'three';
import { BLOCK, mod, streetHalfWidth } from '../core/config';
import { rng } from '../core/rng';
import { personGeometry } from '../city/geometry';

/**
 * The dreamer's projections: pedestrians who walk the sidewalks in fabric
 * space (so they keep walking on walls and ceilings when the city folds) and
 * who turn on you when the dream becomes unstable.
 *
 * Sidewalks form a lattice: along each axis, node 2k sits just before street
 * line k and node 2k+1 just after it. Every lattice edge is either a stretch of
 * sidewalk or a zebra crossing, so agents never need a navmesh.
 */

function nodeCoord(i: number): number {
  const line = Math.floor(i / 2);
  const o = streetHalfWidth(line) - 1.7;
  return line * BLOCK + (mod(i, 2) === 0 ? -o : o);
}

interface Agent {
  x: number;
  z: number;
  ix: number;
  iz: number;
  tx: number;
  tz: number;
  dx: number;
  dz: number;
  speed: number;
  phase: number;
  tone: number;
  suspicion: number;
  yaw: number;
  hunting: boolean;
}

/** How a crowd behaves. The defaults are the city's own projections; Heist mode's guards tighten them. */
export interface CrowdOptions {
  /** How far around the focus agents appear, in sidewalk-lattice steps (two per block). */
  spread?: number;
  /** Agents further than this from the focus are moved back near it. */
  leash?: number;
  /** ...appearing at least this far from it, out of sight. */
  respawnMin?: number;
  /** Distances over which their attention to the dreamer fades out. */
  near?: number;
  far?: number;
  /** 0: some people are more suspicious than others. 1: everyone is (guards). */
  zeal?: number;
  /** Range of coat tones (the prop shader picks one of four coats from it). */
  tones?: [number, number];
}

export class Projections {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.InstancedBufferGeometry();
  private aPos: THREE.InstancedBufferAttribute;
  private aParam: THREE.InstancedBufferAttribute;
  private aState: THREE.InstancedBufferAttribute;
  private agents: Agent[] = [];
  private rand = rng(1234);
  maxSuspicion = 0;
  watching = 0;
  /** How many are hunting the dreamer right now. */
  hunting = 0;
  /** Someone reached the dreamer (from fabric x, z). They lose track of you for a moment. */
  onCaught: ((x: number, z: number) => void) | null = null;
  private opts: Required<CrowdOptions>;

  constructor(
    material: THREE.Material,
    depth: THREE.Material,
    readonly capacity: number,
    options: CrowdOptions = {},
  ) {
    this.opts = { spread: 18, leash: 330, respawnMin: 140, near: 50, far: 230, zeal: 0, tones: [0, 1], ...options };
    const base = personGeometry();
    for (const [name, attr] of Object.entries(base.attributes)) this.geometry.setAttribute(name, attr);
    const mk = (size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(4);
    this.aParam = mk(4);
    this.aState = mk(4);
    this.geometry.setAttribute('iPosYaw', this.aPos);
    this.geometry.setAttribute('iParam', this.aParam);
    this.geometry.setAttribute('iState', this.aState);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  setCount(n: number, fx: number, fz: number): void {
    n = Math.min(n, this.capacity);
    while (this.agents.length < n) {
      const a = {} as Agent;
      this.spawn(a, fx, fz, 0);
      this.agents.push(a);
    }
    this.agents.length = n;
    this.geometry.instanceCount = n;
  }

  private spawn(a: Agent, fx: number, fz: number, minDist: number): void {
    const r = this.rand;
    for (let tries = 0; tries < 8; tries++) {
      a.ix = Math.round((fx / BLOCK) * 2) + Math.floor((r() - 0.5) * this.opts.spread);
      a.iz = Math.round((fz / BLOCK) * 2) + Math.floor((r() - 0.5) * this.opts.spread);
      a.x = nodeCoord(a.ix);
      a.z = nodeCoord(a.iz);
      if (Math.hypot(a.x - fx, a.z - fz) >= minDist) break;
    }
    a.speed = 1.1 + r() * 0.7;
    a.phase = r() * 6.28;
    const [t0, t1] = this.opts.tones;
    a.tone = t0 + (t1 - t0) * r();
    a.suspicion = 0;
    a.hunting = false;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    const d = dirs[Math.floor(r() * 4)];
    a.dx = d[0];
    a.dz = d[1];
    a.tx = a.ix + a.dx;
    a.tz = a.iz + a.dz;
    // start somewhere along the first edge
    const t = r();
    a.x += (nodeCoord(a.tx) - a.x) * t;
    a.z += (nodeCoord(a.tz) - a.z) * t;
    a.yaw = Math.atan2(a.dx, a.dz);
  }

  private nextEdge(a: Agent): void {
    const r = this.rand();
    a.ix = a.tx;
    a.iz = a.tz;
    if (r < 0.62) {
      // keep going
    } else if (r < 0.94) {
      [a.dx, a.dz] = this.rand() < 0.5 ? [a.dz, -a.dx] : [-a.dz, a.dx];
    } else {
      a.dx = -a.dx;
      a.dz = -a.dz;
    }
    // never step onto the circus island (the totem)
    let nx = a.ix + a.dx;
    let nz = a.iz + a.dz;
    if (Math.hypot(nodeCoord(nx), nodeCoord(nz)) < 16) {
      a.dx = -a.dx;
      a.dz = -a.dz;
      nx = a.ix + a.dx;
      nz = a.iz + a.dz;
    }
    a.tx = nx;
    a.tz = nz;
  }

  update(
    dt: number,
    focusX: number,
    focusZ: number,
    dreamer: { x: number; z: number } | null,
    instability: number,
    collide: (x: number, z: number, r: number) => { x: number; z: number },
    /** Extra suspicion on top of what instability causes (Heist mode: depth, running, guarding). */
    alert = 0,
  ): void {
    const o = this.opts;
    const pos = this.aPos.array as Float32Array;
    const par = this.aParam.array as Float32Array;
    const st = this.aState.array as Float32Array;
    const tx = dreamer ? dreamer.x : focusX;
    const tz = dreamer ? dreamer.z : focusZ;
    let maxS = 0;
    let watching = 0;
    let hunting = 0;

    this.agents.forEach((a, i) => {
      if (Math.hypot(a.x - focusX, a.z - focusZ) > o.leash) this.spawn(a, focusX, focusZ, o.respawnMin);

      const toX = tx - a.x;
      const toZ = tz - a.z;
      const dist = Math.hypot(toX, toZ);
      const prox = 1 - THREE.MathUtils.smoothstep(dist, o.near, o.far);
      const keen = THREE.MathUtils.lerp(0.6 + 0.4 * a.tone, 1, o.zeal);
      const target = Math.min(1, instability * 1.25 + alert) * prox * keen;
      a.suspicion += (target - a.suspicion) * Math.min(1, dt * (target > a.suspicion ? 0.9 : 0.25));
      maxS = Math.max(maxS, a.suspicion);

      let moving = true;
      if (a.suspicion > 0.8 && dreamer) {
        // hunt
        a.hunting = true;
        const sp = 2.4 + a.suspicion * 2.2;
        a.x += (toX / Math.max(dist, 1e-3)) * sp * dt;
        a.z += (toZ / Math.max(dist, 1e-3)) * sp * dt;
        const c = collide(a.x, a.z, 0.3);
        a.x = c.x;
        a.z = c.z;
        a.yaw = Math.atan2(toX, toZ);
        a.phase += dt * sp * 5.5;
        if (dist < 1.1 && this.onCaught) {
          this.onCaught(a.x, a.z);
          a.suspicion = 0.3;
        }
        watching++;
        hunting++;
      } else if (a.suspicion > 0.42) {
        // stop and stare
        moving = false;
        const want = Math.atan2(toX, toZ);
        let dy = want - a.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        a.yaw += dy * Math.min(1, dt * 5);
        watching++;
      } else {
        if (a.hunting) {
          // rejoin the sidewalk lattice
          a.hunting = false;
          a.tx = Math.round((a.x / BLOCK) * 2);
          a.tz = Math.round((a.z / BLOCK) * 2);
          a.dx = 1;
          a.dz = 0;
        }
        const gx = nodeCoord(a.tx);
        const gz = nodeCoord(a.tz);
        const ex = gx - a.x;
        const ez = gz - a.z;
        const el = Math.hypot(ex, ez);
        const step = a.speed * dt;
        if (el <= step) {
          a.x = gx;
          a.z = gz;
          this.nextEdge(a);
        } else {
          a.x += (ex / el) * step;
          a.z += (ez / el) * step;
          const want = Math.atan2(ex, ez);
          let dy = want - a.yaw;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          a.yaw += dy * Math.min(1, dt * 8);
        }
        a.phase += dt * a.speed * 5.5;
      }
      if (!moving) a.phase += (Math.round(a.phase / Math.PI) * Math.PI - a.phase) * Math.min(1, dt * 6);

      pos[i * 4] = a.x;
      pos[i * 4 + 1] = 0;
      pos[i * 4 + 2] = a.z;
      pos[i * 4 + 3] = a.yaw;
      par[i * 4] = 0.94 + a.tone * 0.14;
      par[i * 4 + 1] = a.tone;
      par[i * 4 + 2] = a.phase;
      par[i * 4 + 3] = 0;
      st[i * 4] = a.suspicion;
      st[i * 4 + 1] = 2;
    });
    this.maxSuspicion = maxS;
    this.watching = watching;
    this.hunting = hunting;
    for (const attr of [this.aPos, this.aParam, this.aState]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, this.agents.length * 4);
      attr.needsUpdate = true;
    }
  }

  /** Everyone forgets (after a kick). */
  calm(): void {
    for (const a of this.agents) a.suspicion = 0;
  }

  /** Everyone forgets and goes somewhere else around a fabric point (a new dream). */
  scatter(fx: number, fz: number, minDist = 30): void {
    for (const a of this.agents) this.spawn(a, fx, fz, minDist);
    this.hunting = 0;
    this.watching = 0;
  }
}
