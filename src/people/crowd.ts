import * as THREE from 'three';
import { buildBody, CROWD_DETAIL, MAN, PIECE, pieceBit, WOMAN } from './body';
import { BONE_COUNT, clip, ClipName, newPose, samplePose, skinMatrices, worldMatrices } from './rig';
import { ClipInfo } from './rigdata';

/**
 * The crowd: every pedestrian is an instance of one mesh, drawn in one call.
 *
 * The mesh holds a man with every optional piece of clothing at once (hat, long
 * hair, skirt, long coat, bag) and, as an offset on each vertex, the woman he can
 * be morphed into. Each person carries a handful of numbers: where they stand,
 * which frame of which clip they are in, what they wear and in which colours. The
 * vertex shader (PERSON_VERT_HEAD in src/city/shaders.ts) hides the pieces a
 * person does not wear, reads their bones for that frame from a texture and skins
 * the vertex, then folds it with the city like everything else.
 */

/** The clips the crowd can play, in the order they are stacked in the bone texture. */
const CROWD_CLIPS: ClipName[] = ['idle', 'talk', 'walk', 'stroll', 'jog'];

interface Strip {
  info: ClipInfo;
  /** First row of this clip in the texture. A looping clip has one more row than frames: its first frame again. */
  row: number;
}

let strips: Map<ClipName, Strip> | null = null;
let texture: THREE.DataTexture | null = null;
let rows = 0;

function bake(): void {
  strips = new Map();
  rows = 0;
  for (const name of CROWD_CLIPS) {
    const info = clip(name);
    strips.set(name, { info, row: rows });
    rows += info.frames + (info.loop ? 1 : 0);
  }
  // three texels a bone: the rows of its 3 x 4 skinning matrix
  const width = BONE_COUNT * 3;
  const data = new Uint16Array(width * rows * 4);
  const pose = newPose();
  const world = new Float32Array(BONE_COUNT * 12);
  const skin = new Float32Array(BONE_COUNT * 12);
  for (const { info, row } of strips.values()) {
    const n = info.frames + (info.loop ? 1 : 0);
    for (let f = 0; f < n; f++) {
      // a loop's phase runs 0..1 over its frames; a one-shot's over frames - 1
      samplePose(info, info.loop ? (f % info.frames) / info.frames : f / (info.frames - 1), pose);
      skinMatrices(worldMatrices(pose, world), skin);
      const o = (row + f) * width * 4;
      for (let i = 0; i < BONE_COUNT * 12; i++) data[o + i] = THREE.DataUtils.toHalfFloat(skin[i]);
    }
  }
  texture = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.HalfFloatType);
  // frames are blended by the sampler (down the texture); across it, bones are read at texel centres
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
}

/** Every crowd clip's bones, frame by frame: one row a frame, three texels a bone. */
export function boneTexture(): THREE.DataTexture {
  if (!texture) bake();
  return texture!;
}

/** The size of the bone texture, for reading it back in tests. */
export function boneTextureSize(): { width: number; height: number } {
  if (!texture) bake();
  return { width: BONE_COUNT * 3, height: rows };
}

/** The row of the bone texture for a clip at a phase (in cycles for a loop, 0..1 for a one-shot). Fractional: the sampler blends frames. */
export function clipRow(name: ClipName, u: number): number {
  if (!strips) bake();
  const s = strips!.get(name);
  if (!s) throw new Error(`the crowd has no clip called ${name}`);
  if (s.info.loop) return s.row + (u - Math.floor(u)) * s.info.frames;
  return s.row + Math.min(1, Math.max(0, u)) * (s.info.frames - 1);
}

let base: THREE.BufferGeometry | null = null;

/** The crowd's mesh: the man, the offsets that make him the woman, and what each vertex is and hangs from. */
export function crowdGeometry(): THREE.BufferGeometry {
  if (base) return base;
  const man = buildBody(MAN, CROWD_DETAIL);
  const woman = buildBody(WOMAN, CROWD_DETAIL);
  const n = man.position.length / 3;
  if (woman.position.length !== man.position.length) throw new Error('the two builds must share their vertices');
  const morph = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) morph[i] = woman.position[i] - man.position[i];
  const skin = new Float32Array(n * 4);
  const info = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    // two bones a vertex is all a crowd needs
    const w0 = man.weights[v * 4];
    const w1 = man.weights[v * 4 + 1];
    skin[v * 4] = man.bones[v * 4];
    skin[v * 4 + 1] = man.bones[v * 4 + 1];
    skin[v * 4 + 2] = w0 / (w0 + w1);
    skin[v * 4 + 3] = man.look[v];
    info[v * 2] = man.part[v];
    info[v * 2 + 1] = man.piece[v];
  }
  base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.BufferAttribute(man.position, 3));
  base.setAttribute('normal', new THREE.BufferAttribute(man.normal, 3));
  base.setAttribute('aMorph', new THREE.BufferAttribute(morph, 3));
  base.setAttribute('aSkin', new THREE.BufferAttribute(skin, 4));
  base.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
  base.setIndex(new THREE.BufferAttribute(man.index, 1));
  return base;
}

type RGB = [number, number, number];

/** What one person looks like. */
export interface Outfit {
  /** 0 the man's build, 1 the woman's. */
  build: number;
  /** Height, as a multiple of the rig's 1.83 m. */
  scale: number;
  /** The pieces worn (pieceBit flags, src/people/body.ts). */
  pieces: number;
  jacket: RGB;
  /** Trousers or skirt. */
  lower: RGB;
  /** The tie, or a scarf at the collar. */
  accent: RGB;
  /** 0 the palest skin, 1 the darkest; 0 black hair through brown and fair to 1 grey. */
  skin: number;
  hair: number;
  /** Under a skirt: 0 bare legs, 1 black tights. */
  hose: number;
}

const hex = (h: number): RGB => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b];
};
const SUITS = [0x24262d, 0x1d2433, 0x3a3d44, 0x4a4038, 0x2e3a35, 0x17181c, 0x55585f].map(hex);
const COATS = [0x6b5a43, 0x2a2c33, 0x3b3f4a, 0x7a7468, 0x4a3328, 0x1f2a3a, 0x54523f].map(hex);
const DRESSES = [0x6a1f2a, 0x1f4a52, 0x8a7d62, 0x18191d, 0x8a6a1e, 0x23324f, 0x2f4a33, 0x7a4a5a, 0xb9b2a3].map(hex);
const TIES = [0x5c1a1c, 0x1c2c4a, 0x8a6a1e, 0x26442f, 0x4a4d55, 0x3a2040].map(hex);
const SCARVES = [0xb9b2a3, 0x8a2f2a, 0x2f5560, 0xa88a3a, 0x555a66].map(hex);
const pick = <T>(list: T[], r: number): T => list[Math.min(list.length - 1, Math.floor(r * list.length))];
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** Dress one pedestrian from a stream of random numbers. */
export function pedestrian(r: () => number): Outfit {
  const woman = r() < 0.46;
  const hat = pieceBit(PIECE.hat);
  const bag = pieceBit(PIECE.bag);
  const coat = pieceBit(PIECE.coat);
  const shirt = pieceBit(PIECE.shirtFront);
  const skin = Math.pow(r(), 1.6);
  // most hair is dark; some is fair, and some has gone grey
  const hr = r();
  const hair = hr < 0.62 ? hr * 0.55 : hr < 0.85 ? 0.4 + (hr - 0.62) * 1.3 : 0.75 + (hr - 0.85) * 1.6;
  if (!woman) {
    const long = r() < 0.38;
    const suit = pick(long ? COATS : SUITS, r());
    const matched = r() < 0.6;
    return {
      build: r() * 0.22,
      scale: 0.93 + r() * 0.08,
      pieces: shirt | pieceBit(PIECE.shortHair) | (long ? coat : 0) | (r() < 0.24 ? hat : 0) | (r() < 0.3 ? bag : 0),
      jacket: suit,
      lower: matched && !long ? shade(suit, 0.92) : shade(pick(SUITS, r()), 0.85),
      accent: pick(TIES, r()),
      skin,
      hair,
      hose: 0,
    };
  }
  const cut = pieceBit(r() < 0.72 ? PIECE.longHair : PIECE.shortHair);
  const extras = (r() < 0.5 ? bag : 0) | (r() < 0.12 ? hat : 0);
  const build = 0.8 + r() * 0.2;
  const scale = 0.86 + r() * 0.07;
  const kind = r();
  if (kind < 0.42) {
    // a dress: the bodice and the skirt in one colour, no shirt front
    const dress = pick(DRESSES, r());
    return { build, scale, pieces: cut | extras | pieceBit(PIECE.skirt), jacket: dress, lower: shade(dress, 0.94), accent: dress, skin, hair, hose: r() < 0.5 ? 0.9 : 0.1 };
  }
  if (kind < 0.66) {
    // a jacket and a skirt over a blouse
    const suit = pick(SUITS, r());
    return { build, scale, pieces: cut | extras | shirt | pieceBit(PIECE.skirt), jacket: suit, lower: shade(suit, 0.9), accent: hex(0xd8d4c8), skin, hair, hose: r() < 0.7 ? 0.9 : 0.2 };
  }
  // a long coat over trousers, a scarf at the collar
  return { build, scale, pieces: cut | extras | shirt | coat, jacket: pick(COATS, r()), lower: shade(pick(SUITS, r()), 0.8), accent: pick(SCARVES, r()), skin, hair, hose: 0 };
}

/** Heist mode's bodyguards: tall men in the same navy suit. */
export function guard(r: () => number): Outfit {
  return {
    build: 0,
    scale: 0.99 + r() * 0.04,
    pieces: pieceBit(PIECE.shirtFront) | pieceBit(PIECE.shortHair),
    jacket: hex(0x18213a),
    lower: hex(0x151d33),
    accent: hex(0x0d0f16),
    skin: Math.pow(r(), 1.6),
    hair: r() * 0.4,
    hose: 0,
  };
}

/** Heist mode's target: a tall man in a black overcoat and hat. */
export const TARGET_OUTFIT: Outfit = {
  build: 0.05,
  scale: 1.03,
  pieces: pieceBit(PIECE.shirtFront) | pieceBit(PIECE.shortHair) | pieceBit(PIECE.coat) | pieceBit(PIECE.hat),
  jacket: hex(0x121316),
  lower: hex(0x101114),
  accent: hex(0x5c1a1c),
  skin: 0.25,
  hair: 0.9,
  hose: 0,
};

/** Where a person is and what they are doing this frame. */
export interface Stance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The clip being played and its phase; and, while changing from one clip to another, the one being left and how much of it remains (1 to 0). */
  clip: ClipName;
  phase: number;
  from?: ClipName;
  fromPhase?: number;
  fade?: number;
  /** The head turned this far to the left (radians). */
  look?: number;
  suspicion?: number;
}

/** A set of people drawn in one call with the person material (foldedMaterial('person')). */
export class People {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.InstancedBufferGeometry();
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private pos: Float32Array;
  private anim: Float32Array;
  private body: Float32Array;
  private colA: Float32Array;
  private colB: Float32Array;
  private colC: Float32Array;

  constructor(
    material: THREE.Material,
    depth: THREE.Material,
    readonly capacity: number,
  ) {
    const g = crowdGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) this.geometry.setAttribute(name, attr);
    this.geometry.setIndex(g.index);
    const mk = (name: string) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, a);
      this.attrs.push(a);
      return a.array as Float32Array;
    };
    this.pos = mk('iPosYaw');
    this.anim = mk('iAnim');
    this.body = mk('iBody');
    this.colA = mk('iColA');
    this.colB = mk('iColB');
    this.colC = mk('iColC');
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // only the first `shadows` people are drawn into the shadow map (see below)
    let all = 0;
    this.mesh.onBeforeShadow = () => {
      all = this.geometry.instanceCount;
      this.geometry.instanceCount = Math.min(all, this.shadows);
    };
    this.mesh.onAfterShadow = () => {
      this.geometry.instanceCount = all;
    };
  }

  /**
   * How many people cast shadows: the first this many. A far-off pedestrian's shadow is a
   * pixel or two, so a crowd keeps its nearest people first and only pays for theirs.
   */
  shadows = Infinity;

  get count(): number {
    return this.geometry.instanceCount;
  }

  set count(n: number) {
    this.geometry.instanceCount = Math.min(n, this.capacity);
  }

  /** What person i wears. */
  dress(i: number, o: Outfit): void {
    const k = i * 4;
    this.body[k] = o.scale;
    this.body[k + 1] = o.build;
    this.body[k + 2] = o.pieces;
    this.colA.set([o.jacket[0], o.jacket[1], o.jacket[2], o.skin], k);
    this.colB.set([o.lower[0], o.lower[1], o.lower[2], o.hair], k);
    this.colC.set([o.accent[0], o.accent[1], o.accent[2], o.hose], k);
  }

  /** Where person i is and what they are doing. */
  stand(i: number, s: Stance): void {
    const k = i * 4;
    this.pos[k] = s.x;
    this.pos[k + 1] = s.y;
    this.pos[k + 2] = s.z;
    this.pos[k + 3] = s.yaw;
    const fade = s.from ? (s.fade ?? 0) : 0;
    this.anim[k] = clipRow(s.clip, s.phase);
    this.anim[k + 1] = fade > 0 ? clipRow(s.from!, s.fromPhase ?? 0) : 0;
    this.anim[k + 2] = fade;
    this.anim[k + 3] = s.look ?? 0;
    this.body[k + 3] = s.suspicion ?? 0;
  }

  /** Send this frame's numbers to the GPU. */
  commit(): void {
    const n = this.geometry.instanceCount * 4;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n);
      a.needsUpdate = true;
    }
  }
}
