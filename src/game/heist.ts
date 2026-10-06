import { BLOCK, streetHalfWidth } from '../core/config';
import { hash3, rng } from '../core/rng';

/**
 * Heist mode: go down three dreams through sleep machines, plant an idea in
 * the target on Level 3, then ride the kicks back up and wake before the
 * topside clock runs out (docs/CITY_PLAN.md, section 4.5).
 *
 * This file is the run's rules and bookkeeping only (no rendering, no DOM),
 * so a whole job can be played out in tests. src/app.ts drives it every frame
 * and turns what it reports into level changes, sound and HUD.
 */

/** Depth of Limbo (also its index in LEVELS). Levels 1 to 3 are depths 0 to 2. */
export const LIMBO = 3;
/** The deepest level a sleep machine reaches. The target waits there. */
export const TARGET_DEPTH = 2;
/** Topside seconds at the start of a job. */
export const TOPSIDE_START = 480;
/** How fast the topside clock runs at each depth. Limbo stops it. */
export const TOPSIDE_RATE = [1, 0.5, 0.25, 0];
/** Health regained per second of play while nothing is hunting you: a full heal takes 100 s. */
export const HEAL_RATE = 0.01;
/** Health lost when a projection reaches you, and when the dream blows up around you. */
export const HIT = 0.25;
export const BLAST_HIT = 0.4;
/** Seconds after a hit before another can land. */
export const GRACE = 2;
/** Below this you limp: no running. */
export const LIMP_BELOW = 0.5;
/** Seconds of lucidity in Limbo with and without your totem, and what a hit or a blast costs there. */
export const LUCIDITY_WITH_TOTEM = 90;
export const LUCIDITY_WITHOUT = 45;
export const LIMBO_HIT = 15;
export const LIMBO_BLAST = 25;
/** Health you come back from Limbo with. */
export const LIMBO_RETURN_HEALTH = 0.35;
/** How close you walk to pick something up or use a sleep machine. */
export const REACH = 2.4;
/** Planting: stay this close to the target for this long without being hit. */
export const PLANT_REACH = 3.2;
export const PLANT_TIME = 3;
/** K on Level 1 before the idea is planted asks again; a second K within this many seconds wakes you. */
export const WAKE_CONFIRM = 3;

/** The dreamscape (src/modes/presets.ts) each depth starts folded into. */
export const SCAPES: readonly (string | null)[] = ['paris', 'escher', 'box', null];

export type ItemKind = 'machine' | 'kick' | 'totem' | 'target';

export interface Item {
  kind: ItemKind;
  /** Fabric position (always a sidewalk corner) and facing. */
  x: number;
  z: number;
  yaw: number;
  taken: boolean;
}

export interface Spot {
  x: number;
  z: number;
  yaw: number;
}

export type Outcome = 'won' | 'time' | 'woke' | 'lost' | 'abandoned';

export type HeistEvent =
  | { type: 'pickup'; item: Item }
  /** You walked into a sleep machine and may go under. */
  | { type: 'under' }
  /** You walked into the Level 2 machine without your totem. */
  | { type: 'needTotem' }
  | { type: 'planted' }
  | { type: 'over'; outcome: Outcome };

export type KickResult =
  /** Nothing happens (this level's kick hasn't been found, or the job is over). */
  | { type: 'none' }
  /** Waking from Level 1 without the idea: K again to really wake. */
  | { type: 'confirm' }
  | { type: 'up'; depth: number; at: Spot; fromLimbo: boolean }
  | { type: 'limbo'; at: Spot }
  | { type: 'wake'; outcome: Outcome };

/** Where every level starts: on the boulevard sidewalk just south of the Circus, facing it. */
export const SPAWN: Spot = { x: streetHalfWidth(0) - 1.8, z: -70, yaw: 0 };

/** Each level is its own city. Level 1 uses the job's seed itself, so a shared link shows its city. */
export function levelSeed(seed: number, depth: number): number {
  return depth === 0 ? seed : Math.floor(hash3(seed, depth, 9001) * 1e6);
}

type Rect = readonly [x0: number, x1: number, z0: number, z1: number];

/**
 * Where things can be placed on each level, as fabric rectangles (one is picked
 * at random per item). They are laid out against the level's dreamscape.
 */
export const ZONES: readonly Partial<Record<ItemKind, readonly Rect[]>>[] = [
  // Level 1, the Paris Fold (hinge z = 192, radius 110): past z ≈ 537 the city hangs upside down
  // overhead, and the sleep machine is up there. Walk up the curl, or ride it.
  {
    machine: [[-200, 200, 590, 700]],
    totem: [[-300, 300, -340, -170]],
    kick: [
      [180, 380, -150, 150],
      [-380, -180, -150, 150],
    ],
  },
  // Level 2, Escher Steps: a wall of city rises from z ≈ 64 to 256, then levels off into a
  // terrace. The machine is up on the terrace.
  {
    machine: [[-200, 200, 320, 430]],
    kick: [
      [180, 380, -220, 30],
      [-380, -180, -220, 30],
    ],
  },
  // Level 3, City in a Box: the target is inside the four walls, the kick is up one of them.
  {
    // (well clear of where you arrive, so the guards don't meet you there)
    target: [
      [-150, 150, 80, 165],
      [-170, -110, -120, 165],
      [110, 170, -120, 165],
    ],
    kick: [
      [-120, 120, 300, 370],
      [-120, 120, -370, -300],
      [300, 370, -120, 120],
      [-370, -300, -120, 120],
    ],
  },
  // Limbo: the kick is on the dry ground, before the city crumbles into the sea.
  {
    kick: [
      [-180, 180, 110, 180],
      [-180, 180, -180, -110],
      [110, 180, -110, 110],
      [-180, -110, -110, 110],
    ],
  },
];

/** Order things are placed in (the first item on a level gets the most room). */
const ORDER: ItemKind[] = ['target', 'machine', 'totem', 'kick'];
/** Clearance from the Circus, from the spawn, and between items. */
const CIRCUS_CLEAR = 40;
const SPAWN_CLEAR = 50;
const APART = 60;

/** The sidewalk corner nearest a fabric coordinate (where the projections' lattice turns). */
function cornerCoord(v: number): number {
  const line = Math.round(v / BLOCK);
  const o = streetHalfWidth(line) - 1.7;
  return line * BLOCK + (v >= line * BLOCK ? o : -o);
}

/** Facing out over the crossing, away from the corner of the block. */
function cornerYaw(x: number, z: number): number {
  return Math.atan2(Math.round(x / BLOCK) * BLOCK - x, Math.round(z / BLOCK) * BLOCK - z);
}

/**
 * Pick the job's places on one level. Deterministic in (seed, depth); isFree
 * says whether a fabric point is clear of buildings, trees and lamps.
 */
export function placeLevel(seed: number, depth: number, isFree: (x: number, z: number) => boolean): Item[] {
  const zones = ZONES[depth] ?? {};
  const rand = rng(Math.floor(hash3(seed, depth, 4242) * 4294967296));
  const items: Item[] = [];
  for (const kind of ORDER) {
    const rects = zones[kind];
    if (!rects) continue;
    let pick: { x: number; z: number } | null = null;
    let fallback: { x: number; z: number } | null = null;
    for (let tries = 0; tries < 80 && !pick; tries++) {
      const r = rects[Math.floor(rand() * rects.length)];
      const x = cornerCoord(r[0] + (r[1] - r[0]) * rand());
      const z = cornerCoord(r[2] + (r[3] - r[2]) * rand());
      if (Math.hypot(x, z) < CIRCUS_CLEAR || Math.hypot(x - SPAWN.x, z - SPAWN.z) < SPAWN_CLEAR) continue;
      if (items.some((o) => Math.hypot(o.x - x, o.z - z) < APART)) continue;
      fallback ??= { x, z };
      if (isFree(x, z)) pick = { x, z };
    }
    const p = pick ?? fallback ?? { x: cornerCoord(rects[0][0]), z: cornerCoord(rects[0][2]) };
    items.push({ kind, x: p.x, z: p.z, yaw: cornerYaw(p.x, p.z), taken: false });
  }
  return items;
}

/** One job, from the first sleep machine to waking up (or not). */
export class HeistRun {
  depth = 0;
  topside = TOPSIDE_START;
  health = 1;
  lucidity = 0;
  hasTotem = false;
  planted = false;
  /** Seconds spent next to the target so far. */
  plant = 0;
  /** Seconds of play (your own time, at any depth). */
  played = 0;
  /** Levels whose kick you carry (Limbo's included while you hold it). */
  readonly kicks = new Set<number>();
  outcome: Outcome | null = null;
  /** The level you fell into Limbo from, and go back to. */
  fellFrom = 0;
  /** Where you last came into each level. */
  readonly arrival: Spot[] = [SPAWN];
  /** Where you wake on each level when you come back up: beside the machine you went under at. */
  readonly wakeAt: (Spot | null)[] = [null, null, null];
  private items = new Map<number, Item[]>();
  private grace = 0;
  private confirmUntil = -1;
  private atMachine = false;

  constructor(readonly seed: number) {}

  /** Place the level's things (once per job) and return them. */
  place(depth: number, isFree: (x: number, z: number) => boolean): Item[] {
    let list = this.items.get(depth);
    if (!list) {
      list = placeLevel(this.seed, depth, isFree);
      this.items.set(depth, list);
    }
    return list;
  }

  itemsAt(depth: number): Item[] {
    return this.items.get(depth) ?? [];
  }

  get here(): Item[] {
    return this.itemsAt(this.depth);
  }

  get target(): Item | undefined {
    return this.itemsAt(TARGET_DEPTH).find((i) => i.kind === 'target');
  }

  get rate(): number {
    return TOPSIDE_RATE[this.depth];
  }

  get limping(): boolean {
    return this.depth !== LIMBO && this.health < LIMP_BELOW;
  }

  /** Planting progress, 0..1. */
  get planting(): number {
    return this.planted ? 1 : Math.min(1, this.plant / PLANT_TIME);
  }

  /**
   * Advance by dt seconds of play with the dreamer at fabric (x, z). hunted:
   * a projection is after you, so you can't heal.
   */
  update(dt: number, x: number, z: number, hunted: boolean): HeistEvent[] {
    const out: HeistEvent[] = [];
    if (this.outcome) return out;
    this.played += dt;
    this.grace = Math.max(0, this.grace - dt);
    this.topside = Math.max(0, this.topside - dt * this.rate);
    if (this.topside <= 0) return this.end('time', out);
    if (this.depth === LIMBO) {
      this.lucidity = Math.max(0, this.lucidity - dt);
      if (this.lucidity <= 0) return this.end('lost', out);
    } else if (!hunted && this.health > 0) {
      this.health = Math.min(1, this.health + HEAL_RATE * dt);
    }

    for (const it of this.here) {
      if (it.taken) continue;
      const d = Math.hypot(it.x - x, it.z - z);
      if (it.kind === 'kick' || it.kind === 'totem') {
        if (d >= REACH) continue;
        it.taken = true;
        if (it.kind === 'kick') this.kicks.add(this.depth);
        else this.hasTotem = true;
        out.push({ type: 'pickup', item: it });
      } else if (it.kind === 'machine') {
        // only on walking in, so you don't go straight back under when you wake beside it
        const inside = d < REACH;
        if (inside && !this.atMachine) out.push(this.depth === 1 && !this.hasTotem ? { type: 'needTotem' } : { type: 'under' });
        this.atMachine = inside;
      } else if (it.kind === 'target' && !this.planted) {
        if (d < PLANT_REACH) {
          this.plant += dt;
          if (this.plant >= PLANT_TIME) {
            this.planted = true;
            out.push({ type: 'planted' });
          }
        } else {
          this.plant = Math.max(0, this.plant - dt * 2);
        }
      }
    }
    return out;
  }

  /** A projection reached you. */
  hit(): 'none' | 'hurt' | 'dead' {
    if (this.outcome || this.grace > 0) return 'none';
    this.grace = GRACE;
    this.plant = 0;
    if (this.depth === LIMBO) {
      this.lucidity = Math.max(0, this.lucidity - LIMBO_HIT);
      return 'hurt';
    }
    this.health = Math.max(0, this.health - HIT);
    return this.health <= 0 ? 'dead' : 'hurt';
  }

  /** Stability hit zero and the dream blew up around you. The kick that follows is crash(). */
  blast(): void {
    if (this.outcome) return;
    this.plant = 0;
    if (this.depth === LIMBO) this.lucidity = Math.max(1, this.lucidity - LIMBO_BLAST);
    else this.health = Math.max(0, this.health - BLAST_HIT);
  }

  /** Walk into the sleep machine: down one level. Returns where you arrive. */
  goUnder(): Spot {
    const m = this.here.find((i) => i.kind === 'machine');
    if (m) this.wakeAt[this.depth] = besideMachine(m);
    this.depth++;
    this.arrival[this.depth] = SPAWN;
    this.atMachine = false;
    this.plant = 0;
    return SPAWN;
  }

  /** K: use this level's kick, if you carry it. */
  kick(): KickResult {
    if (this.outcome || !this.kicks.has(this.depth)) return { type: 'none' };
    return this.rise(true);
  }

  /** The kick after the café explosion. Free, but if the blast killed you, you fall into Limbo. */
  crash(): KickResult {
    if (this.outcome) return { type: 'none' };
    if (this.depth !== LIMBO && this.health <= 0) return { type: 'limbo', at: this.fall() };
    return this.rise(false);
  }

  /** Your health ran out: sedated as you are, you don't wake up. You wash up in Limbo. */
  fall(): Spot {
    if (this.depth !== LIMBO) this.fellFrom = this.depth;
    this.depth = LIMBO;
    this.health = 0;
    this.lucidity = this.hasTotem ? LUCIDITY_WITH_TOTEM : LUCIDITY_WITHOUT;
    this.kicks.delete(LIMBO);
    for (const it of this.itemsAt(LIMBO)) it.taken = false;
    this.arrival[LIMBO] = SPAWN;
    this.plant = 0;
    this.grace = GRACE;
    this.atMachine = false;
    return SPAWN;
  }

  abandon(): void {
    this.outcome ??= 'abandoned';
  }

  private rise(useKick: boolean): KickResult {
    if (this.depth === LIMBO) {
      this.kicks.delete(LIMBO);
      this.depth = this.fellFrom;
      this.health = LIMBO_RETURN_HEALTH;
      this.grace = GRACE;
      return { type: 'up', depth: this.depth, at: this.arrival[this.depth] ?? SPAWN, fromLimbo: true };
    }
    if (this.depth === 0) {
      if (!this.planted && useKick && this.played > this.confirmUntil) {
        this.confirmUntil = this.played + WAKE_CONFIRM;
        return { type: 'confirm' };
      }
      this.outcome = this.planted ? 'won' : 'woke';
      return { type: 'wake', outcome: this.outcome };
    }
    this.depth--;
    const at = this.wakeAt[this.depth] ?? SPAWN;
    this.arrival[this.depth] = at;
    this.atMachine = true;
    this.plant = 0;
    return { type: 'up', depth: this.depth, at, fromLimbo: false };
  }

  private end(outcome: Outcome, out: HeistEvent[]): HeistEvent[] {
    this.outcome = outcome;
    out.push({ type: 'over', outcome });
    return out;
  }

  /** The one line the HUD shows: what to do next. */
  objective(): string {
    if (this.outcome) return '';
    if (this.depth === LIMBO) return 'Find the kick in Limbo (gold light) before you forget you are dreaming';
    if (this.planted) {
      if (this.kicks.has(this.depth)) return this.depth === 0 ? 'Press K to wake up' : 'Press K to ride the kick up';
      return "Find this level's kick: gold light, and listen for the music";
    }
    if (this.depth === TARGET_DEPTH) {
      if (this.plant > 0) return `Planting the idea… ${Math.round(this.planting * 100)}%`;
      return 'Find the target (red light) and stay beside them for 3 seconds';
    }
    if (this.depth === 0 && !this.hasTotem) return 'Find your totem (white light), then a sleep machine (blue light)';
    if (this.depth === 1 && !this.hasTotem) return 'You need your totem to go deeper. It is up on Level 1';
    return 'Find the sleep machine (blue light) to go deeper';
  }
}

/** A few steps from a sleep machine, out towards the crossing. */
function besideMachine(m: Item): Spot {
  const dx = Math.sin(m.yaw);
  const dz = Math.cos(m.yaw);
  return { x: m.x + dx * 4.2, z: m.z + dz * 4.2, yaw: m.yaw };
}
