import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CLIP_HEIGHT, mirrorCamera } from '../src/fx/reflection';

/** A walker's camera: eye height, looking a little down the street. */
function walker(yaw: number, pitch: number, roll = 0): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(74, 16 / 9, 0.1, 9000);
  cam.position.set(12, 1.6, -30);
  cam.rotation.set(pitch, yaw, roll, 'YXZ');
  cam.updateMatrixWorld();
  return cam;
}

function screen(cam: THREE.PerspectiveCamera, p: THREE.Vector3): THREE.Vector2 {
  const v = p.clone().project(cam);
  return new THREE.Vector2(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
}

function clipSpace(cam: THREE.PerspectiveCamera, p: THREE.Vector3): THREE.Vector4 {
  return new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
}

describe('the wet-street mirror', () => {
  it('sees each point of the street exactly where the camera does, flipped left to right', () => {
    for (const [yaw, pitch, roll] of [
      [0, -0.1, 0],
      [1.2, -0.3, 0],
      [-2.5, 0.05, 0.4],
    ]) {
      const main = walker(yaw, pitch, roll);
      const mirror = new THREE.PerspectiveCamera();
      const tex = new THREE.Matrix4();
      mirrorCamera(main, mirror, tex);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(main.quaternion);
      for (const [ahead, side] of [
        [6, 0],
        [20, 4],
        [45, -9],
      ]) {
        const p = main.position.clone().addScaledVector(fwd, ahead);
        p.x += side * Math.cos(yaw);
        p.z -= side * Math.sin(yaw);
        p.y = 0;
        const s = screen(main, p);
        const t = new THREE.Vector4(p.x, 0, p.z, 1).applyMatrix4(tex);
        expect(t.x / t.w).toBeCloseTo(1 - s.x, 5);
        expect(t.y / t.w).toBeCloseTo(s.y, 5);
      }
    }
  });

  it('cuts away the street and everything under it, and keeps what stands on it', () => {
    const main = walker(0.4, -0.15);
    const mirror = new THREE.PerspectiveCamera();
    mirrorCamera(main, mirror, new THREE.Matrix4());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(main.quaternion).setY(0).normalize();
    for (const ahead of [5, 30, 200]) {
      const at = (y: number) => main.position.clone().addScaledVector(fwd, ahead).setY(y);
      const street = clipSpace(mirror, at(0));
      const below = clipSpace(mirror, at(-3));
      const facade = clipSpace(mirror, at(CLIP_HEIGHT + 2));
      expect(street.z).toBeLessThan(-street.w);
      expect(below.z).toBeLessThan(-below.w);
      expect(facade.z).toBeGreaterThan(-facade.w);
      expect(facade.z).toBeLessThan(facade.w);
    }
  });
});
