import * as THREE from 'three';
import { MAX_FOLDS } from '../core/config';
import { boneTexture, boneTextureSize } from '../people/crowd';
import { DETAIL } from './detail/manifest';
import { blendIntoSky, patchHaze } from '../world/atmosphere';
import {
  BUILDING_FRAG_AO,
  BUILDING_FRAG_COLOR,
  BUILDING_FRAG_EMISSIVE,
  BUILDING_FRAG_HEAD,
  BUILDING_FRAG_METAL,
  BUILDING_FRAG_NORMAL,
  BUILDING_FRAG_ROUGH,
  BUILDING_VERT_HEAD,
  GROUND_FRAG_COLOR,
  GROUND_FRAG_EMISSIVE,
  GROUND_FRAG_HEAD,
  GROUND_FRAG_NORMAL,
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
  TREE_DEPTH_FRAG_HEAD,
  TREE_PREPASS_FRAG_HEAD,
  TREE_PREPASS_FRAG_OUT,
  TREE_PREPASS_FRAG_TEST,
  TREE_DEPTH_FRAG_TEST,
  TREE_FRAG_AO,
  TREE_FRAG_COLOR,
  TREE_FRAG_EMISSIVE,
  TREE_FRAG_HEAD,
  TREE_FRAG_NORMAL,
  TREE_FRAG_ROUGH,
  TREE_VERT_HEAD,
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
  // The walls' relief (set per quality tier in src/app.ts): depth of the window reveals, strength of the bumps, where the reveals start and finish fading (metres).
  uRelief: { value: new THREE.Vector4(1, 1, 30, 44) },
  // The close-up surface detail (src/city/detail.ts): one layer per kind of surface, with its relief, roughness and cavities.
  // Until the real one has loaded this is one flat texel per layer, which changes nothing.
  tDetail: { value: flatDetail() as THREE.DataArrayTexture },
  // How strong the detail's relief is, how strong its cavities, and where it starts and finishes fading (metres from the eye; set per quality tier in src/app.ts).
  uDetail: { value: new THREE.Vector4(1, 1, 22, 36) },
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
  // The trees (src/city/treeField.ts): the leaf atlas (drawn just after the first frame; until then a bare
  // texel, so the trees stand leafless for a moment), where the near version fades out (metres from the
  // eye: start, end), the share of the leaves the season has taken, and the wind.
  tLeaves: { value: bareLeaves() as THREE.Texture },
  uTrees: { value: new THREE.Vector4(48, 60, 0, 1) },
  // The main camera, written every frame: the shadow and mirror passes choose a tree's version by it too.
  uEye: { value: new THREE.Vector3() },
  // How far from the eye the trees still cast their shadows (metres: start of the fade, end): further out
  // their shade on the ground is painted (crownShade in the ground painter), at no cost per leaf.
  uTreeShadow: { value: new THREE.Vector2(150, 180) },
};

/** No leaves and no twigs: what the trees wear until the leaf atlas has been drawn. */
function bareLeaves(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

type Kind = 'building' | 'ground' | 'prop' | 'person' | 'shard' | 'tree';

/** One texel per detail layer, standing for a flat surface of average roughness with no cavities. */
function flatDetail(): THREE.DataArrayTexture {
  const n = DETAIL.layers.length;
  const ao = Math.round(DETAIL.aoMean * 255);
  const tex = new THREE.DataArrayTexture(new Uint8Array(4 * n).map((_, i) => (i % 4 === 3 ? ao : 128)), 1, 1, n);
  tex.needsUpdate = true;
  return tex;
}

const SPEC: Record<Kind, { vert: string; frag: string; call: string; replace: [string, string][] }> = {
  building: {
    vert: BUILDING_VERT_HEAD,
    frag: BUILDING_FRAG_HEAD,
    call: 'buildingVertex',
    replace: [
      ['#include <color_fragment>', BUILDING_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', BUILDING_FRAG_ROUGH],
      ['#include <metalnessmap_fragment>', BUILDING_FRAG_METAL],
      ['#include <normal_fragment_maps>', BUILDING_FRAG_NORMAL],
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
      ['#include <normal_fragment_maps>', GROUND_FRAG_NORMAL],
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
  tree: {
    vert: TREE_VERT_HEAD,
    frag: TREE_FRAG_HEAD,
    call: 'treeVertex',
    replace: [
      ['#include <color_fragment>', TREE_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', TREE_FRAG_ROUGH],
      ['#include <normal_fragment_maps>', TREE_FRAG_NORMAL],
      ['#include <emissivemap_fragment>', TREE_FRAG_EMISSIVE],
      ['#include <aomap_fragment>', TREE_FRAG_AO],
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

/** Every building material made, so the walls' relief can be compiled in or out of all of them at once. */
const buildingMaterials: THREE.MeshStandardMaterial[] = [];
let wallRelief = true;

/**
 * Compile the walls' relief (window reveals, ledge shadows, carved joints) into the building shader, or leave it
 * out so the walls are flat and cost what they did before it. Off on Low. Changing it recompiles the building
 * shader once, which happens on the same step down to Low that turns the sun's shadows off and recompiles it anyway.
 */
export function setWallRelief(on: boolean): void {
  if (on === wallRelief) return;
  wallRelief = on;
  for (const mat of buildingMaterials) applyWallRelief(mat);
}

function applyWallRelief(mat: THREE.MeshStandardMaterial): void {
  const defines = (mat.defines ??= {});
  if (wallRelief) defines.RELIEF = '';
  else delete defines.RELIEF;
  mat.needsUpdate = true;
}

/** Every building and ground material made, so the surface detail can be compiled in or out of all of them at once. */
const detailMaterials: THREE.MeshStandardMaterial[] = [];
let surfaceDetail = true;

/**
 * Compile the close-up surface detail (the scanned relief of asphalt, stone and setts, src/city/detail.ts) into
 * the building and ground shaders, or leave it out so they cost what they did before it. Off on Low.
 */
export function setSurfaceDetail(on: boolean): void {
  if (on === surfaceDetail) return;
  surfaceDetail = on;
  for (const mat of detailMaterials) applySurfaceDetail(mat);
}

function applySurfaceDetail(mat: THREE.MeshStandardMaterial): void {
  const defines = (mat.defines ??= {});
  if (surfaceDetail) defines.DETAIL = '';
  else delete defines.DETAIL;
  mat.needsUpdate = true;
}

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
  // (trees stay well inside the streamed city: they are opaque, their leaves cut out by coverage)
  if (kind !== 'tree') blendIntoSky(mat);
  if (kind === 'building') {
    buildingMaterials.push(mat);
    applyWallRelief(mat);
  }
  if (kind === 'building' || kind === 'ground') {
    detailMaterials.push(mat);
    applySurfaceDetail(mat);
  }
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

/**
 * The trees' material: the near version (every branch and leaf card) or the far one (trunk, limbs and a few
 * big cards that face the camera). Leaves are cut out of their cards by the atlas's coverage, which with the
 * frame's MSAA becomes soft-edged (alpha to coverage); both sides of a card are lit alike.
 */
export function treeMaterial(lod: 'near' | 'far'): THREE.MeshStandardMaterial {
  // (the depth is written by the pass before, treePrepassMaterial; not writing it here lets the GPU skip hidden leaves)
  const mat = foldedMaterial('tree', { side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: true, depthWrite: false });
  if (lod === 'far') mat.defines = { ...mat.defines, TREE_FAR: '' };
  const folded = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    folded.call(mat, shader, renderer);
    // (worldPosition is only used from here on to look up the shadows, and only declared when there are any, as not on Low)
    const v = shader.vertexShader;
    shader.vertexShader = v.replace(
      must(v, '#include <worldpos_vertex>'),
      '#include <worldpos_vertex>\n#ifdef USE_SHADOWMAP\nworldPosition.xyz += treeShadowPush;\n#endif',
    );
  };
  mat.customProgramCacheKey = () => `inception-tree-${lod}`;
  return mat;
}

/** The trees' shadow: a version switches at once halfway through the fade, and leaves cast their clusters' shade. */
export function treeDepthMaterial(lod: 'near' | 'far'): THREE.MeshDepthMaterial {
  const mat = foldedDepthMaterial('tree');
  mat.side = THREE.DoubleSide;
  mat.defines = { TREE_SHADOW: '', ...(lod === 'far' ? { TREE_FAR: '' } : {}) };
  const vertexOnly = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    vertexOnly.call(mat, shader, renderer);
    let f = shader.fragmentShader;
    f = f.replace(must(f, '#include <common>'), `#include <common>\n${TREE_DEPTH_FRAG_HEAD}`);
    f = f.replace(must(f, '#include <alphatest_fragment>'), `#include <alphatest_fragment>\n${TREE_DEPTH_FRAG_TEST}`);
    shader.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => `inception-depth-tree-${lod}`;
  return mat;
}

/**
 * The trees' depth, drawn before their colour. A crown is many leaf cards deep, and a card that is mostly gaps
 * cannot hide what is behind it from the GPU until its leaves have been worked out, so without this every layer of
 * leaves would be lit and shaded, each over the last. This pass finds the leaf in front at each pixel cheaply
 * (one texel read); the colour pass then tests against it without writing depth, so the GPU skips the hidden
 * leaves before shading them. Its depth is pushed back a hair, so the colour pass always finds its own leaf.
 */
export function treePrepassMaterial(lod: 'near' | 'far'): THREE.MeshDepthMaterial {
  const mat = foldedDepthMaterial('tree');
  mat.side = THREE.DoubleSide;
  mat.defines = { TREE_PREPASS: '', ...(lod === 'far' ? { TREE_FAR: '' } : {}) };
  mat.colorWrite = false;
  mat.alphaToCoverage = true;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 1;
  const vertexOnly = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    vertexOnly.call(mat, shader, renderer);
    let f = shader.fragmentShader;
    f = f.replace(must(f, '#include <common>'), `#include <common>\n${TREE_PREPASS_FRAG_HEAD}`);
    f = f.replace(must(f, '#include <alphatest_fragment>'), TREE_PREPASS_FRAG_TEST);
    const end = f.lastIndexOf('}');
    shader.fragmentShader = f.slice(0, end) + TREE_PREPASS_FRAG_OUT + f.slice(end + 1);
  };
  mat.customProgramCacheKey = () => `inception-prepass-tree-${lod}`;
  return mat;
}

/** Renders fabric coordinates (x, height, z, kind) for GPU picking on folded geometry. */
export function pickMaterial(kind: Exclude<Kind, 'prop' | 'person' | 'shard' | 'tree'>, kindId: number): THREE.ShaderMaterial {
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
