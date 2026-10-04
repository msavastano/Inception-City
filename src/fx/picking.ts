import * as THREE from 'three';

export interface FabricHit {
  /** Fabric coordinates of the surface under the cursor. */
  x: number;
  z: number;
  /** Height above the street, in metres. */
  h: number;
  /** 1 ground, 2 building. */
  kind: number;
}

/**
 * GPU picking on folded geometry. Raycasting can't see vertex-shader folding,
 * so instead we render one pixel of the scene with materials that output
 * fabric coordinates, and read it back. Works on a flap hanging upside down
 * overhead just as well as on the street at your feet.
 */
export class Picker {
  private target: THREE.WebGLRenderTarget;
  private buf = new Float32Array(4);
  private scene = new THREE.Scene();
  readonly supported: boolean;
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ray = new THREE.Raycaster();

  constructor(
    private renderer: THREE.WebGLRenderer,
    pickGroup: THREE.Object3D,
  ) {
    this.supported = renderer.extensions.has('EXT_color_buffer_float');
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
    this.scene.add(pickGroup);
  }

  pick(camera: THREE.PerspectiveCamera, clientX: number, clientY: number): FabricHit | null {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (!this.supported) return this.fallback(camera, (px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);

    const prevTarget = this.renderer.getRenderTarget();
    const prevColor = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    camera.setViewOffset(rect.width, rect.height, Math.floor(px), Math.floor(py), 1, 1);
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevColor, prevAlpha);
    camera.clearViewOffset();
    this.renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.buf);
    if (this.buf[3] < 0.5) return null;
    return { x: this.buf[0], h: this.buf[1], z: this.buf[2], kind: Math.round(this.buf[3]) };
  }

  /** Without float render targets, fall back to the unfolded street plane. */
  private fallback(camera: THREE.Camera, nx: number, ny: number): FabricHit | null {
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const p = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.plane, p)) return null;
    return { x: p.x, z: p.z, h: 0, kind: 1 };
  }
}
