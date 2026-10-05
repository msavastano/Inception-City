import * as THREE from 'three';
import { MAX_FOLDS } from '../core/config';
import {
  BUILDING_FRAG_COLOR,
  BUILDING_FRAG_EMISSIVE,
  BUILDING_FRAG_HEAD,
  BUILDING_FRAG_METAL,
  BUILDING_FRAG_ROUGH,
  BUILDING_VERT_HEAD,
  GROUND_FRAG_COLOR,
  GROUND_FRAG_EMISSIVE,
  GROUND_FRAG_HEAD,
  GROUND_FRAG_ROUGH,
  GROUND_FRAG_WET,
  GROUND_VERT_HEAD,
  PICK_FRAG,
  PROP_FRAG_COLOR,
  PROP_FRAG_EMISSIVE,
  PROP_FRAG_HEAD,
  PROP_FRAG_METAL,
  PROP_FRAG_ROUGH,
  PROP_VERT_HEAD,
} from './shaders';

/**
 * One set of uniform objects shared by every folded material, so a fold, a
 * ripple or a change of dream level is a handful of uniform writes per frame
 * no matter how large the city is.
 */
export const U = {
  uFoldCount: { value: 0 },
  uFoldA: { value: new Float32Array(MAX_FOLDS * 4) },
  uFoldB: { value: new Float32Array(MAX_FOLDS * 4) },
  uTime: { value: 0 },
  uRipple: { value: new THREE.Vector4(0, 0, -100, 0) },
  uLimbo: { value: 0 },
  uNight: { value: 0 },
  uSnow: { value: 0 },
  uWet: { value: 0 },
  uShowCreases: { value: 1 },
  uCrease: { value: new THREE.Vector4(0, 0, 0, 1) },
  uCreaseOn: { value: 0 },
  uBrush: { value: new THREE.Vector4(0, 0, 30, 0) },
  uSeaColor: { value: new THREE.Color(0.32, 0.38, 0.42) },
  uFoliageA: { value: new THREE.Color(0.22, 0.36, 0.14) },
  uFoliageB: { value: new THREE.Color(0.38, 0.5, 0.2) },
  // The wet-street mirror (src/fx/reflection.ts).
  tReflect: { value: null as THREE.Texture | null },
  uReflMatrix: { value: new THREE.Matrix4() },
  uReflOn: { value: 0 },
};

type Kind = 'building' | 'ground' | 'prop';

const SPEC: Record<Kind, { vert: string; frag: string; call: string; replace: [string, string][] }> = {
  building: {
    vert: BUILDING_VERT_HEAD,
    frag: BUILDING_FRAG_HEAD,
    call: 'buildingVertex',
    replace: [
      ['#include <color_fragment>', BUILDING_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', BUILDING_FRAG_ROUGH],
      ['#include <metalnessmap_fragment>', BUILDING_FRAG_METAL],
      ['#include <emissivemap_fragment>', BUILDING_FRAG_EMISSIVE],
    ],
  },
  ground: {
    vert: GROUND_VERT_HEAD,
    frag: GROUND_FRAG_HEAD,
    call: 'groundVertex',
    replace: [
      ['#include <color_fragment>', GROUND_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', GROUND_FRAG_ROUGH],
      ['#include <emissivemap_fragment>', GROUND_FRAG_EMISSIVE],
      ['#include <aomap_fragment>', GROUND_FRAG_WET],
    ],
  },
  prop: {
    vert: PROP_VERT_HEAD,
    frag: PROP_FRAG_HEAD,
    call: 'propVertex',
    replace: [
      ['#include <color_fragment>', PROP_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', PROP_FRAG_ROUGH],
      ['#include <metalnessmap_fragment>', PROP_FRAG_METAL],
      ['#include <emissivemap_fragment>', PROP_FRAG_EMISSIVE],
    ],
  },
};

function must(src: string, find: string): string {
  if (!src.includes(find)) throw new Error(`shader patch target missing: ${find}`);
  return find;
}

/** A MeshStandardMaterial whose vertices are folded and whose surface is painted procedurally. */
export function foldedMaterial(kind: Kind, params: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const spec = SPEC[kind];
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...params });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    let v = shader.vertexShader;
    v = v.replace(must(v, '#include <common>'), `#include <common>\n${spec.vert}`);
    v = v.replace(
      must(v, '#include <beginnormal_vertex>'),
      `vec3 foldedP; vec3 objectNormal; ${spec.call}(foldedP, objectNormal);`,
    );
    v = v.replace(must(v, '#include <begin_vertex>'), 'vec3 transformed = foldedP;');
    shader.vertexShader = v;
    let f = shader.fragmentShader;
    f = f.replace(must(f, '#include <common>'), `#include <common>\n${spec.frag}`);
    for (const [find, repl] of spec.replace) f = f.replace(must(f, find), repl);
    shader.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => `inception-${kind}`;
  return mat;
}

/** Shadow-map depth material with the same folding, so folded flaps cast true shadows. */
export function foldedDepthMaterial(kind: Kind): THREE.MeshDepthMaterial {
  const spec = SPEC[kind];
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    let v = shader.vertexShader;
    v = v.replace(must(v, '#include <common>'), `#include <common>\n${spec.vert}`);
    v = v.replace(
      must(v, '#include <begin_vertex>'),
      `vec3 foldedP; vec3 foldedN; ${spec.call}(foldedP, foldedN); vec3 transformed = foldedP;`,
    );
    shader.vertexShader = v;
  };
  mat.customProgramCacheKey = () => `inception-depth-${kind}`;
  return mat;
}

/** Renders fabric coordinates (x, height, z, kind) for GPU picking on folded geometry. */
export function pickMaterial(kind: Exclude<Kind, 'prop'>, kindId: number): THREE.ShaderMaterial {
  const spec = SPEC[kind];
  return new THREE.ShaderMaterial({
    uniforms: { ...U, uKind: { value: kindId } },
    vertexShader: `${spec.vert}
varying vec3 vPickFabric;
void main() {
  vec3 P; vec3 N;
  ${spec.call}(P, N);
  vPickFabric = vFabric;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`,
    fragmentShader: PICK_FRAG,
    side: THREE.DoubleSide,
  });
}
