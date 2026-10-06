import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHUNK } from '../core/config';

/** Unit box standing on the origin: x,z ∈ [-0.5, 0.5], y ∈ [0, 1]. Height segments let it bend inside a curl. */
export function buildingGeometry(heightSegments = 6): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 1, heightSegments, 1);
  g.translate(0, 0.5, 0);
  g.deleteAttribute('uv');
  return g;
}

/** A chunk-sized ground tile with its corner at the origin, lying in XZ. */
export function groundGeometry(segments: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(CHUNK, CHUNK, segments, segments);
  g.rotateX(-Math.PI / 2);
  g.translate(CHUNK / 2, 0, CHUNK / 2);
  g.deleteAttribute('uv');
  return g;
}

function tag(g: THREE.BufferGeometry, part: number, color: [number, number, number] | ((i: number) => [number, number, number])) {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute('uv');
  const n = geo.attributes.position.count;
  const parts = new Float32Array(n).fill(part);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set(typeof color === 'function' ? color(i) : color, i * 3);
  geo.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(list);
  if (!g) throw new Error('geometry merge failed');
  return g;
}

export function treeGeometry(): THREE.BufferGeometry {
  const trunk = tag(new THREE.CylinderGeometry(0.16, 0.26, 3.4, 5, 1, true).translate(0, 1.7, 0), 0, [0.25, 0.18, 0.12]);
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const crownA = tag(new THREE.IcosahedronGeometry(2.4, 0).scale(1, 1.15, 1).translate(0, 5.0, 0), 1, () => [0, 0.3 + rnd() * 0.5, 0]);
  const crownB = tag(new THREE.IcosahedronGeometry(1.7, 0).translate(0.8, 6.3, -0.4), 1, () => [0, 0.5 + rnd() * 0.5, 0]);
  return merge([trunk, crownA, crownB]);
}

export function lampGeometry(): THREE.BufferGeometry {
  const iron: [number, number, number] = [0.07, 0.09, 0.08];
  const post = tag(new THREE.CylinderGeometry(0.07, 0.13, 4.6, 5, 1, true).translate(0, 2.3, 0), 0, iron);
  const base = tag(new THREE.CylinderGeometry(0.22, 0.26, 0.6, 5, 1, true).translate(0, 0.3, 0), 0, iron);
  const lantern = tag(new THREE.CylinderGeometry(0.26, 0.16, 0.6, 5).translate(0, 4.95, 0), 2, [1, 0.9, 0.7]);
  const cap = tag(new THREE.ConeGeometry(0.32, 0.3, 5).translate(0, 5.4, 0), 0, iron);
  return merge([post, base, lantern, cap]);
}

export function personGeometry(): THREE.BufferGeometry {
  const legs = tag(new THREE.BoxGeometry(0.34, 0.86, 0.22, 2, 2, 1).translate(0, 0.43, 0), 0, [0.08, 0.08, 0.09]);
  const body = tag(new THREE.CylinderGeometry(0.19, 0.24, 0.78, 8).translate(0, 1.25, 0), 3, [0.2, 0.2, 0.2]);
  const shoulders = tag(new THREE.SphereGeometry(0.22, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.05, 0.5, 0.8).translate(0, 1.62, 0), 3, [0.2, 0.2, 0.2]);
  const head = tag(new THREE.SphereGeometry(0.12, 10, 8).translate(0, 1.79, 0), 4, [0.78, 0.6, 0.48]);
  return merge([legs, body, shoulders, head]);
}

/**
 * A piece of blown-out wall: an irregular slab about a metre across, centred on
 * the origin, its faces looking along ±z (the wall's normal). Scaled per shard.
 */
export function shardGeometry(): THREE.BufferGeometry {
  const outline = new THREE.Shape([
    new THREE.Vector2(-0.5, -0.38),
    new THREE.Vector2(0.44, -0.5),
    new THREE.Vector2(0.5, 0.12),
    new THREE.Vector2(0.18, 0.5),
    new THREE.Vector2(-0.42, 0.34),
  ]);
  const g = new THREE.ExtrudeGeometry(outline, { depth: 1, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.5);
  const flat = g.index ? g.toNonIndexed() : g;
  flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  return flat;
}

/** The city's monument: a giant spinning top balanced on its point. */
export function totemGeometry(): THREE.BufferGeometry {
  const profile = [
    [0.002, 0],
    [0.05, 0.03],
    [0.16, 0.14],
    [0.3, 0.28],
    [0.4, 0.38],
    [0.43, 0.43],
    [0.42, 0.47],
    [0.36, 0.52],
    [0.2, 0.58],
    [0.08, 0.62],
    [0.06, 0.64],
    [0.055, 0.93],
    [0.075, 0.96],
    [0.06, 0.99],
    [0.002, 1],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const lathe = new THREE.LatheGeometry(profile, 48);
  lathe.scale(30, 30, 30);
  return merge([tag(lathe, 5, [0.78, 0.72, 0.6])]);
}

/** Heist mode's sleep machine: a silver briefcase on a café table, its lights on. About a metre tall. */
export function sleepMachineGeometry(): THREE.BufferGeometry {
  const iron: [number, number, number] = [0.06, 0.06, 0.07];
  const base = tag(new THREE.CylinderGeometry(0.24, 0.28, 0.03, 12).translate(0, 0.015, 0), 0, iron);
  const stem = tag(new THREE.CylinderGeometry(0.035, 0.045, 0.72, 6, 1, true).translate(0, 0.38, 0), 0, iron);
  const top = tag(new THREE.CylinderGeometry(0.42, 0.42, 0.035, 18).translate(0, 0.76, 0), 0, [0.86, 0.85, 0.81]);
  const caseBody = tag(new THREE.BoxGeometry(0.62, 0.15, 0.44).translate(0, 0.855, 0), 5, [0.78, 0.8, 0.84]);
  const handle = tag(new THREE.BoxGeometry(0.2, 0.03, 0.03).translate(0, 0.86, -0.235), 0, iron);
  const panel = tag(new THREE.BoxGeometry(0.34, 0.012, 0.14).translate(0, 0.936, 0.06), 6, [0.35, 0.7, 1.0]);
  const dial = tag(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 10).translate(-0.2, 0.94, -0.1), 6, [0.9, 0.35, 0.25]);
  return merge([base, stem, top, caseBody, handle, panel, dial]);
}

/** Heist mode's kick: a gramophone on a stone pedestal, its horn lit gold. */
export function gramophoneGeometry(): THREE.BufferGeometry {
  const pedestal = tag(new THREE.BoxGeometry(0.7, 1.0, 0.7).translate(0, 0.5, 0), 0, [0.78, 0.74, 0.66]);
  const cabinet = tag(new THREE.BoxGeometry(0.5, 0.22, 0.5).translate(0, 1.11, 0), 0, [0.36, 0.18, 0.08]);
  const disc = tag(new THREE.CylinderGeometry(0.21, 0.21, 0.02, 20).translate(0, 1.23, 0), 0, [0.03, 0.03, 0.03]);
  const neck = tag(new THREE.CylinderGeometry(0.025, 0.035, 0.42, 6).translate(0, 1.42, -0.17), 5, [0.85, 0.62, 0.28]);
  // the horn opens forward (+z) and a little up, from a throat just above the neck
  const place = new THREE.Matrix4().makeTranslation(0, 1.66, 0.12).multiply(new THREE.Matrix4().makeRotationX(-0.45));
  const horn = new THREE.ConeGeometry(0.42, 0.72, 20, 1, true).rotateX(-Math.PI / 2).applyMatrix4(place);
  const brass: [number, number, number] = [0.85, 0.62, 0.28];
  // a glow deep in the throat, so the horn reads as brass with light coming out of it
  const glow = new THREE.CircleGeometry(0.2, 16).applyMatrix4(place);
  return merge([pedestal, cabinet, disc, neck, tag(horn, 5, brass), inside(tag(horn.clone(), 5, brass)), tag(glow, 6, [0.8, 0.5, 0.16])]);
}

/** The same surface seen from the other side (for open shapes, like the inside of a horn). */
function inside(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    const n = a.itemSize;
    const arr = a.array as Float32Array;
    // swap the second and third vertex of every triangle
    for (let t = 0; t < a.count; t += 3) {
      for (let k = 0; k < n; k++) {
        const i = (t + 1) * n + k;
        const j = (t + 2) * n + k;
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }
  }
  const nrm = g.attributes.normal.array as Float32Array;
  for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i];
  return g;
}

/** A light beam: an open, slightly flaring tube one unit tall, scaled per beam. */
export function beamGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(5, 2.6, 1, 18, 1, true).translate(0, 0.5, 0);
  g.deleteAttribute('uv');
  return g;
}
