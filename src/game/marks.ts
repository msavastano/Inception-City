import * as THREE from 'three';
import { beamGeometry, gramophoneGeometry, personGeometry, sleepMachineGeometry, totemGeometry } from '../city/geometry';
import { U } from '../city/materials';
import { FOLD_GLSL } from '../city/shaders';
import { Item, ItemKind } from './heist';

/** Beam colours: a cold sleep machine, a gold kick, a white totem, a red target. */
export const BEAM_COLOR: Record<ItemKind, [number, number, number]> = {
  machine: [0.12, 0.5, 1.0],
  kick: [1.0, 0.6, 0.12],
  totem: [1.0, 1.0, 1.0],
  target: [1.0, 0.14, 0.08],
};
const BEAM_HEIGHT = 170;
const BEAM_STRENGTH = 1.6;

/** Prop kinds as the prop shader knows them (iState.y). */
const STILL = 0;
const PERSON = 2;
const TOP = 3;

/** One prop of one shape, drawn with the city's folded prop material so it sits on the folds like everything else. */
class PropSlot {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.InstancedBufferGeometry();
  private pos = new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
  private param = new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
  private state = new THREE.InstancedBufferAttribute(new Float32Array(4), 4);

  constructor(
    base: THREE.BufferGeometry,
    material: THREE.Material,
    depth: THREE.Material,
    private kind: number,
    private scale: number,
    private tone = 0.5,
    private spin = 0,
  ) {
    for (const [name, attr] of Object.entries(base.attributes)) this.geometry.setAttribute(name, attr);
    this.geometry.setAttribute('iPosYaw', this.pos);
    this.geometry.setAttribute('iParam', this.param);
    this.geometry.setAttribute('iState', this.state);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Stand it at a fabric point; it grows in from birth (dream time). */
  show(x: number, z: number, yaw: number, birth: number): void {
    this.pos.array.set([x, 0, z, yaw]);
    // still props grow in from their birth time; people use the slot as a (frozen) walk phase
    this.param.array.set([this.scale, this.tone, this.kind === PERSON ? 0 : birth, this.spin]);
    this.state.array.set([0, this.kind, 0, 0]);
    for (const a of [this.pos, this.param, this.state]) a.needsUpdate = true;
    this.geometry.instanceCount = 1;
  }

  hide(): void {
    this.geometry.instanceCount = 0;
  }
}

const BEAM_VERT = /* glsl */ `
${FOLD_GLSL}
attribute vec4 iBeam;      // fabric x, z, height, strength
attribute vec3 iBeamColor;
varying float vH;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 P = vec3(iBeam.x, 0.0, iBeam.y) + vec3(position.x, position.y * iBeam.z, position.z);
  vec3 N = normal;
  // rigidly, like a prop: a beam on a flap hanging overhead shines down out of the sky
  applyFolds(iBeam.xy, P, N);
  vH = position.y;
  vCol = iBeamColor * iBeam.w;
  vN = N;
  vV = cameraPosition - P;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const BEAM_FRAG = /* glsl */ `
uniform float uTime;
varying float vH;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vV;
void main() {
  // brightest down the middle of the tube, fading towards the top, and out of the way up close
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float core = facing * facing;
  float fade = (1.0 - vH) * (1.0 - vH) * smoothstep(0.0, 0.015, vH);
  float near = smoothstep(5.0, 40.0, length(vV));
  float shimmer = 0.85 + 0.15 * sin(vH * 70.0 - uTime * 3.0);
  float a = clamp(core * fade * near * shimmer * 1.2, 0.0, 0.9);
  // premultiplied: tints what is behind it (reads against a bright sky) and glows a little on top
  gl_FragColor = vec4(vCol * a, a);
}`;

/**
 * What Heist mode puts in the city: the sleep machine, the kick, the totem and
 * the target, each with a beam of light that rises from it (through the folds,
 * so a machine on a flap overhead hangs a beam down out of the sky).
 */
export class HeistMarks {
  readonly group = new THREE.Group();
  private props: Record<ItemKind, PropSlot>;
  private beamGeo = new THREE.InstancedBufferGeometry();
  private beamAttr = new THREE.InstancedBufferAttribute(new Float32Array(4 * 4), 4);
  private beamColor = new THREE.InstancedBufferAttribute(new Float32Array(4 * 3), 3);

  constructor(material: THREE.Material, depth: THREE.Material) {
    this.props = {
      machine: new PropSlot(sleepMachineGeometry(), material, depth, STILL, 1.4),
      kick: new PropSlot(gramophoneGeometry(), material, depth, STILL, 1.3),
      // the totem is the Circus monument in miniature, spinning on its point
      totem: new PropSlot(totemGeometry(), material, depth, TOP, 0.045, 0.5, 9),
      // the target wears the darkest coat (tone 0) and stands a little taller than the crowd
      target: new PropSlot(personGeometry(), material, depth, PERSON, 1.08, 0.02),
    };
    for (const p of Object.values(this.props)) this.group.add(p.mesh);

    const base = beamGeometry();
    for (const [name, attr] of Object.entries(base.attributes)) this.beamGeo.setAttribute(name, attr);
    this.beamGeo.setIndex(base.index);
    this.beamGeo.setAttribute('iBeam', this.beamAttr);
    this.beamGeo.setAttribute('iBeamColor', this.beamColor);
    this.beamGeo.instanceCount = 0;
    const beamMat = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
    });
    const beams = new THREE.Mesh(this.beamGeo, beamMat);
    beams.frustumCulled = false;
    beams.renderOrder = 2;
    this.group.add(beams);
  }

  /**
   * Show one level's things. Taken things vanish; a planted target keeps standing
   * but loses its beam. birth: when the level appeared (dream time), so things grow in once.
   */
  show(items: readonly Item[], planted: boolean, birth: number): void {
    for (const p of Object.values(this.props)) p.hide();
    let n = 0;
    for (const it of items) {
      const keep = it.kind === 'target' || !it.taken;
      if (!keep) continue;
      this.props[it.kind].show(it.x, it.z, it.yaw, birth);
      if (it.kind === 'target' && planted) continue;
      this.beamAttr.array.set([it.x, it.z, BEAM_HEIGHT, BEAM_STRENGTH], n * 4);
      this.beamColor.array.set(BEAM_COLOR[it.kind], n * 3);
      n++;
    }
    this.beamAttr.needsUpdate = true;
    this.beamColor.needsUpdate = true;
    this.beamGeo.instanceCount = n;
  }

  clear(): void {
    for (const p of Object.values(this.props)) p.hide();
    this.beamGeo.instanceCount = 0;
  }
}
