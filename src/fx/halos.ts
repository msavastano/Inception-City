import * as THREE from 'three';
import { LANTERN_HEIGHT } from '../core/config';
import { U } from '../city/materials';
import { SlabPool } from '../city/pool';
import { FOLD_GLSL } from '../city/shaders';

const HALO_VERT = /* glsl */ `
attribute vec4 iPosYaw;  // the lamp's instance data (see PROP_VERT_HEAD)
attribute vec4 iParam;
uniform vec4 uHalo;      // radius (m), strength, where the city's edge starts and finishes dissolving (m)
uniform vec4 uHaze;
varying vec2 vUv;
varying float vFade;
${FOLD_GLSL}

void main() {
  vUv = position.xy;
  if (iParam.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vFade = 0.0; return; }
  // the lantern, placed exactly as the prop shader places it: grown in, sunk in Limbo, folded at the lamp's foot
  float born = smoothstep(iParam.z, iParam.z + 1.4, uTime);
  vec3 P = iPosYaw.xyz + vec3(0.0, ${LANTERN_HEIGHT.toFixed(2)} * iParam.x * born, 0.0);
  P.y -= limboDecay(iPosYaw.xz, 0.6) * 14.0;
  P.y += ripple(P.xz);
  vec3 N = vec3(0.0, 1.0, 0.0);
  applyFolds(iPosYaw.xz, P, N);
  vec4 mv = modelViewMatrix * vec4(P, 1.0);
  float dist = length(mv.xyz);
  // far lamps keep a glow a few pixels wide
  mv.xy += position.xy * uHalo.x * (1.0 + min(dist / 120.0, 1.5));
  // Drawn a little nearer than it is (same place on screen), so the wall a metre behind the lamp does not slice the glow.
  mv.xyz *= 1.0 - clamp(0.15 * dist, 0.3, 2.5) / max(dist, 1.0);
  gl_Position = projectionMatrix * mv;
  // it thins with the air like everything else, goes with the city's edge, and steps aside when you walk through it
  vFade = born * exp(-dist * (uHaze.x + uHaze.y * 0.8)) * (1.0 - smoothstep(uHalo.z, uHalo.w, dist)) * smoothstep(0.8, 3.5, dist);
}`;

const HALO_FRAG = /* glsl */ `
uniform vec4 uHalo;
varying vec2 vUv;
varying float vFade;
void main() {
  float r = length(vUv);
  float skirt = max(1.0 - r, 0.0);
  float glow = exp(-r * r * 16.0) * 0.8 + skirt * skirt * skirt * 0.2;
  gl_FragColor = vec4(vec3(1.0, 0.74, 0.44) * glow * uHalo.y * vFade, 1.0);
}`;

/**
 * Lamp halos: the glow of the air round every lit lantern, thicker in rain and mist.
 *
 * One camera-facing quad per street lamp. The quads read the lamps' own instance data
 * (the same buffers, not copies), so the halos cost one draw call, drawn only at night,
 * and follow the lamps through streaming, folding and Limbo without any bookkeeping.
 */
export class LampHalos {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.InstancedBufferGeometry();
  private uHalo = new THREE.Vector4(2, 0, 500, 800);

  constructor(private lamps: SlabPool) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    this.geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.geometry.setAttribute('iPosYaw', lamps.attrs.iPosYaw);
    this.geometry.setAttribute('iParam', lamps.attrs.iParam);
    const material = new THREE.ShaderMaterial({
      uniforms: { ...U, uHalo: { value: this.uHalo } },
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /**
   * strength: 0 by day, 1 at night with the glow dial at 1. air: the level's haze and mist added up (thicker air, wider halos).
   * edgeNear and edgeFar: where the streamed city dissolves into the sky.
   */
  update(strength: number, air: number, edgeNear: number, edgeFar: number): void {
    this.mesh.visible = strength > 0.02;
    this.geometry.instanceCount = this.lamps.geometry.instanceCount;
    this.uHalo.set(Math.min(1.1 + 0.42 * air, 2.8), strength, edgeNear, edgeFar);
  }
}
