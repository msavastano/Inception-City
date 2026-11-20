import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHUNK, LANTERN_HEIGHT } from '../core/config';


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

export function lampGeometry(): THREE.BufferGeometry {
  const iron: [number, number, number] = [0.07, 0.09, 0.08];
  const post = tag(new THREE.CylinderGeometry(0.07, 0.13, 4.6, 5, 1, true).translate(0, 2.3, 0), 0, iron);
  const base = tag(new THREE.CylinderGeometry(0.22, 0.26, 0.6, 5, 1, true).translate(0, 0.3, 0), 0, iron);
  const lantern = tag(new THREE.CylinderGeometry(0.26, 0.16, 0.6, 5).translate(0, LANTERN_HEIGHT, 0), 2, [1, 0.9, 0.7]);
  const cap = tag(new THREE.ConeGeometry(0.32, 0.3, 5).translate(0, 5.4, 0), 0, iron);
  return merge([post, base, lantern, cap]);
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

// ---------------------------------------------------------------------------
// The street life kit (src/city/streetLife.ts). Two meshes, each holding every model of its kind; an instance shows
// one of them by variant. A vertex's aPart carries its model as well as its material: part + KIT_STRIDE * (variant + 1),
// and the prop shader collapses the vertices of every model but the instance's own (iState.z). Parts below
// KIT_STRIDE belong to no model, so every other prop's geometry shows whole as before.
//
// The models are made here from a few boxes and cylinders, like the lamps, and kept indexed so each costs the
// vertex shader as little as it can. Each faces +z (out to the street) with its x along the kerb.
// ---------------------------------------------------------------------------

/** aPart = part + KIT_STRIDE * (variant + 1); the prop shader decodes it. */
export const KIT_STRIDE = 10;

type RGB = [number, number, number];

function kitPart(g: THREE.BufferGeometry, part: number, color: RGB | ((i: number) => RGB), variant: number): THREE.BufferGeometry {
  if (!g.index) throw new Error('kit geometry must be indexed');
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set(typeof color === 'function' ? color(i) : color, i * 3);
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part + KIT_STRIDE * (variant + 1)), 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Seen from the other side: reverse every triangle and turn the normals round (for the underside of a parasol). */
function flipped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = g.index!.array as Uint16Array | Uint32Array;
  for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  const nrm = g.attributes.normal.array as Float32Array;
  for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i];
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
/** An upright cylinder from y0 to y1, open at both ends. */
const tube = (r0: number, r1: number, y0: number, y1: number, seg: number, x = 0, z = 0) =>
  new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1, true).translate(x, (y0 + y1) / 2, z);
/** A flat disc facing up. */
const disc = (r: number, y: number, seg: number, x = 0, z = 0) => new THREE.CircleGeometry(r, seg).rotateX(-Math.PI / 2).translate(x, y, z);

// Paint and cloth take their colour from the instance's tone (the prop shader's palettes), the rest from these.
const IRON: RGB = [0.07, 0.09, 0.08];
const PARIS_GREEN: RGB = [0.1, 0.21, 0.16];
const RATTAN: RGB = [0.36, 0.23, 0.12];
const ZINC: RGB = [0.78, 0.77, 0.73];
const STEEL: RGB = [0.55, 0.57, 0.58];
const TYRE: RGB = [0.035, 0.035, 0.035];
/** Part numbers the prop shader knows (src/city/shaders.ts, PROP_FRAG_COLOR). */
const SOLID = 0;
const LAMP_GLASS = 2;
const METAL = 5;
const PAINT = 7;
const CLOTH = 8;

/** A bistro chair: woven seat and back on four thin legs, facing +z (turned by yaw about its centre). */
function chair(x: number, z: number, yaw: number, v: number): THREE.BufferGeometry[] {
  const parts = [
    kitPart(box(0.4, 0.035, 0.4, 0, 0.45, 0), CLOTH, RATTAN, v),
    kitPart(box(0.4, 0.32, 0.03, 0, 0.66, -0.19), CLOTH, RATTAN, v),
    ...[
      [-0.17, -0.17],
      [0.17, -0.17],
      [-0.17, 0.17],
      [0.17, 0.17],
    ].map(([lx, lz]) => kitPart(tube(0.016, 0.014, 0, 0.45, 4, lx, lz), SOLID, RATTAN, v)),
  ];
  for (const p of parts) p.rotateY(yaw).translate(x, 0, z);
  return parts;
}

/** A little round café table: zinc top on an iron stem and foot. */
function table(x: number, z: number, r: number, v: number): THREE.BufferGeometry[] {
  return [
    kitPart(disc(r, 0.73, 12, x, z), METAL, ZINC, v),
    kitPart(tube(r, r, 0.705, 0.73, 12, x, z), METAL, ZINC, v),
    kitPart(tube(0.03, 0.025, 0, 0.705, 5, x, z), SOLID, IRON, v),
    kitPart(disc(0.2, 0.012, 6, x, z), SOLID, IRON, v),
  ];
}

/** The small furniture, one model per Furniture variant (src/city/streetLife.ts). */
export function furnitureGeometry(): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  // 0: café pair against a facade (two chairs facing the street, the table in front of them)
  list.push(...chair(-0.36, -0.22, 0, 0), ...chair(0.36, -0.22, 0, 0), ...table(0, 0.3, 0.28, 0));
  // 1: café table under a parasol, a chair either side
  const canopy = () => new THREE.ConeGeometry(1.25, 0.42, 8, 1, true).translate(0, 2.55, 0);
  list.push(
    ...chair(-0.58, 0, Math.PI / 2, 1),
    ...chair(0.58, 0, -Math.PI / 2, 1),
    ...table(0, 0, 0.32, 1),
    kitPart(tube(0.025, 0.022, 0.73, 2.7, 5), SOLID, STEEL, 1),
    kitPart(canopy(), CLOTH, [0.8, 0.78, 0.7], 1),
    kitPart(flipped(canopy()), CLOTH, [0.8, 0.78, 0.7], 1),
  );
  // 2: three cast-iron bollards along the kerb, each with a knob on top
  for (const bx of [-1.3, 0, 1.3]) {
    list.push(kitPart(tube(0.085, 0.065, 0, 0.72, 6, bx), SOLID, IRON, 2));
    list.push(kitPart(new THREE.ConeGeometry(0.085, 0.12, 6, 1, true).translate(bx, 0.78, 0), METAL, IRON, 2));
  }
  // 3: a bench, wooden slats on iron ends, facing +z
  const wood: RGB = [0.42, 0.28, 0.16];
  list.push(
    kitPart(box(1.6, 0.06, 0.42, 0, 0.45, 0), SOLID, wood, 3),
    kitPart(box(1.6, 0.3, 0.05, 0, 0.72, -0.2), SOLID, wood, 3),
    kitPart(box(0.05, 0.86, 0.46, -0.72, 0.43, -0.02), METAL, IRON, 3),
    kitPart(box(0.05, 0.86, 0.46, 0.72, 0.43, -0.02), METAL, IRON, 3),
  );
  // 4: a hoop of a bicycle rack, and a bicycle leaning against it on the street side
  list.push(
    kitPart(box(0.05, 0.76, 0.05, -0.4, 0.38, 0), METAL, STEEL, 4),
    kitPart(box(0.05, 0.76, 0.05, 0.4, 0.38, 0), METAL, STEEL, 4),
    kitPart(box(0.85, 0.05, 0.05, 0, 0.76, 0), METAL, STEEL, 4),
  );
  const bike: THREE.BufferGeometry[] = [];
  for (const wx of [-0.52, 0.52]) bike.push(kitPart(new THREE.CylinderGeometry(0.34, 0.34, 0.035, 10, 1, true).rotateX(Math.PI / 2).translate(wx, 0.34, 0), SOLID, TYRE, 4));
  const tubeBox = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    return box(len, 0.035, 0.035, 0, 0, 0)
      .rotateZ(Math.atan2(y1 - y0, x1 - x0))
      .translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
  };
  bike.push(
    kitPart(tubeBox(-0.15, 0.34, 0.38, 0.78), PAINT, [0.5, 0.1, 0.1], 4), // down tube
    kitPart(tubeBox(-0.22, 0.82, 0.38, 0.78), PAINT, [0.5, 0.1, 0.1], 4), // top tube
    kitPart(tubeBox(-0.15, 0.34, -0.22, 0.86), PAINT, [0.5, 0.1, 0.1], 4), // seat tube
    kitPart(tubeBox(0.38, 0.86, 0.52, 0.34), PAINT, [0.5, 0.1, 0.1], 4), // fork
    kitPart(box(0.22, 0.05, 0.1, -0.24, 0.9, 0), SOLID, [0.08, 0.06, 0.05], 4), // saddle
    kitPart(box(0.04, 0.04, 0.46, 0.4, 0.98, 0), METAL, STEEL, 4), // handlebar
  );
  // leaning a little against the hoop
  for (const p of bike) p.rotateX(-0.07).translate(0, 0, 0.16);
  list.push(...bike);
  return merge(list);
}

/** One generic car facing +z, of no make: a body in the instance's paint, a glass cabin, two axles of wheels. */
function car(len: number, v: number, cabin: { h: number; len: number; back: number; rake: number }, bodyTop = 0.9): THREE.BufferGeometry[] {
  const w = 1.76;
  const glass = new THREE.BoxGeometry(w * 0.9, cabin.h, cabin.len).translate(0, bodyTop + cabin.h / 2, cabin.back);
  // taper the cabin: narrower at the roof, the windscreen raked back, the rear window a little
  const pos = glass.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < bodyTop + cabin.h / 2) continue;
    pos.setX(i, pos.getX(i) * 0.86);
    const z = pos.getZ(i);
    pos.setZ(i, z > cabin.back ? z - cabin.rake : z + cabin.rake * 0.35);
  }
  glass.computeVertexNormals();
  const roofLen = cabin.len - cabin.rake * 1.35;
  const roofZ = cabin.back - cabin.rake * 0.325;
  const out = [
    kitPart(box(w, bodyTop - 0.28, len, 0, (bodyTop + 0.28) / 2, 0), PAINT, [0.5, 0.5, 0.5], v),
    kitPart(glass, METAL, [0.07, 0.09, 0.11], v),
    kitPart(box(w * 0.78, 0.05, roofLen, 0, bodyTop + cabin.h + 0.02, roofZ), PAINT, [0.5, 0.5, 0.5], v),
    kitPart(box(w * 0.86, 0.1, 0.03, 0, bodyTop - 0.16, len / 2), SOLID, [0.86, 0.85, 0.8], v),
    kitPart(box(w * 0.86, 0.1, 0.03, 0, bodyTop - 0.14, -len / 2), SOLID, [0.5, 0.05, 0.04], v),
  ];
  for (const az of [len / 2 - 0.75, -len / 2 + 0.75]) {
    out.push(kitPart(new THREE.CylinderGeometry(0.31, 0.31, w + 0.02, 8, 1, true).rotateZ(Math.PI / 2).translate(0, 0.31, az), SOLID, TYRE, v));
    for (const side of [-1, 1]) {
      out.push(kitPart(new THREE.CircleGeometry(0.31, 8).rotateY((side * Math.PI) / 2).translate((side * (w + 0.02)) / 2, 0.31, az), METAL, [0.32, 0.33, 0.34], v));
    }
  }
  return out;
}

/** The fixtures and the parked cars, one model per Fixture variant (src/city/streetLife.ts). */
export function fixturesGeometry(): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  // 0: advertising column: a green plinth, three bands of posters, a cornice and a little dome
  const posters: RGB[] = [
    [0.86, 0.8, 0.62],
    [0.74, 0.27, 0.18],
    [0.2, 0.32, 0.52],
  ];
  list.push(kitPart(tube(0.66, 0.62, 0, 0.45, 12), SOLID, PARIS_GREEN, 0));
  posters.forEach((c, i) => list.push(kitPart(tube(0.55, 0.55, 0.45 + i * 0.75, 1.2 + i * 0.75, 12), SOLID, c, 0)));
  list.push(
    kitPart(tube(0.64, 0.68, 2.7, 2.9, 12), METAL, PARIS_GREEN, 0),
    kitPart(new THREE.ConeGeometry(0.66, 0.55, 12, 1, true).translate(0, 3.175, 0), METAL, PARIS_GREEN, 0),
    kitPart(new THREE.ConeGeometry(0.07, 0.32, 6, 1, true).translate(0, 3.55, 0), METAL, PARIS_GREEN, 0),
  );
  // 1: news kiosk: an octagonal booth, a band of magazines all round, a sign that lights at night, a hipped roof
  const mags: RGB[] = [
    [0.8, 0.2, 0.18],
    [0.92, 0.82, 0.3],
    [0.2, 0.45, 0.7],
    [0.9, 0.9, 0.88],
    [0.25, 0.6, 0.35],
  ];
  list.push(
    kitPart(tube(1.0, 1.0, 0, 2.3, 8), SOLID, PARIS_GREEN, 1),
    kitPart(tube(1.03, 1.03, 0.95, 1.7, 8), SOLID, (i) => mags[(i % 9) % mags.length], 1),
    kitPart(tube(1.02, 1.02, 1.95, 2.25, 8), LAMP_GLASS, [0.9, 0.86, 0.7], 1),
    kitPart(tube(1.36, 1.36, 2.22, 2.34, 8), METAL, PARIS_GREEN, 1),
    kitPart(new THREE.ConeGeometry(1.36, 0.75, 8, 1, true).translate(0, 2.71, 0), METAL, PARIS_GREEN, 1),
    kitPart(new THREE.ConeGeometry(0.08, 0.36, 6, 1, true).translate(0, 3.2, 0), METAL, PARIS_GREEN, 1),
  );
  // 2: metro entrance: iron balustrades round a stairwell whose mouth faces +z, two lamp stalks curling in over
  //    the mouth, each with an amber globe, and a blank sign between them
  const stair = new THREE.PlaneGeometry(1.64, 3.3).rotateX(-Math.PI / 2).translate(0, 0.015, 0);
  list.push(kitPart(stair, SOLID, [0.025, 0.025, 0.03], 2));
  for (const sx of [-0.86, 0.86]) {
    list.push(kitPart(box(0.08, 0.06, 3.42, sx, 0.95, 0), METAL, PARIS_GREEN, 2), kitPart(box(0.03, 0.8, 3.36, sx, 0.48, 0), METAL, PARIS_GREEN, 2));
  }
  list.push(kitPart(box(1.8, 0.06, 0.08, 0, 0.95, -1.71), METAL, PARIS_GREEN, 2), kitPart(box(1.72, 0.8, 0.03, 0, 0.48, -1.71), METAL, PARIS_GREEN, 2));
  for (const sx of [-1, 1]) {
    const x = sx * 0.86;
    list.push(kitPart(tube(0.05, 0.04, 0, 1.9, 5, x, 1.71), METAL, PARIS_GREEN, 2));
    list.push(kitPart(tube(0.04, 0.03, 0, 0.7, 5).rotateZ(sx * 0.55).translate(x, 1.9, 1.71), METAL, PARIS_GREEN, 2));
    list.push(kitPart(new THREE.SphereGeometry(0.16, 6, 4).translate(x - sx * 0.37, 2.62, 1.71), LAMP_GLASS, [1.0, 0.6, 0.24], 2));
  }
  list.push(kitPart(box(1.2, 0.3, 0.05, 0, 2.2, 1.71), SOLID, [0.86, 0.76, 0.45], 2));
  // 3 to 5: parked cars (lengths as CAR_LENGTH in src/city/streetLife.ts)
  list.push(...car(3.9, 3, { h: 0.55, len: 2.0, back: -0.35, rake: 0.38 }));
  list.push(...car(4.6, 4, { h: 0.52, len: 2.2, back: -0.2, rake: 0.42 }));
  list.push(...car(4.3, 5, { h: 0.85, len: 3.1, back: -0.5, rake: 0.14 }, 1.05));
  return merge(list);
}
