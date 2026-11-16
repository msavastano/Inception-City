import * as THREE from 'three';
import { BLOCK, mod, streetHalfWidth } from '../core/config';
import { rng } from '../core/rng';
import { Outfit, pedestrian, People } from '../people/crowd';
import { clip, ClipName } from '../people/rig';

/**
 * The dreamer's projections: pedestrians who walk the sidewalks in fabric
 * space (so they keep walking on walls and ceilings when the city folds) and
 * who turn on you when the dream becomes unstable. They are drawn as People
 * (src/people/crowd.ts): this file decides where each one is and which clip
 * they are in, and moves each clip on with the ground its owner covers, so
 * nobody's feet slide.
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

/** The two ways of walking, and how far one cycle (two steps) of each carries a walker. */
const WALKS: ClipName[] = ['stroll', 'walk'];
const JOG = clip('jog');
/** Seconds to change from one clip to another. */
const FADE = 0.3;
/** People this close to the focus cast shadows (metres). */
const SHADOW_RANGE = 110;
/** The dreamer hears the footsteps of people this close (metres), and of no more than this many at once. */
const EARSHOT = 16;
const HEARD = 8;

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
  /** How this one walks. */
  walk: ClipName;
  /** The clip being played, and its phase in cycles. */
  clip: ClipName;
  phase: number;
  /** The clip being left, frozen where it was, and how much of it remains. */
  from: ClipName;
  fromPhase: number;
  fade: number;
  /** Standing about for this many more seconds (talking, or just waiting). */
  rest: number;
  pause: ClipName;
  /** How readily this one turns on the dreamer, 0 to 1. */
  keen: number;
  suspicion: number;
  yaw: number;
  /** The head, turned towards the dreamer (radians to the left). */
  look: number;
  hunting: boolean;
  outfit: Outfit;
  /** Distance from the focus, for drawing the nearest first. */
  away: number;
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
  /** What each one wears (src/people/crowd.ts). The default is a street's mix of pedestrians. */
  outfit?: (r: () => number) => Outfit;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class Projections {
  readonly people: People;
  readonly mesh: THREE.Mesh;
  private agents: Agent[] = [];
  private rand = rng(1234);
  private wardrobe = rng(4321);
  maxSuspicion = 0;
  watching = 0;
  /** How many are hunting the dreamer right now. */
  hunting = 0;
  /**
   * Feet that came down near the dreamer since this was last emptied: fabric x, z pairs.
   * Whoever plays them empties it.
   */
  readonly footfalls: number[] = [];
  /** Someone reached the dreamer (from fabric x, z). They lose track of you for a moment. */
  onCaught: ((x: number, z: number) => void) | null = null;
  private opts: Required<CrowdOptions>;

  constructor(
    material: THREE.Material,
    depth: THREE.Material,
    readonly capacity: number,
    options: CrowdOptions = {},
  ) {
    this.opts = { spread: 18, leash: 330, respawnMin: 140, near: 50, far: 230, zeal: 0, outfit: pedestrian, ...options };
    this.people = new People(material, depth, capacity);
    this.mesh = this.people.mesh;
  }

  setCount(n: number, fx: number, fz: number): void {
    n = Math.min(n, this.capacity);
    while (this.agents.length < n) {
      const a = {} as Agent;
      this.spawn(a, fx, fz, 0);
      // everyone keeps their clothes, wherever they are sent
      a.outfit = this.opts.outfit(this.wardrobe);
      a.away = 0;
      this.agents.push(a);
    }
    this.agents.length = n;
    this.people.count = n;
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
    // everyone walks at their own pace, from a dawdle to a hurry, around the pace their walk was animated at
    a.walk = WALKS[Math.floor(r() * WALKS.length)];
    a.speed = clip(a.walk).speed! * (0.88 + r() * 0.5);
    a.phase = r();
    a.clip = a.walk;
    a.from = a.walk;
    a.fromPhase = 0;
    a.fade = 0;
    a.pause = r() < 0.5 ? 'talk' : 'idle';
    a.rest = r() < 0.1 ? 3 + r() * 9 : 0;
    a.keen = r();
    a.suspicion = 0;
    a.look = 0;
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
    // now and then someone stops at a corner for a while
    if (this.rand() < 0.07) a.rest = 3 + this.rand() * 9;
  }

  /** Change an agent's clip, fading out of the old one. Walking and jogging share a phase, so the stride carries over. */
  private play(a: Agent, name: ClipName): void {
    if (a.clip === name) return;
    const strides = (n: ClipName) => n !== 'idle' && n !== 'talk';
    a.from = a.clip;
    a.fromPhase = a.phase;
    a.fade = 1;
    if (!strides(name) || !strides(a.clip)) a.phase = strides(name) ? 0 : this.rand();
    a.clip = name;
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
    const tx = dreamer ? dreamer.x : focusX;
    const tz = dreamer ? dreamer.z : focusZ;
    let maxS = 0;
    let watching = 0;
    let hunting = 0;

    // nearest the focus first, so that the shadow pass can stop after the people whose shadows can be seen
    for (const a of this.agents) a.away = Math.hypot(a.x - focusX, a.z - focusZ);
    this.agents.sort((a, b) => a.away - b.away);
    let near = 0;

    this.agents.forEach((a, i) => {
      if (a.away < SHADOW_RANGE) near = i + 1;
      if (a.away > o.leash) this.spawn(a, focusX, focusZ, o.respawnMin);

      const toX = tx - a.x;
      const toZ = tz - a.z;
      const dist = Math.hypot(toX, toZ);
      const stride = Math.floor(a.phase * 2);
      const prox = 1 - THREE.MathUtils.smoothstep(dist, o.near, o.far);
      const keen = THREE.MathUtils.lerp(0.6 + 0.4 * a.keen, 1, o.zeal);
      const target = Math.min(1, instability * 1.25 + alert) * prox * keen;
      a.suspicion += (target - a.suspicion) * Math.min(1, dt * (target > a.suspicion ? 0.9 : 0.25));
      maxS = Math.max(maxS, a.suspicion);
      const bearing = Math.atan2(toX, toZ);

      if (a.suspicion > 0.8 && dreamer) {
        // hunt: run straight at the dreamer
        a.hunting = true;
        a.rest = 0;
        const sp = 2.4 + a.suspicion * 2.2;
        a.x += (toX / Math.max(dist, 1e-3)) * sp * dt;
        a.z += (toZ / Math.max(dist, 1e-3)) * sp * dt;
        const c = collide(a.x, a.z, 0.3);
        a.x = c.x;
        a.z = c.z;
        a.yaw += wrap(bearing - a.yaw) * Math.min(1, dt * 10);
        this.play(a, 'jog');
        a.phase += (dt * sp) / JOG.stride!;
        if (dist < 1.1 && this.onCaught) {
          this.onCaught(a.x, a.z);
          a.suspicion = 0.3;
        }
        watching++;
        hunting++;
      } else if (a.suspicion > 0.42) {
        // stop and stare
        a.yaw += wrap(bearing - a.yaw) * Math.min(1, dt * 5);
        this.play(a, 'idle');
        a.phase += dt / clip('idle').duration;
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
        if (a.rest > 0) {
          a.rest -= dt;
          this.play(a, a.pause);
          a.phase += dt / clip(a.pause).duration;
        } else {
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
            a.yaw += wrap(Math.atan2(ex, ez) - a.yaw) * Math.min(1, dt * 8);
          }
          this.play(a, a.walk);
          // a stride for each stride-length of pavement
          a.phase += step / clip(a.walk).stride!;
        }
      }
      if (a.fade > 0) a.fade = Math.max(0, a.fade - dt / FADE);
      // every clip that walks starts as the left foot lands, so a foot comes down twice a cycle
      if (dreamer && dist < EARSHOT && a.clip !== 'idle' && a.clip !== 'talk' && Math.floor(a.phase * 2) !== stride && this.footfalls.length < HEARD * 2) {
        this.footfalls.push(a.x, a.z);
      }

      // someone who has begun to notice turns their head to watch the dreamer go by (not right round: nobody's neck does that)
      const off = wrap(bearing - a.yaw);
      const notice = dreamer && Math.abs(off) < 2 ? THREE.MathUtils.smoothstep(a.suspicion, 0.1, 0.3) : 0;
      a.look += (THREE.MathUtils.clamp(off, -1.2, 1.2) * notice - a.look) * Math.min(1, dt * 6);

      this.people.dress(i, a.outfit);
      this.people.stand(i, {
        x: a.x,
        y: 0,
        z: a.z,
        yaw: a.yaw,
        clip: a.clip,
        phase: a.phase,
        from: a.from,
        fromPhase: a.fromPhase,
        fade: a.fade,
        look: a.look,
        suspicion: a.suspicion,
      });
    });
    this.maxSuspicion = maxS;
    this.watching = watching;
    this.hunting = hunting;
    this.people.shadows = near;
    this.people.commit();
  }

  /** Where the people nearest the focus are: fills `out` with x, z pairs and returns how many. */
  nearest(out: Float32Array): number {
    const n = Math.min(this.agents.length, out.length >> 1);
    for (let i = 0; i < n; i++) {
      out[i * 2] = this.agents[i].x;
      out[i * 2 + 1] = this.agents[i].z;
    }
    return n;
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
