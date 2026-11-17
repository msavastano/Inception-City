import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HALLWAY } from './hallway/manifest';
import hallwayUrl from './hallway/hallway.glb?url';

/**
 * THE HALLWAY AS A MODEL
 *
 * The hotel corridor built and lit in Blender (art/hallway/build_hallway.py), exported as one
 * glTF file (src/world/hallway/hallway.glb, made by scripts/pack-hallway.mjs). The file holds a
 * quarter of the corridor and one lightmap; this module loads it, mirrors the quarter into the
 * whole corridor and paints it. The painted box in hallway.ts stays as the fallback: it draws
 * until this has loaded, on Low quality, and if the file cannot be read.
 *
 * Each vertex says what it is (KIND below) and its base colour. Inside, the light is the bake:
 * the lamps' light and its bounces, which turn with the corridor because they are part of it.
 * The stone outside is lit by the sun like the rest of the city.
 */

/** Surface kinds, the alpha of the model's colour attribute times 16 (KINDS in build_hallway.py). */
export const KIND = {
  carpet: 1,
  wallpaper: 2,
  wood: 3,
  door: 4,
  trim: 5,
  plaster: 6,
  brass: 7,
  shade: 8,
  glass: 9,
  stone: 10,
  section: 11,
  band: 12,
} as const;

/** Kinds that are outside the corridor: lit by the sun, not by the bake. */
export const OUTSIDE_FROM = KIND.stone;

export interface HallwayModel {
  geometry: THREE.BufferGeometry;
  /** The baked light, 8 bits: the square root of light / scale, through the sRGB curve. */
  light: THREE.Texture;
  /** Light at 1.0 in the image, in Blender's units. */
  scale: number;
}

export const HALLWAY_URL: string = hallwayUrl;

/** Read any attribute (quantised, normalised or interleaved) into plain floats. */
function floats(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const n = attr.count;
  const size = attr.itemSize;
  const out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) out[i * size + c] = attr.getComponent(i, c);
  return out;
}

export interface Quarter {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** rgb base colour and kind / 16, per vertex. */
  color: Float32Array;
  index: Uint32Array;
}

/**
 * The whole corridor from its quarter at x >= 0, z >= 0: the quarter and its mirror images
 * across x = 0 and z = 0. The images keep the quarter's lightmap coordinates (the light is
 * symmetric too), and the ones mirrored once have their triangles turned round so they still
 * face the right way.
 *
 * Vertices within SEAM of a mirror plane are put on it: the file's positions are quantised, and
 * miss x = 0 by most of a millimetre, which would open a crack down the middle of the corridor.
 */
export const SEAM = 0.002;
const onSeam = (v: number) => (Math.abs(v) < SEAM ? 0 : v);

export function mirrorQuarter(q: Quarter): THREE.BufferGeometry {
  const n = q.position.length / 3;
  const m = q.index.length;
  const mirrors: [number, number][] = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  const position = new Float32Array(n * 12);
  const normal = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const tint = new Float32Array(n * 12);
  const kind = new Float32Array(n * 4);
  const index = new Uint32Array(m * 4);
  mirrors.forEach(([sx, sz], k) => {
    const o = k * n;
    for (let i = 0; i < n; i++) {
      const a = (o + i) * 3;
      position[a] = onSeam(q.position[i * 3]) * sx;
      position[a + 1] = q.position[i * 3 + 1];
      position[a + 2] = onSeam(q.position[i * 3 + 2]) * sz;
      normal[a] = q.normal[i * 3] * sx;
      normal[a + 1] = q.normal[i * 3 + 1];
      normal[a + 2] = q.normal[i * 3 + 2] * sz;
      uv[(o + i) * 2] = q.uv[i * 2];
      uv[(o + i) * 2 + 1] = q.uv[i * 2 + 1];
      tint[a] = q.color[i * 4];
      tint[a + 1] = q.color[i * 4 + 1];
      tint[a + 2] = q.color[i * 4 + 2];
      kind[o + i] = Math.round(q.color[i * 4 + 3] * 16);
    }
    const flip = sx * sz < 0;
    for (let t = 0; t < m; t += 3) {
      const b = k * m + t;
      index[b] = q.index[t] + o;
      index[b + 1] = q.index[flip ? t + 2 : t + 1] + o;
      index[b + 2] = q.index[flip ? t + 1 : t + 2] + o;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** Load the corridor and its light. Rejects if the file is missing or not what was expected. */
export async function loadHallwayModel(url = HALLWAY_URL): Promise<HallwayModel> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  let mesh: THREE.Mesh | null = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
  });
  if (!mesh) throw new Error('hallway model: no mesh');
  const found = mesh as THREE.Mesh;
  const src = found.geometry;
  const map = (found.material as THREE.MeshStandardMaterial).map;
  if (!map || !src.index || !src.attributes.color || !src.attributes.uv) throw new Error('hallway model: missing light, colours or lightmap coordinates');
  // the quantised positions come with a node transform: bake it in
  const position = floats(src.attributes.position);
  const normal = floats(src.attributes.normal);
  const mat = found.matrixWorld;
  const nmat = new THREE.Matrix3().getNormalMatrix(mat);
  const v = new THREE.Vector3();
  for (let i = 0; i < position.length; i += 3) {
    v.fromArray(position, i).applyMatrix4(mat).toArray(position, i);
    v.fromArray(normal, i).applyMatrix3(nmat).normalize().toArray(normal, i);
  }
  const quarter: Quarter = {
    position,
    normal,
    uv: floats(src.attributes.uv),
    color: floats(src.attributes.color),
    index: Uint32Array.from(src.index.array as ArrayLike<number>),
  };
  src.dispose();
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;
  return { geometry: mirrorQuarter(quarter), light: map, scale: HALLWAY.lightScale };
}

/** The lamps' colour (LIGHT in build_hallway.py): tungsten, about 2700 K. */
const LAMP = 'vec3(1.0, 0.71, 0.43)';

const MODEL_PARS = /* glsl */ `
varying vec3 vHall;
varying vec3 vHallN;
varying vec3 vTint;
varying float vKind;
varying vec2 vBakeUv;
uniform float uReveal;
uniform float uRevealZ;
uniform float uHallTime;
uniform sampler2D uBake;
uniform float uBakeGain;
uniform vec3 uHallSky;

float hmHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hmNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hmHash(i), hmHash(i + vec2(1.0, 0.0)), f.x), mix(hmHash(i + vec2(0.0, 1.0)), hmHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// a line of half-width w at v == 0, anti-aliased by its own screen footprint
float hmLine(float v, float w) {
  float aa = fwidth(v) * 0.75 + 1e-5;
  return 1.0 - smoothstep(w - aa, w + aa, abs(v));
}
float hmBand(float v, float a, float b) {
  float aa = fwidth(v) * 0.75 + 1e-5;
  return smoothstep(a - aa, a + aa, v) * (1.0 - smoothstep(b - aa, b + aa, v));
}
// 3 x 5 digits for the room numbers, rows top to bottom, three bits a row
int hmDigit(int d) {
  int t[10] = int[10](31599, 11415, 29671, 29391, 23497, 31183, 31215, 29266, 31727, 31695);
  return t[d];
}
float hmNumber(vec2 q, int n) {
  // q: metres from the middle of the plate, x along the reading direction, y up
  const float CELL = 0.018;
  float x = q.x + 0.099;
  float y = 0.045 - q.y;
  if (x < 0.0 || x >= 0.198 || y < 0.0 || y >= 0.09) return 0.0;
  int i = int(floor(x / 0.072));
  float cx = (x - float(i) * 0.072) / CELL;
  if (cx >= 3.0) return 0.0;
  int col = int(floor(cx));
  int row = int(floor(y / CELL));
  int d = i == 0 ? n / 100 : (i == 1 ? (n / 10) % 10 : n % 10);
  return float((hmDigit(d) >> (14 - row * 3 - col)) & 1);
}

// The corridor's surfaces: base colour (and glow for the lamps) from the kind and the place.
vec3 hallModelPaint(out vec3 glow) {
  vec3 p = vHall;
  vec3 c = vTint;
  float k = floor(vKind + 0.5);
  glow = vec3(0.0);
  float lz = (fract(p.z / 8.0 + 0.5) - 0.5) * 8.0; // from the nearest lamp, along the corridor
  if (k == 1.0) {
    // carpet: a field of gold lattice on red, a gold border, plain red to the skirting
    float ax = abs(p.x);
    vec2 q = vec2(p.x, p.z) / vec2(0.85, 0.9);
    vec2 d = abs(fract(q) - 0.5);
    float lat = d.x + d.y;
    float motif = hmLine(lat - 0.36, 0.035) + hmLine(length(d) - 0.0, 0.07) * 0.8 + hmLine(lat - 0.18, 0.02) * 0.6;
    vec3 gold = vec3(0.42, 0.27, 0.085);
    vec3 dark = vec3(0.07, 0.012, 0.012);
    vec3 field = mix(c, gold, clamp(motif, 0.0, 1.0) * step(ax, 2.5));
    float border = hmBand(ax, 2.62, 2.92);
    field = mix(field, gold * 0.9, border);
    field = mix(field, dark, hmLine(ax - 2.56, 0.018) + hmLine(ax - 2.98, 0.018));
    field = mix(field, c * 0.8, step(3.02, ax));
    float pile = 0.9 + 0.12 * hmNoise(p.xz * 9.0) + 0.06 * hmNoise(p.xz * 37.0);
    c = field * pile;
  } else if (k == 2.0) {
    // wallpaper: satin stripes with a small damask motif in the wide ones
    float s = p.z / 0.42;
    float st = fract(s);
    float wide = hmBand(st, 0.08, 0.62);
    vec2 cell = vec2(fract(s) - 0.35, fract(p.y / 0.56) - 0.5);
    float med = hmLine(length(cell * vec2(2.4, 1.0)) - 0.2, 0.018) + hmLine(length(cell * vec2(5.0, 2.2)) - 0.0, 0.08);
    c *= 0.92 + 0.1 * wide + 0.07 * clamp(med, 0.0, 1.0) * wide;
    c *= 0.96 + 0.06 * hmNoise(vec2(p.z, p.y) * 13.0);
  } else if (k == 3.0) {
    // dark walnut, its grain running along the corridor
    float gr = hmNoise(vec2(p.z * 1.3, p.y * 34.0)) * 0.6 + hmNoise(vec2(p.z * 0.4, p.y * 9.0)) * 0.4;
    c *= 0.78 + 0.45 * gr;
  } else if (k == 4.0) {
    // mahogany doors, grain running up
    float gr = hmNoise(vec2(p.z * 36.0, p.y * 1.1)) * 0.6 + hmNoise(vec2(p.z * 8.0, p.y * 0.35)) * 0.4;
    c *= 0.8 + 0.42 * gr;
  } else if (k == 5.0 || k == 6.0) {
    c *= 0.97 + 0.05 * hmNoise(p.zy * 5.0 + p.xx * 3.0);
  } else if (k == 7.0) {
    // brass, and the room numbers on the plates of the doors
    c *= 0.9 + 0.2 * hmNoise(p.zy * 60.0);
    float ax = abs(p.x);
    float dc = 8.0 * floor(p.z / 8.0) + 4.0;
    vec2 q = vec2((p.z - dc) * sign(p.x), p.y - (-${(3.5 - 1.73).toFixed(3)}));
    if (ax > 3.56 && abs(q.y) < 0.06 && abs(q.x) < 0.12) {
      int room = 501 + 2 * int((dc + 28.0) / 8.0 + 0.5) + (p.x < 0.0 ? 1 : 0);
      c = mix(c, vec3(0.03, 0.02, 0.012), hmNumber(q, room));
    }
  } else if (k == 8.0) {
    // a sconce's shade: glowing cloth with brass rims
    float t = p.y + ${(3.5).toFixed(1)};
    float rim = 1.0 - hmBand(t, 2.567, 2.918);
    float flicker = 0.96 + 0.04 * sin(uHallTime * 23.0 + p.z * 1.7);
    float under = vHallN.y < -0.5 ? 1.35 : 1.0;
    glow = ${LAMP} * 1.9 * under * flicker * (1.0 - rim);
    c = mix(vec3(0.05), vec3(0.5, 0.34, 0.12), rim);
  } else if (k == 9.0) {
    // frosted glass in the ceiling, in leaded panes
    float lead = max(hmLine(fract(p.x / 0.34 + 0.5) - 0.5, 0.025), hmLine(fract(lz / 0.3) - 0.5, 0.03));
    float fall = 1.0 - 0.12 * length(vec2(p.x / 0.85, lz / 0.6));
    glow = ${LAMP} * 2.8 * fall * (1.0 - lead * 0.85);
    c = vec3(0.04);
  } else {
    // outside: dressed stone in courses, the cut ends plainer
    vec3 n = abs(vHallN);
    float v = n.x > n.y ? p.y : p.x;
    float course = floor(v / 0.5);
    float u = p.z / 1.1 + 0.5 * mod(course, 2.0);
    float joint = max(hmLine(fract(v / 0.5 + 0.5) - 0.5, 0.025), hmLine(fract(u + 0.5) - 0.5, 0.012));
    float block = hmHash(vec2(floor(u), course) + floor(vHallN.xy * 3.0));
    float wear = 0.86 + 0.14 * hmNoise(vec2(p.z, v) * 2.3) + 0.06 * hmNoise(vec2(p.z, v) * 17.0);
    if (k == 10.0) c *= (0.9 + 0.2 * block) * wear * (1.0 - 0.4 * joint);
    else c *= wear;
  }
  return c;
}
`;

/**
 * The modelled corridor's material. The uniforms are the hallway's (reveal, time) plus the light.
 * Inside, three's light loop is skipped altogether: the light is the bake, plus a little of the
 * sky's where the open ends let it in.
 */
export function modelMaterial(uniforms: Record<string, THREE.IUniform>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 aTint;\nattribute float aKind;\nvarying vec3 vHall;\nvarying vec3 vHallN;\nvarying vec3 vTint;\nvarying float vKind;\nvarying vec2 vBakeUv;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHall = position;\nvHallN = normal;\nvTint = aTint;\nvKind = aKind;\nvBakeUv = uv;');
    let f = shader.fragmentShader.replace('#include <common>', `#include <common>\n${MODEL_PARS}`);
    f = f.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      if (abs(vHall.z - uRevealZ) > uReveal) discard;
      vec3 hallGlow;
      diffuseColor.rgb = hallModelPaint(hallGlow);
      bool hallInside = vKind < ${(OUTSIDE_FROM - 0.5).toFixed(1)};`,
    );
    f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += hallGlow;');
    // the sun, the sky light and the reflections only for the stone outside
    const begin = '#include <lights_fragment_begin>';
    const end = '#include <lights_fragment_end>';
    const a = f.indexOf(begin);
    const b = f.indexOf(end) + end.length;
    if (a < 0 || b < end.length) throw new Error('hallway shader: light chunks not found');
    f =
      f.slice(0, a) +
      `if (!hallInside) {\n${f.slice(a, b)}\n} else {
        // stored as the square root of the light (build_hallway.py): square what the sRGB decode gives
        vec3 bakeRoot = texture2D(uBake, vBakeUv).rgb;
        vec3 baked = bakeRoot * bakeRoot * uBakeGain;
        // daylight through the open ends, gone a few metres in
        float hallEnd = max(0.0, ${(32).toFixed(1)} - abs(vHall.z));
        vec3 light = baked + uHallSky * (0.5 * exp(-hallEnd * 0.4));
        reflectedLight.indirectDiffuse = diffuseColor.rgb * light;
        // brass catches a little more of the light that falls on it
        if (floor(vKind + 0.5) == ${KIND.brass.toFixed(1)}) reflectedLight.indirectSpecular = diffuseColor.rgb * light * 0.6;
      }` +
      f.slice(b);
    shader.fragmentShader = f;
  };
  m.customProgramCacheKey = () => 'hallway-model';
  return m;
}
