import { describe, expect, it } from 'vitest';
import { CHUNK } from '../src/core/config';
import { ChunkData, generateChunk } from '../src/city/generator';
import {
  BLAST_HIT,
  HEAL_RATE,
  HIT,
  HeistRun,
  LIMBO,
  LIMBO_RETURN_HEALTH,
  LUCIDITY_WITHOUT,
  LUCIDITY_WITH_TOTEM,
  PLANT_TIME,
  REACH,
  SPAWN,
  TARGET_DEPTH,
  TOPSIDE_RATE,
  TOPSIDE_START,
  ZONES,
  levelSeed,
  placeLevel,
} from '../src/game/heist';

const DT = 1 / 60;
const SEED = 4711;

/** Whether a fabric point is clear of buildings and trees, straight from the generator (as streamer.collide sees it). */
function freeIn(seed: number) {
  const cache = new Map<string, ChunkData>();
  return (x: number, z: number) => {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const k = `${cx},${cz}`;
    let d = cache.get(k);
    if (!d) cache.set(k, (d = generateChunk(cx, cz, seed)));
    const r = 1;
    if (d.rects.some((b) => x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r)) return false;
    return !d.circles.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + r);
  };
}

/** A job with every level placed against its own city. */
function job(seed = SEED): HeistRun {
  const run = new HeistRun(seed);
  for (let d = 0; d <= LIMBO; d++) run.place(d, freeIn(levelSeed(seed, d)));
  return run;
}

function item(run: HeistRun, depth: number, kind: string) {
  const it = run.itemsAt(depth).find((i) => i.kind === kind);
  if (!it) throw new Error(`no ${kind} on depth ${depth}`);
  return it;
}

/** Stand on something for a frame. */
function visit(run: HeistRun, depth: number, kind: string) {
  const it = item(run, depth, kind);
  return run.update(DT, it.x, it.z, false);
}

/** Stand somewhere with nothing around for a while. */
function idle(run: HeistRun, seconds: number, hunted = false) {
  for (let t = 0; t < seconds; t += DT) run.update(DT, SPAWN.x, SPAWN.z, hunted);
}

describe('placing a job', () => {
  it('is the same every time for a seed, and different for another', () => {
    const a = placeLevel(SEED, 0, freeIn(SEED));
    const b = placeLevel(SEED, 0, freeIn(SEED));
    const c = placeLevel(SEED + 1, 0, freeIn(SEED + 1));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('puts every level’s things in their zones, on open sidewalk, apart from each other', () => {
    for (const seed of [1, 4711, 90210, 123456]) {
      for (let d = 0; d <= LIMBO; d++) {
        const free = freeIn(levelSeed(seed, d));
        const items = placeLevel(seed, d, free);
        const want = Object.keys(ZONES[d]).sort();
        expect(items.map((i) => i.kind).sort()).toEqual(want);
        for (const it of items) {
          expect(free(it.x, it.z)).toBe(true);
          const inZone = ZONES[d][it.kind]!.some(([x0, x1, z0, z1]) => it.x > x0 - 16 && it.x < x1 + 16 && it.z > z0 - 16 && it.z < z1 + 16);
          expect(inZone).toBe(true);
          expect(Math.hypot(it.x, it.z)).toBeGreaterThan(40);
          for (const o of items) if (o !== it) expect(Math.hypot(o.x - it.x, o.z - it.z)).toBeGreaterThan(59);
        }
      }
    }
  });

  it('gives every level its own city, but keeps the job seed for Level 1', () => {
    expect(levelSeed(SEED, 0)).toBe(SEED);
    const seeds = new Set([0, 1, 2, 3].map((d) => levelSeed(SEED, d)));
    expect(seeds.size).toBe(4);
  });
});

describe('the topside clock', () => {
  it('runs slower the deeper you are, and stops in Limbo', () => {
    expect(TOPSIDE_RATE).toEqual([1, 0.5, 0.25, 0]);
    const run = job();
    idle(run, 10);
    expect(run.topside).toBeCloseTo(TOPSIDE_START - 10, 1);
    visit(run, 0, 'totem');
    visit(run, 0, 'machine');
    run.goUnder();
    idle(run, 10);
    expect(run.topside).toBeCloseTo(TOPSIDE_START - 15, 1);
    visit(run, 1, 'machine');
    run.goUnder();
    idle(run, 10);
    expect(run.topside).toBeCloseTo(TOPSIDE_START - 17.5, 1);
    run.fall();
    idle(run, 10);
    expect(run.topside).toBeCloseTo(TOPSIDE_START - 17.5, 1);
  });

  it('ends the job when it runs out', () => {
    const run = job();
    run.topside = 1;
    const events: string[] = [];
    for (let t = 0; t < 2; t += DT) events.push(...run.update(DT, 0, -70, false).map((e) => e.type));
    expect(run.outcome).toBe('time');
    expect(events).toContain('over');
  });
});

describe('getting hurt and healing', () => {
  it('heals in your own time, so the same heal costs less topside deeper down', () => {
    const cost = (depth: number) => {
      const run = job();
      run.depth = depth;
      run.health = 0.5;
      const before = run.topside;
      let t = 0;
      while (run.health < 1) {
        run.update(DT, SPAWN.x, SPAWN.z, false);
        t += DT;
      }
      expect(t).toBeCloseTo(0.5 / HEAL_RATE, 0);
      return before - run.topside;
    };
    expect(cost(0)).toBeCloseTo(50, 0);
    expect(cost(1)).toBeCloseTo(25, 0);
    expect(cost(2)).toBeCloseTo(12.5, 0);
  });

  it('does not heal while a projection is hunting you', () => {
    const run = job();
    run.health = 0.5;
    idle(run, 5, true);
    expect(run.health).toBe(0.5);
  });

  it('takes a quarter per hit, with a moment of grace between hits', () => {
    const run = job();
    expect(run.hit()).toBe('hurt');
    expect(run.hit()).toBe('none');
    expect(run.health).toBeCloseTo(1 - HIT, 5);
    idle(run, 2.1, true);
    run.hit();
    expect(run.health).toBeCloseTo(1 - 2 * HIT, 5);
    expect(run.limping).toBe(false);
    idle(run, 2.1, true);
    run.hit();
    expect(run.limping).toBe(true);
    idle(run, 2.1, true);
    expect(run.hit()).toBe('dead');
  });

  it('sends you to Limbo when you die, and back where you came in with some health', () => {
    const run = job();
    visit(run, 0, 'machine');
    run.goUnder();
    run.health = 0.2;
    expect(run.hit()).toBe('dead');
    const at = run.fall();
    expect(run.depth).toBe(LIMBO);
    expect(at).toEqual(SPAWN);
    expect(run.lucidity).toBe(LUCIDITY_WITHOUT);
    expect(run.kick().type).toBe('none');
    visit(run, LIMBO, 'kick');
    const up = run.kick();
    expect(up).toEqual({ type: 'up', depth: 1, at: SPAWN, fromLimbo: true });
    expect(run.health).toBe(LIMBO_RETURN_HEALTH);
  });

  it('gives you longer in Limbo with your totem, and loses you when lucidity runs out', () => {
    const run = job();
    visit(run, 0, 'totem');
    run.fall();
    expect(run.lucidity).toBe(LUCIDITY_WITH_TOTEM);
    idle(run, LUCIDITY_WITH_TOTEM + 1);
    expect(run.outcome).toBe('lost');
  });

  it('turns the café explosion into a free kick that costs health, or Limbo if it kills you', () => {
    const run = job();
    visit(run, 0, 'totem');
    visit(run, 0, 'machine');
    run.goUnder();
    run.blast();
    expect(run.health).toBeCloseTo(1 - BLAST_HIT, 5);
    const up = run.crash();
    expect(up.type).toBe('up');
    expect(run.depth).toBe(0);

    visit(run, 0, 'machine'); // still inside its reach: nothing until you step out and back in
    run.update(DT, SPAWN.x, SPAWN.z, false);
    expect(visit(run, 0, 'machine').map((e) => e.type)).toEqual(['under']);
    run.goUnder();
    run.health = 0.3;
    run.blast();
    expect(run.crash().type).toBe('limbo');
    expect(run.depth).toBe(LIMBO);
  });
});

describe('a whole job', () => {
  it('goes down, plants the idea, rides the kicks home and wins', () => {
    const run = job();
    const types = (e: { type: string }[]) => e.map((x) => x.type);

    // Level 1: the totem, the kick on the way down, then the machine
    expect(types(visit(run, 0, 'totem'))).toEqual(['pickup']);
    expect(types(visit(run, 0, 'kick'))).toEqual(['pickup']);
    expect(run.hasTotem).toBe(true);
    expect(types(visit(run, 0, 'machine'))).toEqual(['under']);
    const machine1 = item(run, 0, 'machine');
    expect(run.goUnder()).toEqual(SPAWN);
    expect(run.depth).toBe(1);

    // Level 2: no kick found here yet, so K does nothing
    expect(run.kick().type).toBe('none');
    visit(run, 1, 'kick');
    run.update(DT, SPAWN.x, SPAWN.z, false);
    expect(types(visit(run, 1, 'machine'))).toEqual(['under']);
    run.goUnder();
    expect(run.depth).toBe(TARGET_DEPTH);

    // Level 3: plant, then the kick
    const target = item(run, 2, 'target');
    for (let t = 0; t < PLANT_TIME - 0.1; t += DT) run.update(DT, target.x + 1, target.z, false);
    expect(run.planted).toBe(false);
    expect(run.objective()).toMatch(/Planting/);
    const ev = types(run.update(0.2, target.x + 1, target.z, false));
    expect(ev).toEqual(['planted']);
    visit(run, 2, 'kick');

    // Ride the kicks home: you wake each time beside the machine you went under at
    const k3 = run.kick();
    expect(k3.type).toBe('up');
    expect(run.depth).toBe(1);
    const k2 = run.kick();
    expect(k2.type).toBe('up');
    if (k2.type === 'up') expect(Math.hypot(k2.at.x - machine1.x, k2.at.z - machine1.z)).toBeLessThan(5);
    expect(run.depth).toBe(0);
    // waking beside the machine doesn't send you straight back under
    expect(run.update(DT, machine1.x, machine1.z, false)).toEqual([]);
    expect(run.kick()).toEqual({ type: 'wake', outcome: 'won' });
    expect(run.outcome).toBe('won');
  });

  it('needs the totem to go under to Level 3', () => {
    const run = job();
    visit(run, 0, 'machine');
    run.goUnder();
    expect(visit(run, 1, 'machine').map((e) => e.type)).toEqual(['needTotem']);
    expect(run.objective()).toMatch(/totem/);
  });

  it('asks before waking from Level 1 without the idea, then fails the job', () => {
    const run = job();
    visit(run, 0, 'kick');
    expect(run.kick().type).toBe('confirm');
    idle(run, 1);
    expect(run.kick()).toEqual({ type: 'wake', outcome: 'woke' });
  });

  it('only lets a level’s kick work on that level', () => {
    const run = job();
    visit(run, 0, 'kick');
    visit(run, 0, 'machine');
    run.goUnder();
    expect(run.kick().type).toBe('none');
  });

  it('picks things up only within reach', () => {
    const run = job();
    const t = item(run, 0, 'totem');
    run.update(DT, t.x + REACH + 0.2, t.z, false);
    expect(run.hasTotem).toBe(false);
    run.update(DT, t.x + REACH - 0.2, t.z, false);
    expect(run.hasTotem).toBe(true);
  });
});
