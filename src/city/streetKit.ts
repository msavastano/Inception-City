import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { KIT_MODELS, KIT_SPEC } from './kit';
import streetUrl from './street/street.glb?url';

/**
 * THE STREET LIFE KIT'S MODELS
 *
 * Café terraces, benches, bollards, bicycle racks, planters, menu boards, litter bins, advertising
 * columns, news kiosks, metro entrances, drinking fountains and parked cars, modelled in Blender
 * (art/street/build_street.py) and shipped as one glTF file (src/city/street/street.glb, made by
 * scripts/pack-street.mjs), one mesh per model. Where they stand is decided in streetLife.ts and how
 * they are drawn in kitField.ts.
 *
 * Each vertex carries its base colour and its kind (KIT_KIND), which the kit's shader reads (KIT_* in
 * shaders.ts). A model's +z is its front: the street side of kerb furniture, a car's bonnet.
 */

export interface StreetKitModels {
  /** One geometry per model, by Kit id: position, normal, aTint (rgb, kind / 16), aKitUv. */
  near: THREE.BufferGeometry[];
  /** The far versions, by Kit id (null for a model that has none: KIT_SPEC's far). */
  far: (THREE.BufferGeometry | null)[];
}

export const STREET_URL: string = streetUrl;

/** Read any attribute (quantised, normalised or interleaved) into plain floats. */
function floats(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const n = attr.count;
  const size = attr.itemSize;
  const out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) out[i * size + c] = attr.getComponent(i, c);
  return out;
}

/** A model's mesh as the kit draws it: the node's transform (the file's quantisation) baked in. */
export function kitGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const src = mesh.geometry;
  if (!src.index || !src.attributes.color || !src.attributes.normal) throw new Error(`street kit: ${mesh.name} has no colours, normals or index`);
  const position = floats(src.attributes.position);
  const normal = floats(src.attributes.normal);
  mesh.updateWorldMatrix(true, false);
  const mat = mesh.matrixWorld;
  const nmat = new THREE.Matrix3().getNormalMatrix(mat);
  const v = new THREE.Vector3();
  for (let i = 0; i < position.length; i += 3) {
    v.fromArray(position, i).applyMatrix4(mat).toArray(position, i);
    v.fromArray(normal, i).applyMatrix3(nmat).normalize().toArray(normal, i);
  }
  const color = src.attributes.color;
  const tint = color.itemSize === 4 ? floats(color) : new Float32Array(color.count * 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('aTint', new THREE.BufferAttribute(tint, 4));
  const uv = src.attributes.uv ? floats(src.attributes.uv) : new Float32Array(position.length / 3 * 2);
  g.setAttribute('aKitUv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array as ArrayLike<number>), 1));
  g.computeBoundingSphere();
  src.dispose();
  return g;
}

/** Load every model. Rejects if the file is missing or a model is not in it. */
export async function loadStreetKit(url = STREET_URL): Promise<StreetKitModels> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const find = (name: string): THREE.BufferGeometry => {
    let mesh: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh && (o.name === name || o.parent?.name === name)) mesh = o as THREE.Mesh;
    });
    if (!mesh) throw new Error(`street kit: no model "${name}"`);
    return kitGeometry(mesh);
  };
  return {
    near: KIT_MODELS.map(find),
    far: KIT_MODELS.map((name, k) => (KIT_SPEC[k].far ? find(`${name}_far`) : null)),
  };
}
