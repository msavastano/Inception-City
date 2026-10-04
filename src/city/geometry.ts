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
