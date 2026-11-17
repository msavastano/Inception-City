// Inline the Vite build into one self-contained HTML file (dist-single/index.html).
// Handy for hosts that serve a single page, or for sending the dream as one attachment.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
let html = readFileSync(join(dist, 'index.html'), 'utf8');

const read = (href) => readFileSync(join(dist, href.replace(/^\.?\//, '')), 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>\n${read(href)}\n</style>`);
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  let js = read(src).replace(/<\/script/gi, '<\\/script');
  // recorded sounds, the hallway's model and the surface detail sit beside the script as files: carry them inside it instead
  const TYPES = { opus: 'audio/ogg', glb: 'model/gltf-binary', webp: 'image/webp' };
  js = js.replace(/new URL\(([`'"])([^`'"]+\.(opus|glb|webp))\1,\s*import\.meta\.url\)\.href/g, (_m, _q, file, ext) => {
    const data = readFileSync(join(dist, dirname(src), file)).toString('base64');
    return JSON.stringify(`data:${TYPES[ext]};base64,${data}`);
  });
  return `<script type="module">\n${js}\n</script>`;
});

if (/(src|href)="\.?\/?assets\//.test(html)) throw new Error('an asset reference was left un-inlined');
if (/import\.meta\.url/.test(html)) throw new Error('a file beside the script was left un-inlined');

mkdirSync(join(root, 'dist-single'), { recursive: true });
writeFileSync(join(root, 'dist-single', 'index.html'), html);
console.log(`dist-single/index.html  ${(html.length / 1024).toFixed(0)} kB`);
