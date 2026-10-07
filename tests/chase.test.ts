import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHUNK } from '../src/core/config';
import { foldPoint } from '../src/core/fold';
import { CityStreamer } from '../src/city/streamer';
import { CHASE, boomFollow, clearance } from '../src/modes/chase';
import { DreamerBody, strideAngles } from '../src/world/dreamer';
import { HALL_HALF, Hallway } from '../src/world/hallway';

describe('the third-person camera boom', () => {
  it('goes all the way out when nothing is in the way', () => {
    expect(clearance({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 2, z: -4 }, () => false)).toBe(1);
  });

  it('stops just short of a wall', () => {
    // a wall across the boom 3 m behind the head
    const t = clearance({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 1.6, z: -4 }, (_x, _y, z) => z < -3);
    expect(t).toBeLessThanOrEqual(0.75);
    expect(t).toBeGreaterThan(0.74);
  });

  it('cannot step over even the thinnest thing it is blocked by', () => {
    // anything solid is at least a building footprint widened by the skin on both sides
    const thin = 2 * CHASE.skin;
    const at = CHASE.back * 0.61;
    const t = clearance({ x: 0, y: 0, z: 0 }, { x: CHASE.back, y: 0, z: 0 }, (x) => x > at && x < at + thin);
    expect(t * CHASE.back).toBeLessThanOrEqual(at);
    expect(t * CHASE.back).toBeGreaterThan(at - 0.02);
  });

  it('pulls in at once and lets out gently', () => {
    expect(boomFollow(1, 0.2, 1 / 60)).toBe(0.2);
    const out = boomFollow(0.2, 1, 1 / 60);
    expect(out).toBeGreaterThan(0.2);
    expect(out).toBeLessThan(0.3);
  });

  it('keeps out of the buildings of a real city, whichever way you look', () => {
    const streamer = new CityStreamer(4242, 4);
    let checked = 0;
    let pulledIn = 0;
    for (let i = 0; i < 400; i++) {
      // a walker somewhere on the sheet, pushed out of buildings the way Dream Walk does
      const p = streamer.collide(((i * 37) % 97) * 3.1 - 150, ((i * 53) % 89) * 3.3 - 140, 0.35);
      const yaw = i * 0.7;
      const head = { x: p.x, y: CHASE.head, z: p.z };
      const end = { x: p.x - Math.sin(yaw) * CHASE.back, y: CHASE.head + CHASE.rise, z: p.z - Math.cos(yaw) * CHASE.back };
      const t = clearance(head, end, (x, _y, z) => streamer.solid(x, z, CHASE.skin));
      const cx = head.x + (end.x - head.x) * t;
      const cz = head.z + (end.z - head.z) * t;
      // the camera is clear of every footprint by its skin, less the bisection's last step
      expect(streamer.solid(cx, cz, CHASE.skin - 0.01)).toBe(false);
      if (t < 1) pulledIn++;
      checked++;
    }
    expect(checked).toBe(400);
    // plenty of those spots had a building behind them
    expect(pulledIn).toBeGreaterThan(40);
    expect(CHUNK).toBeGreaterThan(CHASE.back);
  });

  it('stays on the street side of a curl when folded at its own spot', () => {
    // the street curls up 20 m ahead; a camera 1.9 m above the sheet, anywhere along it, stays 1.9 m off the street
    const folds = [{ hx: 0, hz: 20, nx: 0, nz: 1, angle: Math.PI, radius: 12 }];
    for (let z = 0; z < 70; z += 2.5) {
      const cam = new THREE.Vector3(0, 1.9, z);
      foldPoint(folds, 0, z, cam);
      const street = new THREE.Vector3(0, 0, z);
      foldPoint(folds, 0, z, street);
      expect(cam.distanceTo(street)).toBeCloseTo(1.9, 5);
    }
  });
});

describe('the camera inside the rotating hallway', () => {
  function rider(angle: number): Hallway {
    const h = new Hallway();
    h.spawn(0, 0, false, 0, false);
    h.settle();
    h.update(0, 0, []);
    h.angle = angle;
    h.capture(0, 0);
    return h;
  }

  it('moves points off the walls and keeps the ones already clear', () => {
    const h = rider(0.6);
    const p = new THREE.Vector3(9, -9, 3);
    h.clampInside(p, CHASE.skin);
    expect(h.inside(p, CHASE.skin - 1e-6)).toBe(true);
    expect(p.z).toBe(3);
    const q = new THREE.Vector3(0.5, -0.5, 1);
    expect(h.clampInside(q.clone(), CHASE.skin).distanceTo(q)).toBe(0);
  });

  it('gives a right-handed view frame that pose() agrees with', () => {
    const h = rider(1.1);
    const look = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    h.viewAxes(0.4, -0.3, look, right, up);
    expect(look.length()).toBeCloseTo(1, 6);
    expect(look.dot(right)).toBeCloseTo(0, 6);
    expect(look.dot(up)).toBeCloseTo(0, 6);
    expect(new THREE.Vector3().crossVectors(right, up).dot(look)).toBeCloseTo(-1, 6);
    const q = new THREE.Quaternion();
    h.pose(0.4, -0.3, new THREE.Vector3(), q);
    const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(camForward.distanceTo(look.transformDirection(h.basis))).toBeLessThan(1e-6);
  });

  it('never swings the boom through a wall', () => {
    const h = rider(0);
    const look = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    for (let i = 0; i < 64; i++) {
      h.angle = i * 0.37;
      h.viewAxes(i * 0.9, Math.sin(i) * 1.2, look, right, up);
      const head = h.clampInside(h.rider!.p.clone().addScaledVector(h.rider!.up, CHASE.head), CHASE.skin + 0.01);
      const end = head.clone().addScaledVector(right, CHASE.side).addScaledVector(up, CHASE.rise).addScaledVector(look, -CHASE.back);
      const probe = new THREE.Vector3();
      const t = clearance(head, end, (x, y, z) => !h.inside(probe.set(x, y, z), CHASE.skin));
      expect(h.inside(head.clone().lerp(end, t), CHASE.skin - 1e-3)).toBe(true);
      expect(HALL_HALF).toBeGreaterThan(CHASE.head);
    }
  });
});

describe('the dreamer’s body', () => {
  it('stands still with its legs together and strides with them apart', () => {
    const still = strideAngles(0, 1.2);
    for (const a of [...still.thigh, ...still.arm]) expect(a).toBeCloseTo(0, 9);
    expect(still.drop).toBe(0);
    const walk = strideAngles(5.5, Math.PI / 2);
    expect(walk.thigh[0]).toBeGreaterThan(0.3);
    expect(walk.thigh[1]).toBeCloseTo(-walk.thigh[0]);
    // the arms swing against the legs
    expect(Math.sign(walk.arm[0])).toBe(-Math.sign(walk.thigh[0]));
    const run = strideAngles(13, Math.PI / 2);
    expect(run.thigh[0]).toBeGreaterThan(walk.thigh[0]);
    expect(run.lean).toBeGreaterThan(walk.lean);
    for (let ph = 0; ph < 7; ph += 0.3) {
      const s = strideAngles(9, ph);
      expect(s.knee[0]).toBeGreaterThanOrEqual(0);
      expect(s.knee[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it('is placed upright on the surface, facing where it is told', () => {
    const body = new DreamerBody();
    // standing on a wall: up is +x, facing -z
    const up = new THREE.Vector3(1, 0, 0);
    const forward = new THREE.Vector3(0, 0, -1);
    body.place(new THREE.Vector3(3, 4, 5), up, forward);
    const m = body.group.matrix;
    expect(new THREE.Vector3(0, 1, 0).transformDirection(m).distanceTo(up)).toBeLessThan(1e-9);
    expect(new THREE.Vector3(0, 0, 1).transformDirection(m).distanceTo(forward)).toBeLessThan(1e-9);
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([3, 4, 5]);
    for (let i = 0; i < 30; i++) body.animate(1 / 60, { speed: 6, phase: i * 0.2, grounded: i < 15, lookYaw: 0.3, lookPitch: -0.2 });
    body.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(body.group);
    // about a person's height, along the wall's normal
    expect(box.max.x - box.min.x).toBeGreaterThan(1.5);
    expect(box.max.x - box.min.x).toBeLessThan(2);
  });
});
