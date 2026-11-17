import * as THREE from 'three';
import { DETAIL } from './detail/manifest';
import { U } from './materials';

/**
 * The close-up surface detail: the scanned relief, roughness and cavities of asphalt, paving, setts, gravel,
 * limestone and board-marked concrete, from CC0 textures on Poly Haven (scripts/pack-detail.mjs, ASSETS.md).
 * Only the shape of each surface is used; its colour is still painted by the shaders. All the layers live in
 * one texture array (tDetail), so reading any of them is one texture and no extra draw call.
 *
 * Each layer ships as one grey WebP holding four tiles (relief along u, relief along v, roughness, cavities).
 * They are fetched a moment after the first frame, unpacked here into one RGBA layer each, and swapped in for
 * the flat stand-in the shaders start with; if they cannot be loaded the surfaces stay as they were.
 */
let loading: Promise<boolean> | null = null;

/** Fetch and unpack the detail textures, once. Settles true when they are in, false if they could not be loaded. */
export function loadSurfaceDetail(anisotropy: number): Promise<boolean> {
  loading ??= new Promise<boolean>((done) => {
    setTimeout(() => {
      unpack(anisotropy)
        .then((tex) => {
          U.tDetail.value = tex;
          done(true);
        })
        .catch((e) => {
          console.warn('The surface detail did not load; the surfaces stay painted only.', e);
          done(false);
        });
    }, 80);
  });
  return loading;
}

async function unpack(anisotropy: number): Promise<THREE.DataArrayTexture> {
  const { tile, gutter, layers } = DETAIL;
  const cell = tile + 2 * gutter;
  const side = 2 * cell;
  const data = new Uint8Array(tile * tile * 4 * layers.length);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2D canvas to unpack the detail with');
  const images = await Promise.all(
    layers.map(async (layer) => {
      const res = await fetch(layer.url);
      if (!res.ok) throw new Error(`${layer.name}: ${res.status}`);
      return createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    }),
  );
  images.forEach((image, l) => {
    if (image.width !== side || image.height !== side) throw new Error(`${layers[l].name} is ${image.width} x ${image.height}, not ${side}`);
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(image, 0, 0);
    image.close();
    const px = ctx.getImageData(0, 0, side, side).data;
    // the four tiles become the four channels; rows are turned over so that v runs up the image, as the normal maps were made
    for (let c = 0; c < 4; c++) {
      const ox = (c & 1) * cell + gutter;
      const oy = (c >> 1) * cell + gutter;
      for (let y = 0; y < tile; y++) {
        const src = ((oy + y) * side + ox) * 4;
        const dst = ((l * tile + (tile - 1 - y)) * tile) * 4 + c;
        for (let x = 0; x < tile; x++) data[dst + x * 4] = px[src + x * 4];
      }
    }
  });
  const tex = new THREE.DataArrayTexture(data, tile, tile, layers.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Bytes of GPU memory the loaded array takes, mipmaps included. */
export function detailBytes(): number {
  const { tile, layers } = DETAIL;
  return Math.round(tile * tile * 4 * layers.length * (4 / 3));
}
