import { describe, expect, it } from 'vitest';
import { BLOCK } from '../src/core/config';
import { foldPoint } from '../src/core/fold';
import { RIDE_MIN_BACK, RIDE_RADIUS, rideSpec } from '../src/modes/ride';
import { HALL_HALF, HALL_LENGTH, Hallway } from '../src/world/hallway';

const DT = 1 / 60;

function openHall(): Hallway {
  const h = new Hallway();
  h.spawn(0, 0, false, 0, false);
  h.settle();
  h.update(0, 0, []);
  return h;
}

/** The rider's position in the corridor's own (spinning) frame. */
function spinSpace(h: Hallway): [number, number] {
  const p = h.rider!.p;
  const c = Math.cos(h.angle);
  const s = Math.sin(h.angle);
  return [c * p.x + s * p.y, -s * p.x + c * p.y];
}

describe('the rotating hallway', () => {
  it('lets a rider stand still on the floor while it is not turning', () => {
    const h = openHall();
    h.capture(0, 0);
    const start = h.rider!.p.clone();
    for (let i = 0; i < 300; i++) {
      h.spin = 0;
      h.step(DT, 0, 0, 5.5, false, 0);
    }
    expect(h.rider!.face).toBe(0);
    expect(h.rider!.p.distanceTo(start)).toBeLessThan(0.01);
  });

  it('tumbles the rider across the walls as it turns, never letting them through one', () => {
    const h = openHall();
    h.capture(0, 0);
    const faces = new Set<number>();
    let t = 0;
    for (let i = 0; i < 60 * 60; i++) {
      t += DT;
      h.update(DT, t, []);
      h.step(DT, 0, 0, 5.5, false, 0);
      const r = h.rider!;
      expect(Number.isFinite(r.p.x + r.p.y + r.p.z + r.v.x + r.v.y + r.v.z)).toBe(true);
      const [sx, sy] = spinSpace(h);
      expect(Math.abs(sx)).toBeLessThanOrEqual(HALL_HALF + 1e-6);
      expect(Math.abs(sy)).toBeLessThanOrEqual(HALL_HALF + 1e-6);
      if (r.face >= 0) faces.add(r.face);
    }
    expect(h.angle).toBeGreaterThan(4 * Math.PI);
    expect(faces.size).toBe(4);
  });

  it('carries a rider up the floor until it is too steep, then lets them slide', () => {
    const h = openHall();
    h.capture(0, 0);
    let t = 0;
    let maxTilt = 0;
    for (let i = 0; i < 60 * 4; i++) {
      t += DT;
      h.spin = 0.5;
      h.angle += h.spin * DT;
      h.update(0, t, []);
      h.spin = 0.5;
      h.step(DT, 0, 0, 5.5, false, 0);
      if (h.rider!.face === 0) maxTilt = Math.max(maxTilt, h.angle);
    }
    // grip holds up to atan(0.6) ≈ 31°; past that the rider slides into the corner and onto the next wall
    expect(maxTilt).toBeGreaterThan(0.5);
    expect(maxTilt).toBeLessThan(Math.PI / 2);
  });

  it('lets the rider walk out of an open end and back onto the street', () => {
    const h = openHall();
    h.capture(1, 0);
    let out = false;
    for (let i = 0; i < 60 * 20 && !out; i++) {
      h.spin = 0;
      out = h.step(DT, 1, 0, 5.5, false, 0);
    }
    expect(out).toBe(true);
    const r = h.release()!;
    expect(r.z).toBeGreaterThan(HALL_LENGTH / 2);
    expect(Math.abs(r.x - 1)).toBeLessThan(0.05);
    expect(r.h).toBeGreaterThan(1);
    expect(h.rider).toBeNull();
  });

  it('takes in a dreamer who walks into an open end, but not one walking away', () => {
    const h = openHall();
    expect(h.entering(0.5, -HALL_LENGTH / 2 - 0.5, 0, 5)).not.toBeNull();
    expect(h.entering(0.5, -HALL_LENGTH / 2 - 0.5, 0, -5)).toBeNull();
    expect(h.entering(HALL_HALF + 4, -HALL_LENGTH / 2 - 0.5, 0, 5)).toBeNull();
  });
});

describe('riding the fold', () => {
  it('puts the hinge on a street far enough behind that the dreamer rides the rigid page', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.3]) {
      const x = 10.2;
      const z = 37;
      const r = rideSpec(x, z, yaw);
      const d = (x - r.hx) * r.nx + (z - r.hz) * r.nz;
      expect(d).toBeGreaterThanOrEqual(RIDE_MIN_BACK);
      expect(d).toBeLessThan(RIDE_MIN_BACK + BLOCK);
      const hingeCoord = r.nx !== 0 ? r.hx : r.hz;
      expect(Math.abs(hingeCoord / BLOCK - Math.round(hingeCoord / BLOCK))).toBeLessThan(1e-9);
    }
  });

  it('ends with the dreamer upside down, high above the city', () => {
    const r = rideSpec(10.2, 37, 0);
    const fold = { ...r, angle: r.target };
    const p = { x: 10.2, y: 0, z: 37 };
    const up = { x: 0, y: 1, z: 0 };
    foldPoint([fold], 10.2, 37, p, [up]);
    expect(p.y).toBeCloseTo(2 * RIDE_RADIUS, 6);
    expect(up.y).toBeCloseTo(-1, 6);
    expect(p.z).toBeLessThan(r.hz);
  });
});
