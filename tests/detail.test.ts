import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DETAIL } from '../src/city/detail/manifest';
import { U, foldedMaterial, setSurfaceDetail } from '../src/city/materials';
import { BUILDING_FRAG_COLOR, BUILDING_FRAG_HEAD, GROUND_FRAG_HEAD } from '../src/city/shaders';
import assets from '../ASSETS.md?raw';
import packScript from '../scripts/pack-detail.mjs?raw';

/** Every packed layer, as the bytes the browser will be sent. */
const inlined = import.meta.glob('../src/city/detail/*.webp', { eager: true, query: '?inline', import: 'default' }) as Record<string, string>;
const files = Object.entries(inlined).map(([path, url]) => {
  const bin = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  return { name: path.slice(path.lastIndexOf('/') + 1, -'.webp'.length), bin };
});

/** Width and height of a lossy WebP (RIFF, then a VP8 chunk whose frame header holds them). */
function webpSize(bin: Uint8Array): [number, number] {
  const text = (a: number, b: number) => String.fromCharCode(...bin.subarray(a, b));
  expect(text(0, 4)).toBe('RIFF');
  expect(text(8, 12)).toBe('WEBP');
  expect(text(12, 16)).toBe('VP8 ');
  const at = 20 + 6;
  return [(bin[at] | (bin[at + 1] << 8)) & 0x3fff, (bin[at + 2] | (bin[at + 3] << 8)) & 0x3fff];
}

describe('the surface detail textures', () => {
  it('ships every layer the manifest names, and nothing else', () => {
    expect(files.map((f) => f.name).sort()).toEqual(DETAIL.layers.map((l) => l.name).sort());
  });

  it('keeps each file to four tiles with their wrapped borders', () => {
    const side = 2 * (DETAIL.tile + 2 * DETAIL.gutter);
    for (const f of files) expect(webpSize(f.bin), f.name).toEqual([side, side]);
  });

  it('stays inside the brief\'s budget of 1.5 MB', () => {
    const total = files.reduce((s, f) => s + f.bin.length, 0);
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
  });

  it('lists every source in ASSETS.md, under CC0, and the pack script agrees with the manifest', () => {
    expect(assets).toContain('scripts/pack-detail.mjs');
    for (const l of DETAIL.layers) {
      expect(assets, l.source).toContain(`https://polyhaven.com/a/${l.source}`);
      expect(packScript, l.name).toContain(`name: '${l.name}', id: '${l.source}', metres: ${l.metres},`);
    }
  });
});

describe('the surface detail in the shaders', () => {
  it('names every layer, and paints with each of them somewhere', () => {
    const glsl = BUILDING_FRAG_HEAD + GROUND_FRAG_HEAD;
    DETAIL.layers.forEach((l, i) => {
      const name = `D_${l.name.toUpperCase()}`;
      expect(glsl).toContain(`const float ${name} = ${i}.0;`);
      expect(glsl.split(name).length - 1, name).toBeGreaterThan(1);
    });
  });

  it('reads the detail where every pixel runs (not inside the painters\' branches), with explicit gradients', () => {
    expect(BUILDING_FRAG_COLOR).toMatch(/\nvec4 gDet = surfaceDetail\(\);/);
    expect(GROUND_FRAG_HEAD).toContain('textureGrad(tDetail');
    expect(GROUND_FRAG_HEAD).not.toMatch(/texture\(tDetail/);
  });

  it('compiles in and out of the building and ground materials together, and leaves the others alone', () => {
    const building = foldedMaterial('building');
    const ground = foldedMaterial('ground');
    const prop = foldedMaterial('prop');
    setSurfaceDetail(false);
    expect(building.defines?.DETAIL).toBeUndefined();
    expect(ground.defines?.DETAIL).toBeUndefined();
    setSurfaceDetail(true);
    expect(building.defines?.DETAIL).toBe('');
    expect(ground.defines?.DETAIL).toBe('');
    expect(prop.defines?.DETAIL).toBeUndefined();
  });

  it('starts with a flat stand-in, one texel per layer, that changes nothing', () => {
    const tex = U.tDetail.value;
    expect(tex).toBeInstanceOf(THREE.DataArrayTexture);
    expect(tex.image.depth).toBe(DETAIL.layers.length);
    const data = tex.image.data as Uint8Array;
    for (let l = 0; l < DETAIL.layers.length; l++) {
      // no lean, no change in roughness, and a cavity that reads as 1 once divided by the stored average
      expect(Math.abs(data[l * 4] / 255 - 0.5)).toBeLessThan(0.003);
      expect(Math.abs(data[l * 4 + 1] / 255 - 0.5)).toBeLessThan(0.003);
      expect(Math.abs(data[l * 4 + 2] / 255 - 0.5)).toBeLessThan(0.003);
      expect(Math.abs(data[l * 4 + 3] / 255 / DETAIL.aoMean - 1)).toBeLessThan(0.005);
    }
  });
});
