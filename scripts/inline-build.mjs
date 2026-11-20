// Inline the Vite build into one self-contained HTML file (dist-single/index.html).
// Handy for hosts that serve a single page, or for sending the dream as one attachment.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A .glb with its meshopt compression undone (the same data, laid out plainly), or the file as it was if it had none.
 *
 * Decoding meshopt needs WebAssembly, and a page served with a strict script policy (as a claude.ai artifact is)
 * may not compile WebAssembly at all: there the hallway fell back to its painted walls, and the street life kit
 * was not drawn while its footprints still stopped you. A plain file needs no decoder. It is bigger, which only
 * matters on the web, where the compressed one is served.
 */
async function plainGlb(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const EXT = 'EXT_meshopt_compression';
  if (!json.extensionsUsed?.includes(EXT)) return glb;
  const binAt = 20 + jsonLength;
  const bin = glb.subarray(binAt + 8, binAt + 8 + view.getUint32(binAt, true));
  await MeshoptDecoder.ready;
  // every buffer view's bytes, decoded where they were compressed; the file's one real buffer is the GLB's own chunk
  const parts = json.bufferViews.map((v) => {
    const ext = v.extensions?.[EXT];
    if (!ext) {
      if (v.buffer !== 0) throw new Error('plainGlb: a buffer view outside the file');
      return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    }
    if (ext.buffer !== 0) throw new Error('plainGlb: compressed data outside the file');
    const source = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    const out = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, source, ext.mode, ext.filter);
    return out;
  });
  let length = 0;
  json.bufferViews.forEach((v, i) => {
    length = Math.ceil(length / 4) * 4;
    v.buffer = 0;
    v.byteOffset = length;
    v.byteLength = parts[i].length;
    length += parts[i].length;
    if (v.extensions) {
      delete v.extensions[EXT];
      if (!Object.keys(v.extensions).length) delete v.extensions;
    }
  });
  json.buffers = [{ byteLength: length }];
  json.extensionsUsed = json.extensionsUsed.filter((e) => e !== EXT);
  if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter((e) => e !== EXT);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = Math.ceil(text.length / 4) * 4;
  const binPad = Math.ceil(length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonPad + 8 + binPad);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x46546c67, true);
  o.setUint32(4, 2, true);
  o.setUint32(8, out.length, true);
  o.setUint32(12, jsonPad, true);
  o.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonPad);
  out.set(text, 20);
  o.setUint32(20 + jsonPad, binPad, true);
  o.setUint32(24 + jsonPad, 0x004e4942, true);
  json.bufferViews.forEach((v, i) => out.set(parts[i], 28 + jsonPad + v.byteOffset));
  return out;
}
const dist = join(root, 'dist');
let html = readFileSync(join(dist, 'index.html'), 'utf8');

const read = (href) => readFileSync(join(dist, href.replace(/^\.?\//, '')), 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>\n${read(href)}\n</style>`);
// recorded sounds, the hallway's and the street life kit's models and the surface detail sit beside the script as
// files: carry them inside it instead (the models without their compression: see plainGlb)
const TYPES = { opus: 'audio/ogg', glb: 'model/gltf-binary', webp: 'image/webp' };
const BESIDE = /new URL\(([`'"])([^`'"]+\.(opus|glb|webp))\1,\s*import\.meta\.url\)\.href/g;
const inlined = new Map();
for (const [, src] of html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)) {
  for (const [, , file, ext] of read(src).matchAll(BESIDE)) {
    const path = join(dist, dirname(src), file);
    if (inlined.has(path)) continue;
    let bytes = readFileSync(path);
    if (ext === 'glb') {
      const plain = await plainGlb(bytes);
      if (plain !== bytes) console.log(`${file}  ${(bytes.length / 1024).toFixed(0)} kB, ${(plain.length / 1024).toFixed(0)} kB uncompressed`);
      bytes = Buffer.from(plain);
    }
    inlined.set(path, `data:${TYPES[ext]};base64,${bytes.toString('base64')}`);
  }
}
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  let js = read(src).replace(/<\/script/gi, '<\\/script');
  js = js.replace(BESIDE, (_m, _q, file) => JSON.stringify(inlined.get(join(dist, dirname(src), file))));
  return `<script type="module">\n${js}\n</script>`;
});

if (/(src|href)="\.?\/?assets\//.test(html)) throw new Error('an asset reference was left un-inlined');
if (/import\.meta\.url/.test(html)) throw new Error('a file beside the script was left un-inlined');

mkdirSync(join(root, 'dist-single'), { recursive: true });
writeFileSync(join(root, 'dist-single', 'index.html'), html);
console.log(`dist-single/index.html  ${(html.length / 1024).toFixed(0)} kB`);
