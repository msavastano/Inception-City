import * as THREE from 'three';
import { BodyDetail, BodyMesh, BodyShape, buildBody, HERO_DETAIL, MAN, PART, PIECE, pieceBit, wears } from './body';
import { BONE_COUNT, BONE_NAMES, BONE_PARENT, Pose, restLocal } from './rig';

/** Colours for one person's clothes, by PART. */
export type Palette = Record<keyof typeof PART, number>;

/** The dreamer: a dark suit, a white shirt, a dark red tie. */
export const DREAMER_PALETTE: Palette = {
  jacket: 0x2b2e36,
  trousers: 0x282b33,
  shirt: 0xe6e2d8,
  tie: 0x5c1a1c,
  skin: 0xc89f86,
  hair: 0x1b1714,
  shoes: 0x0c0c0f,
  hat: 0x23252c,
  bag: 0x3a2a1c,
  skirt: 0x23252c,
};

export const DREAMER_PIECES = pieceBit(PIECE.shirtFront) | pieceBit(PIECE.shortHair);

/** Keep only the pieces a person wears (bit flags, see pieceBit). */
export function wear(mesh: BodyMesh, pieces: number): BodyMesh {
  const worn = (v: number) => wears(pieces, mesh.piece[v]);
  const index: number[] = [];
  for (let t = 0; t < mesh.index.length; t += 3) {
    if (worn(mesh.index[t]) && worn(mesh.index[t + 1]) && worn(mesh.index[t + 2])) index.push(mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]);
  }
  return { ...mesh, index: new Uint32Array(index) };
}

/**
 * One skinned figure with its own bones, posed on the CPU from the shared rig:
 * the dreamer's body. (The crowd is drawn differently, see src/people/crowd.ts.)
 */
export class Figure {
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[] = [];

  constructor(shape: BodyShape = MAN, palette: Palette = DREAMER_PALETTE, pieces = DREAMER_PIECES, detail: BodyDetail = HERO_DETAIL) {
    const body = wear(buildBody(shape, detail), pieces);
    const n = body.position.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(body.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(body.normal, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(body.bones), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(body.weights, 4));
    const names = Object.keys(PART) as (keyof typeof PART)[];
    const colors = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let v = 0; v < n; v++) {
      c.setHex(palette[names[body.part[v]]]);
      colors.set([c.r, c.g, c.b], v * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setIndex(new THREE.BufferAttribute(body.index, 1));

    for (let b = 0; b < BONE_COUNT; b++) {
      const bn = new THREE.Bone();
      bn.name = BONE_NAMES[b];
      const { t, q } = restLocal(b);
      bn.position.fromArray(t);
      bn.quaternion.fromArray(q);
      this.bones.push(bn);
      if (BONE_PARENT[b] >= 0) this.bones[BONE_PARENT[b]].add(bn);
    }
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0 });
    this.mesh = new THREE.SkinnedMesh(g, material);
    this.mesh.add(this.bones[0]);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // the bones move the vertices well outside the rest pose's bounds
    this.mesh.frustumCulled = false;
  }

  /** Put the bones in a pose. */
  pose(p: Pose): void {
    for (let b = 0; b < BONE_COUNT; b++) this.bones[b].quaternion.fromArray(p.q, b * 4);
    this.bones[0].position.fromArray(p.hips);
  }
}
