import { describe, expect, it } from 'vitest';
import { COLLAPSE_RADIUS } from '../src/core/config';
import { Style } from '../src/city/generator';
import { U } from '../src/city/materials';
import type { BuildingBox } from '../src/city/streamer';
import { Collapse, HEAL, KICK_AT, SLOW_MOTION, WAVE_SPEED, breakChance, planShards, slowMotion } from '../src/world/collapse';

const DT = 1 / 60;

/**
 * A straight Haussmann street along z at x = 0: a terrace of 20 m lots, 14 m
 * deep, on each side, from z = -150 to 150. Neighbouring lots share their walls.
 */
function street(): BuildingBox[] {
  const out: BuildingBox[] = [];
  for (const side of [-1, 1]) {
    for (let z = -150; z < 150; z += 20) {
      out.push({ x: side * 14, z: z + 10, w: 14, d: 20, y0: 0, y1: 22, style: Style.Haussmann, color: [0.86, 0.8, 0.68], seed: 0.5, sink: 22 });
    }
  }
  return out;
}

function shards(plan: ReturnType<typeof planShards>) {
  return Array.from({ length: plan.count }, (_, i) => ({
    x: plan.aOrigin[i * 4],
    y: plan.aOrigin[i * 4 + 1],
    z: plan.aOrigin[i * 4 + 2],
    t0: plan.aOrigin[i * 4 + 3],
    vx: plan.aVel[i * 4],
    vz: plan.aVel[i * 4 + 2],
    yaw: plan.aSpin[i * 4 + 3],
  }));
}

describe('the café explosion', () => {
  it('runs a moment at full speed, then in slow motion', () => {
    expect(slowMotion(0)).toBe(1);
    expect(slowMotion(KICK_AT - 0.5)).toBeCloseTo(SLOW_MOTION, 5);
    for (let t = 0; t < KICK_AT; t += 0.05) expect(slowMotion(t + 0.05)).toBeLessThanOrEqual(slowMotion(t));
  });

  it('kicks on its own once the city has hung in the air, then heals and lets time run again', () => {
    const c = new Collapse(16);
    c.start(0, 0, planShards([], 0, 0, 16, 1));
    expect(c.blasting).toBe(true);
    let t = 0;
    while (!c.update(DT)) {
      t += DT;
      expect(t).toBeLessThan(KICK_AT + 0.1);
    }
    expect(t).toBeGreaterThan(KICK_AT - 0.1);
    expect(c.timeScale).toBeCloseTo(SLOW_MOTION, 3);
    // the blast wave has run out through the walls by the time of the kick
    expect(U.uBlast.value.z).toBeGreaterThan(COLLAPSE_RADIUS * 0.8);

    c.release();
    expect(c.blasting).toBe(false);
    for (let s = 0; s < HEAL + 0.1; s += DT) c.update(DT);
    expect(c.active).toBe(false);
    expect(c.timeScale).toBe(1);
    expect(U.uBlast.value.w).toBe(0);
  });

  it('throws pieces off the walls around the blast, never from walls pressed against a neighbour', () => {
    const plan = planShards(street(), 0, 0, 3000, 7);
    expect(plan.count).toBeGreaterThan(2500);
    for (const s of shards(plan)) {
      expect(Math.hypot(s.x, s.z)).toBeLessThan(COLLAPSE_RADIUS + 1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(22);
      // on a street front (|x| = 7) or a courtyard back (|x| = 21), just outside it
      const ax = Math.abs(s.x);
      const onFront = ax > 6 && ax < 7;
      const onBack = ax > 21 && ax < 22;
      expect(onFront || onBack).toBe(true);
    }
  });

  it('sends most of them from the walls facing the blast, more of them close by', () => {
    const list = shards(planShards(street(), 0, 0, 3000, 7));
    const front = list.filter((s) => Math.abs(s.x) < 8).length;
    expect(front).toBeGreaterThan(list.length * 0.7);
    const near = list.filter((s) => Math.abs(s.z) < 40).length;
    const far = list.filter((s) => Math.abs(s.z) > 100 && Math.abs(s.z) < 140).length;
    expect(near).toBeGreaterThan(far * 2);
  });

  it('blows each piece outward from its wall, no sooner than the wave reaches it', () => {
    for (const s of shards(planShards(street(), 0, 0, 2000, 3))) {
      expect(s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw)).toBeGreaterThan(0);
      const dist = Math.hypot(s.x, s.z);
      expect(s.t0 * WAVE_SPEED).toBeGreaterThanOrEqual(dist - 0.5);
      expect(s.t0 * WAVE_SPEED).toBeLessThanOrEqual(dist + 10 * breakChance(dist) + 0.5);
    }
  });

  it('is the same for the same seed, and empty where there are no buildings', () => {
    const a = planShards(street(), 5, -12, 500, 11);
    const b = planShards(street(), 5, -12, 500, 11);
    expect(Array.from(a.aOrigin)).toEqual(Array.from(b.aOrigin));
    expect(planShards(street(), 2000, 0, 500, 11).count).toBe(0);
  });
});
