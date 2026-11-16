import * as THREE from 'three';
import { MAX_FOLDS } from '../core/config';
import { boneTexture, boneTextureSize } from '../people/crowd';
import { blendIntoSky, patchHaze } from '../world/atmosphere';
import {
  BUILDING_FRAG_AO,
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
  PERSON_FRAG_AO,
  PERSON_FRAG_COLOR,
  PERSON_FRAG_EMISSIVE,
  PERSON_FRAG_HEAD,
  PERSON_FRAG_ROUGH,
  PERSON_VERT_HEAD,
  PICK_FRAG,
  PROP_FRAG_AO,
  PROP_FRAG_COLOR,
  PROP_FRAG_EMISSIVE,
  PROP_FRAG_HEAD,
  PROP_FRAG_METAL,
  PROP_FRAG_ROUGH,
  PROP_VERT_HEAD,
  SHARD_FRAG_COLOR,
  SHARD_FRAG_HEAD,
  SHARD_FRAG_METAL,
  SHARD_FRAG_ROUGH,
  SHARD_VERT_HEAD,
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
  // The café explosion (src/world/collapse.ts).
  uBlast: { value: new THREE.Vector4(0, 0, 0, 0) },
  uShatter: { value: new THREE.Vector4(0, 0, 9.8, 0) },
  // The lighting pass (src/world/look.ts): ambient occlusion strength, night glow strength, unused, unused.
  uLook: { value: new THREE.Vector4(1, 1, 0, 0) },
  // The air (src/world/atmosphere.ts). The sky's colours are written by the Environment.
  uHaze: { value: new THREE.Vector4(0.001, 0.001, 1 / 40, 0.1) },
  uSkyTop: { value: new THREE.Color() },
  uSkyHorizon: { value: new THREE.Color() },
  uSkyBottom: { value: new THREE.Color() },
  uSkyFog: { value: new THREE.Color() },
  uSkySun: { value: new THREE.Color() },
  uSkySunDir: { value: new THREE.Vector3(0.3, 0.8, 0.4).normalize() },
  // The crowd's bones, frame by frame (src/people/crowd.ts); baked when the first person material is made.
  tBones: { value: null as THREE.Texture | null },
  uBoneTexel: { value: new THREE.Vector2(1, 1) },
};

type Kind = 'building' | 'ground' | 'prop' | 'person' | 'shard';

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
      ['#include <aomap_fragment>', BUILDING_FRAG_AO],
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
      ['#include <aomap_fragment>', PROP_FRAG_AO],
    ],
  },
  person: {
    vert: PERSON_VERT_HEAD,
    frag: PERSON_FRAG_HEAD,
    call: 'personVertex',
    replace: [
      ['#include <color_fragment>', PERSON_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', PERSON_FRAG_ROUGH],
      ['#include <emissivemap_fragment>', PERSON_FRAG_EMISSIVE],
      ['#include <aomap_fragment>', PERSON_FRAG_AO],
    ],
  },
  shard: {
    vert: SHARD_VERT_HEAD,
    frag: SHARD_FRAG_HEAD,
    call: 'shardVertex',
    replace: [
      ['#include <color_fragment>', SHARD_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', SHARD_FRAG_ROUGH],
      ['#include <metalnessmap_fragment>', SHARD_FRAG_METAL],
    ],
  },
};

/** The person shaders read the crowd's bone texture: bake it once, the first time anyone needs it. */
function needBones(kind: Kind): void {
  if (kind !== 'person' || U.tBones.value) return;
  U.tBones.value = boneTexture();
  const { width, height } = boneTextureSize();
  U.uBoneTexel.value.set(1 / width, 1 / height);
}

function must(src: string, find: string): string {
  if (!src.includes(find)) throw new Error(`shader patch target missing: ${find}`);
  return find;
}

/** A MeshStandardMaterial whose vertices are folded and whose surface is painted procedurally. */
export function foldedMaterial(kind: Kind, params: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const spec = SPEC[kind];
  needBones(kind);
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
    patchHaze(shader);
  };
  mat.customProgramCacheKey = () => `inception-${kind}`;
  blendIntoSky(mat);
  return mat;
}

/** Shadow-map depth material with the same folding, so folded flaps cast true shadows. */
export function foldedDepthMaterial(kind: Kind): THREE.MeshDepthMaterial {
  const spec = SPEC[kind];
  needBones(kind);
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
export function pickMaterial(kind: Exclude<Kind, 'prop' | 'person' | 'shard'>, kindId: number): THREE.ShaderMaterial {
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
