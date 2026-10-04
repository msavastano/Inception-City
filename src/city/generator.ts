import { BLOCK, CHUNK, CHUNK_BLOCKS, LAMP_OFFSET, LAMP_SPACING, SLAB, streetHalfWidth } from '../core/config';
import { fbm2, hash3, rng } from '../core/rng';

/**
 * Deterministic city generation. A chunk is a pure function of (seed, cx, cz):
 * nothing is stored, so the city is unbounded and two dreamers with the same
 * seed share exactly the same streets.
 */

export const enum Style {
  Haussmann = 0,
  Glass = 1,
  Concrete = 2,
  Brick = 3,
  Roof = 9,
  Chimney = 10,
}

export const enum BlockKind {
  Perimeter = 0,
  Park = 1,
  Plaza = 2,
  Towers = 3,
  Circus = 4,
}

export interface BuildingRec {
  /** Footprint centre and size in fabric metres. y is the base height. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  style: Style;
  color: [number, number, number];
  seed: number;
  /** Roofs: inset of the mansard slope in metres. Facades: lot width for tint variation. */
  extra: number;
  /** Index (in buildings) of the building this sits on, or -1. Brush edits follow the parent. */
  parent: number;
}

export interface PropRec {
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** 0..1 variation used for colour. */
  tone: number;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export interface ChunkData {
  cx: number;
  cz: number;
  /** BlockKind for each of the CHUNK_BLOCKS² blocks, row-major (bx + bz·4). */
  kinds: number[];
  buildings: BuildingRec[];
  roofs: BuildingRec[];
  trees: PropRec[];
  lamps: PropRec[];
  /** Solid footprints for first-person collision. */
  rects: Rect[];
  circles: Circle[];
  /** Tallest thing in the chunk, for culling and streaming bounds. */
  maxHeight: number;
}

/** Fabric-space extents of the block interior (building line to building line). */
export function blockRect(bx: number, bz: number): Rect {
  return {
    x0: bx * BLOCK + streetHalfWidth(bx),
    x1: (bx + 1) * BLOCK - streetHalfWidth(bx + 1),
    z0: bz * BLOCK + streetHalfWidth(bz),
    z1: (bz + 1) * BLOCK - streetHalfWidth(bz + 1),
  };
}

export function blockKind(bx: number, bz: number, seed: number): BlockKind {
  if ((bx === 0 || bx === -1) && (bz === 0 || bz === -1)) return BlockKind.Circus;
  const r = Math.hypot(bx + 0.5, bz + 0.5);
  const h = hash3(bx, bz, seed + 7);
  const downtown = fbm2(bx * 0.085 + 13.1, bz * 0.085 - 4.7, seed + 11);
  const green = fbm2(bx * 0.12 - 7.3, bz * 0.12 + 2.9, seed + 23);
  if (green > 0.7 || h < 0.06) return BlockKind.Park;
  if (h > 0.965 && r > 2) return BlockKind.Plaza;
  if (downtown > 0.6 && r > 6) return BlockKind.Towers;
  return BlockKind.Perimeter;
}

function districtStyle(bx: number, bz: number, seed: number): Style {
  const downtown = fbm2(bx * 0.085 + 13.1, bz * 0.085 - 4.7, seed + 11);
  const old = fbm2(bx * 0.11 + 31.7, bz * 0.11 + 8.3, seed + 37);
  if (downtown > 0.55 && Math.hypot(bx, bz) > 5) return Style.Concrete;
  if (old < 0.36) return Style.Brick;
  return Style.Haussmann;
}

const STONE: [number, number, number][] = [
  [0.86, 0.8, 0.68],
  [0.9, 0.85, 0.74],
  [0.82, 0.76, 0.66],
  [0.88, 0.82, 0.7],
];
const BRICK: [number, number, number][] = [
  [0.62, 0.32, 0.24],
  [0.55, 0.3, 0.25],
  [0.7, 0.42, 0.3],
  [0.48, 0.28, 0.22],
];
const CONCRETE: [number, number, number][] = [
  [0.74, 0.74, 0.72],
  [0.66, 0.67, 0.68],
  [0.8, 0.78, 0.74],
];
const GLASS: [number, number, number][] = [
  [0.32, 0.46, 0.58],
  [0.3, 0.52, 0.55],
  [0.5, 0.43, 0.34],
  [0.4, 0.44, 0.5],
];

function pick<T>(list: T[], r: number): T {
  return list[Math.floor(r * list.length) % list.length];
}

export function generateChunk(cx: number, cz: number, seed: number): ChunkData {
  const out: ChunkData = {
    cx,
    cz,
    kinds: [],
    buildings: [],
    roofs: [],
    trees: [],
    lamps: [],
    rects: [],
    circles: [],
    maxHeight: 0,
  };

  const addBuilding = (b: BuildingRec) => {
    if (out.buildings.length >= SLAB.building) return false;
    out.buildings.push(b);
    out.maxHeight = Math.max(out.maxHeight, b.y + b.h);
    return true;
  };
  const addRoof = (b: BuildingRec) => {
    if (out.roofs.length >= SLAB.roof) return;
    out.roofs.push(b);
    out.maxHeight = Math.max(out.maxHeight, b.y + b.h);
  };
  const addTree = (t: PropRec) => {
    if (out.trees.length >= SLAB.tree) return;
    out.trees.push(t);
    out.circles.push({ x: t.x, z: t.z, r: 0.45 * t.scale });
  };

  for (let j = 0; j < CHUNK_BLOCKS; j++) {
    for (let i = 0; i < CHUNK_BLOCKS; i++) {
      const bx = cx * CHUNK_BLOCKS + i;
      const bz = cz * CHUNK_BLOCKS + j;
      const kind = blockKind(bx, bz, seed);
      out.kinds.push(kind);
      const rect = blockRect(bx, bz);
      const rand = rng(Math.floor(hash3(bx, bz, seed) * 4294967296));

      if (kind === BlockKind.Perimeter) perimeterBlock(rect, districtStyle(bx, bz, seed), rand, addBuilding, addRoof, out);
      else if (kind === BlockKind.Towers) towerBlock(rect, rand, addBuilding, out);
      else if (kind === BlockKind.Park) parkBlock(rect, rand, addTree);
      else if (kind === BlockKind.Plaza) plazaBlock(rect, rand, addTree);
    }
  }

  // Boulevard trees: each chunk owns the boulevards along its west and south edges.
  const bRand = rng(Math.floor(hash3(cx, cz, seed + 99) * 4294967296));
  const lat = streetHalfWidth(0) - 2.5;
  for (let k = 0; k < CHUNK_BLOCKS; k++) {
    for (const along of [22, 32, 42]) {
      const a = k * BLOCK + along;
      for (const side of [-1, 1]) {
        const tone = bRand();
        addTree({ x: cx * CHUNK + side * lat, z: cz * CHUNK + a, yaw: bRand() * 6.28, scale: 0.9 + tone * 0.35, tone });
        addTree({ x: cx * CHUNK + a, z: cz * CHUNK + side * lat, yaw: bRand() * 6.28, scale: 0.9 + tone * 0.35, tone });
      }
    }
  }

  // Street lamps on every street this chunk owns, both sides.
  for (let k = 0; k < CHUNK_BLOCKS; k++) {
    const line = k * BLOCK;
    const off = streetHalfWidth(k) - 1;
    for (let m = 0; m < CHUNK / LAMP_SPACING; m++) {
      const a = LAMP_OFFSET + m * LAMP_SPACING;
      for (const side of [-1, 1]) {
        if (out.lamps.length + 2 > SLAB.lamp) break;
        out.lamps.push({ x: cx * CHUNK + line + side * off, z: cz * CHUNK + a, yaw: side > 0 ? Math.PI : 0, scale: 1, tone: 0 });
        out.lamps.push({ x: cx * CHUNK + a, z: cz * CHUNK + line + side * off, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2, scale: 1, tone: 0 });
      }
    }
  }

  return out;
}

type Add = (b: BuildingRec) => boolean | void;

function perimeterBlock(rect: Rect, style: Style, rand: () => number, add: Add, addRoof: Add, out: ChunkData): void {
  const params = {
    [Style.Haussmann]: { depth: 14, minLot: 12, maxLot: 26, floor: 3.4, floors: [5, 7], palette: STONE, roof: true },
    [Style.Brick]: { depth: 11, minLot: 8, maxLot: 16, floor: 3.1, floors: [3, 5], palette: BRICK, roof: true },
    [Style.Concrete]: { depth: 15, minLot: 18, maxLot: 40, floor: 3.6, floors: [7, 13], palette: CONCRETE, roof: false },
  }[style as Style.Haussmann | Style.Brick | Style.Concrete];

  const { depth } = params;
  const edgeFloors = () => params.floors[0] + Math.floor(rand() * (params.floors[1] - params.floors[0] + 1));
  const color = pick(params.palette, rand());

  // Edges: south & north span the full width, west & east fill between them.
  const edges: { horizontal: boolean; fixed0: number; fixed1: number; from: number; to: number }[] = [
    { horizontal: true, fixed0: rect.z0, fixed1: rect.z0 + depth, from: rect.x0, to: rect.x1 },
    { horizontal: true, fixed0: rect.z1 - depth, fixed1: rect.z1, from: rect.x0, to: rect.x1 },
    { horizontal: false, fixed0: rect.x0, fixed1: rect.x0 + depth, from: rect.z0 + depth, to: rect.z1 - depth },
    { horizontal: false, fixed0: rect.x1 - depth, fixed1: rect.x1, from: rect.z0 + depth, to: rect.z1 - depth },
  ];

  for (const e of edges) {
    const floors = edgeFloors();
    let a = e.from;
    while (a < e.to - 0.5) {
      let len = params.minLot + rand() * (params.maxLot - params.minLot);
      if (e.to - (a + len) < params.minLot * 0.6) len = e.to - a;
      const lotFloors = Math.max(2, floors + (rand() < 0.22 ? (rand() < 0.5 ? -1 : 1) : 0));
      const h = lotFloors * params.floor + (style === Style.Haussmann ? 1.2 : 0.4);
      const mid = a + len / 2;
      const fc = (e.fixed0 + e.fixed1) / 2;
      const b: BuildingRec = {
        x: e.horizontal ? mid : fc,
        z: e.horizontal ? fc : mid,
        y: 0,
        w: e.horizontal ? len : depth,
        d: e.horizontal ? depth : len,
        h,
        style,
        color: jitter(color, rand),
        seed: rand(),
        extra: len,
        parent: -1,
      };
      if (add(b) === false) return;
      const parent = out.buildings.length - 1;

      if (params.roof) {
        const brick = style === Style.Brick;
        const rh = brick ? 3.2 + rand() * 1.5 : 5.2;
        addRoof({
          ...b,
          y: h,
          h: rh,
          style: Style.Roof,
          color: brick ? [0.55, 0.27, 0.2] : [0.36, 0.4, 0.46],
          extra: brick ? Math.min(b.w, b.d) / 2 - 0.2 : 2.3,
          parent,
        });
        // Chimney stacks: the Paris roofscape.
        const stacks = brick ? 1 : 1 + Math.floor(rand() * 3);
        for (let c = 0; c < stacks; c++) {
          const along = (rand() - 0.5) * (len - 3);
          const across = (rand() < 0.5 ? -1 : 1) * (depth / 2 - (brick ? 2.5 : 1.6));
          addRoof({
            x: e.horizontal ? mid + along : fc + across,
            z: e.horizontal ? fc + across : mid + along,
            y: h,
            w: e.horizontal ? 0.9 + rand() * 1.6 : 0.9,
            d: e.horizontal ? 0.9 : 0.9 + rand() * 1.6,
            h: rh + 1.2,
            style: Style.Chimney,
            color: [0.62, 0.44, 0.36],
            seed: rand(),
            extra: 0,
            parent,
          });
        }
      }
      a += len;
    }
  }
  out.rects.push(rect);
}

function towerBlock(rect: Rect, rand: () => number, add: Add, out: ChunkData): void {
  const w = rect.x1 - rect.x0;
  const d = rect.z1 - rect.z0;
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const color = pick(GLASS, rand());
  const towers: { x: number; z: number; w: number; d: number; h: number }[] = [];
  if (rand() < 0.45) {
    const tw = w * (0.5 + rand() * 0.25);
    const td = d * (0.5 + rand() * 0.25);
    towers.push({ x: cx, z: cz, w: tw, d: td, h: 90 + rand() * 170 });
  } else {
    const tw = w * 0.36;
    const td = d * 0.36;
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      if (rand() < 0.2) continue;
      towers.push({ x: cx + sx * w * 0.24, z: cz + sz * d * 0.24, w: tw, d: td, h: 45 + rand() * 90 });
    }
  }
  for (const t of towers) {
    const glass = rand() < 0.75;
    const col = glass ? jitter(color, rand) : pick(CONCRETE, rand());
    const base: BuildingRec = {
      x: t.x,
      z: t.z,
      y: 0,
      w: t.w,
      d: t.d,
      h: t.h,
      style: glass ? Style.Glass : Style.Concrete,
      color: col,
      seed: rand(),
      extra: 30,
      parent: -1,
    };
    if (add(base) === false) return;
    const parent = out.buildings.length - 1;
    // Setback crown.
    if (rand() < 0.7) {
      const s = 0.55 + rand() * 0.25;
      add({ ...base, y: t.h, w: t.w * s, d: t.d * s, h: 6 + rand() * 18, seed: rand(), parent });
    }
    out.rects.push({ x0: t.x - t.w / 2, x1: t.x + t.w / 2, z0: t.z - t.d / 2, z1: t.z + t.d / 2 });
  }
}

function parkBlock(rect: Rect, rand: () => number, addTree: (t: PropRec) => void): void {
  const n = 14 + Math.floor(rand() * 10);
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  for (let i = 0; i < n; i++) {
    const x = rect.x0 + 3 + rand() * (rect.x1 - rect.x0 - 6);
    const z = rect.z0 + 3 + rand() * (rect.z1 - rect.z0 - 6);
    // keep the diagonal gravel paths and the central fountain clear
    const u = x - cx;
    const v = z - cz;
    if (Math.abs(Math.abs(u) - Math.abs(v)) < 3.5 || Math.hypot(u, v) < 9) continue;
    const tone = rand();
    addTree({ x, z, yaw: rand() * 6.28, scale: 0.85 + rand() * 0.7, tone });
  }
}

function plazaBlock(rect: Rect, rand: () => number, addTree: (t: PropRec) => void): void {
  const inset = 5;
  for (const [x, z] of [
    [rect.x0 + inset, rect.z0 + inset],
    [rect.x1 - inset, rect.z0 + inset],
    [rect.x0 + inset, rect.z1 - inset],
    [rect.x1 - inset, rect.z1 - inset],
  ]) {
    const tone = rand();
    addTree({ x, z, yaw: rand() * 6.28, scale: 1.1, tone });
  }
}

function jitter(c: [number, number, number], rand: () => number): [number, number, number] {
  const k = 0.93 + rand() * 0.12;
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}
