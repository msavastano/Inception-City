import * as THREE from 'three';
import { U } from '../city/materials';

/** Geometry this close to the street is the street itself, and is cut from the mirror. */
export const CLIP_HEIGHT = 0.15;

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector2(1, 1);
const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const rot = new THREE.Matrix4();
const eye = new THREE.Vector3();
const look = new THREE.Vector3();
const onStreet = new THREE.Vector3();
const plane = new THREE.Plane();
const clip = new THREE.Vector4();
const q = new THREE.Vector4();

/**
 * Point `mirror` at the main camera's reflection in the street (height 0),
 * with an oblique near plane (Lengyel) so that nothing below `clipHeight` is
 * drawn. Writes the matrix that takes a world position to its coordinates in
 * the mirror image (0..1) into `texMatrix`. Both cameras must have no parent.
 */
export function mirrorCamera(main: THREE.PerspectiveCamera, mirror: THREE.PerspectiveCamera, texMatrix: THREE.Matrix4, clipHeight = CLIP_HEIGHT): void {
  main.updateMatrixWorld();
  eye.setFromMatrixPosition(main.matrixWorld);
  // position, view direction and up all flip in y
  rot.extractRotation(main.matrixWorld);
  look.set(0, 0, -1).applyMatrix4(rot).add(eye);
  mirror.position.set(eye.x, -eye.y, eye.z);
  mirror.up.set(0, 1, 0).applyMatrix4(rot);
  mirror.up.y = -mirror.up.y;
  mirror.lookAt(look.x, -look.y, look.z);
  mirror.near = main.near;
  mirror.far = main.far;
  mirror.updateMatrixWorld();
  mirror.projectionMatrix.copy(main.projectionMatrix);
  texMatrix.copy(BIAS).multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);

  // Replace the near plane with the street (the oblique plane only changes depth, not the image).
  plane.setFromNormalAndCoplanarPoint(UP, onStreet.set(0, clipHeight, 0));
  plane.applyMatrix4(mirror.matrixWorldInverse);
  clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  const e = mirror.projectionMatrix.elements;
  q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
  clip.multiplyScalar(2 / clip.dot(q));
  e[2] = clip.x;
  e[6] = clip.y;
  e[10] = clip.z + 1;
  e[14] = clip.w;
  mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
}

/**
 * Wet streets: the city mirrored in the rain.
 *
 * The street (height 0) is treated as one large mirror. Each frame the scene
 * is rendered again from the camera's reflection below the street, at a
 * fraction of the screen's resolution, with an oblique near plane that cuts
 * away the street and everything under it. The ground shader looks the result
 * up per pixel: sharp in puddles (rippled by raindrops), blurred and smeared
 * into streaks on wet asphalt. Folded parts of the street are not level, so
 * they keep their plain sky reflection.
 */
export class WetReflection {
  private target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  private camera = new THREE.PerspectiveCamera();
  private blank = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  private size = new THREE.Vector2();

  constructor() {
    this.blank.needsUpdate = true;
    U.tReflect.value = this.blank;
  }

  /**
   * Render the mirror for this frame. `scale` is the fraction of the drawing
   * buffer's resolution (0 turns it off); `strength` fades it in and out.
   * Objects in `hidden` are left out of the reflection.
   */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, main: THREE.PerspectiveCamera, scale: number, strength: number, hidden: THREE.Object3D[]): void {
    main.updateMatrixWorld();
    if (scale <= 0 || strength <= 0.01 || main.matrixWorld.elements[13] < CLIP_HEIGHT * 2) {
      U.uReflOn.value = 0;
      U.tReflect.value = this.blank;
      return;
    }

    renderer.getDrawingBufferSize(this.size).multiplyScalar(scale).floor().max(ONE);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);

    mirrorCamera(main, this.camera, U.uReflMatrix.value);

    // The street must not sample the mirror while the mirror is being drawn.
    U.tReflect.value = this.blank;
    U.uReflOn.value = 0;
    const shown = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const autoShadow = renderer.shadowMap.autoUpdate;
    // last frame's shadow maps are fine for a blurred reflection
    renderer.shadowMap.autoUpdate = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = autoShadow;
    hidden.forEach((o, i) => (o.visible = shown[i]));

    U.tReflect.value = this.target.texture;
    U.uReflOn.value = Math.min(1, strength);
  }
}
