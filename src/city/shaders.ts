import { BLOCK, BOULEVARD_HALF, CHUNK, CHUNK_BLOCKS, LAMP_OFFSET, LAMP_SPACING, MAX_FOLDS, SIDEWALK, STREET_HALF } from '../core/config';

const f = (n: number) => n.toFixed(4);

/** Shared by every folded object. GPU twin of foldPoint() in src/core/fold.ts. */
export const FOLD_GLSL = /* glsl */ `
#define MAX_FOLDS ${MAX_FOLDS}
uniform int uFoldCount;
uniform vec4 uFoldA[MAX_FOLDS]; // hinge.xz, normal.xz
uniform vec4 uFoldB[MAX_FOLDS]; // angle, radius
uniform float uTime;
uniform vec4 uRipple;           // x, z, start time, strength (the kick shockwave)
uniform float uLimbo;

vec3 foldRotate(vec3 v, vec2 n, float c, float s) {
  float vn = v.x * n.x + v.z * n.y;
  float vu = v.y;
  float rn = vn * c - vu * s;
  return vec3(v.x - vn * n.x + rn * n.x, vn * s + vu * c, v.z - vn * n.y + rn * n.y);
}

void applyFolds(vec2 f, inout vec3 p, inout vec3 nrm) {
  vec2 claim = vec2(0.0);
  for (int i = 0; i < MAX_FOLDS; i++) {
    if (i >= uFoldCount) break;
    vec4 A = uFoldA[i];
    vec4 B = uFoldB[i];
    float d = dot(f - A.xy, A.zw);
    if (d <= 0.0) continue;
    // crossing folds cut the sheet instead of stretching it (see foldPoint)
    if (dot(claim, claim) > 0.5) {
      if (abs(dot(claim, A.zw)) < 0.9) continue;
    } else claim = A.zw;
    float sgn = B.x < 0.0 ? -1.0 : 1.0;
    float absA = abs(B.x);
    float shift = min(d, B.y * absA);
    float a = sgn * min(d / B.y, absA);
    float c = cos(a);
    float s = sin(a);
    vec3 C = vec3(A.x, sgn * B.y, A.y);
    p = foldRotate(p - vec3(shift * A.z, 0.0, shift * A.w) - C, A.zw, c, s) + C;
    nrm = foldRotate(nrm, A.zw, c, s);
  }
}

float ripple(vec2 f) {
  float t = uTime - uRipple.z;
  if (t < 0.0 || t > 6.0) return 0.0;
  float r = t * 260.0;
  float dist = length(f - uRipple.xy);
  float w = (dist - r) / 22.0;
  return exp(-w * w) * uRipple.w * exp(-t * 0.7);
}

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float limboDecay(vec2 f, float seed) {
  if (uLimbo <= 0.0) return 0.0;
  float r = length(f) + (vnoise(f * 0.004) - 0.5) * 360.0;
  return uLimbo * smoothstep(260.0, 820.0, r) * (0.35 + 0.65 * seed);
}
`;

// ---------------------------------------------------------------------------
// Buildings, roofs and chimneys (one unit box, instanced)
// ---------------------------------------------------------------------------

export const BUILDING_VERT_HEAD = /* glsl */ `
attribute vec4 iPos;   // x, base y, z, style
attribute vec4 iSize;  // w, h, d, extra (roof inset / lot width)
attribute vec4 iColor; // rgb, seed
attribute vec2 iAnim;  // height multiplier (architect brush), birth time
varying vec3 vLocal;
varying vec3 vObjN;
varying vec4 vColor;
varying vec4 vInfo;    // style, seed, extra, height
varying vec3 vFabric;
${FOLD_GLSL}

void buildingVertex(out vec3 P, out vec3 N) {
  if (iSize.x <= 0.0) {
    // empty slab slot: collapse to a point and skip the fold loop
    P = vec3(0.0); N = vec3(0.0, 1.0, 0.0);
    vLocal = P; vObjN = N; vColor = vec4(0.0); vInfo = vec4(0.0); vFabric = P;
    return;
  }
  float style = iPos.w;
  float born = smoothstep(iAnim.y, iAnim.y + 1.6, uTime);
  float grow = iAnim.x * born * born * (3.0 - 2.0 * born);
  vec3 size = iSize.xyz;
  size.y *= grow;
  vec3 local = position * size;
  // Bottom faces are never seen from above and z-fight with the underside of a
  // folded sheet, so collapse them to a point.
  if (normal.y < -0.5) local = vec3(0.0, 0.0, 0.0);
  vec3 nrm = normal;
  if (style > 8.5 && style < 9.5) {
    float inset = min(iSize.w, 0.5 * min(size.x, size.z) - 0.05);
    local.xz -= sign(position.xz) * inset * position.y;
    if (abs(normal.y) < 0.5) nrm = normalize(vec3(normal.x * size.y, inset, normal.z * size.y));
  }
  vec3 fab = vec3(iPos.x, iPos.y * grow, iPos.z) + local;

  // Limbo: the building sinks and leans as one piece. Roofs, chimneys and
  // crowns carry their parent's seed and sink by their parent's height, so
  // nothing is left floating above the sea.
  float decay = limboDecay(iPos.xz, iColor.w);
  if (decay > 0.0) {
    float parentH = iPos.y > 0.5 ? iPos.y : iSize.y;
    fab.y -= decay * (parentH * 0.45 + 6.0);
    vec2 lean = vec2(hash12(vec2(iColor.w * 91.0, 3.1)), hash12(vec2(iColor.w * 57.0, 8.7))) - 0.5;
    fab.xz += lean * decay * 0.35 * max(fab.y, 0.0);
  }
  fab.y += ripple(fab.xz) * (1.0 + position.y * 0.6);

  vLocal = local;
  vObjN = normal;
  vColor = iColor;
  vInfo = vec4(style, iColor.w, iSize.w, size.y);
  vFabric = fab;
  P = fab;
  N = nrm;
  applyFolds(fab.xz, P, N);
}
`;

export const BUILDING_FRAG_HEAD = /* glsl */ `
varying vec3 vLocal;
varying vec3 vObjN;
varying vec4 vColor;
varying vec4 vInfo;
varying vec3 vFabric;
uniform float uNight;
uniform float uSnow;
uniform float uTime;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Paints one facade cell. Returns window mask, lit amount and glassiness.
void facade(inout vec3 col, out float win, out float lit, out float glassy, out vec3 litCol) {
  float style = vInfo.x;
  float seed = vInfo.y;
  vec3 an = abs(vObjN);
  col = vColor.rgb;
  win = 0.0; lit = 0.0; glassy = 0.0;
  litCol = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.9, 0.75), hash12(vec2(seed * 91.0, 3.0)));

  if (style > 8.5) {
    if (style < 9.5) {
      float course = step(0.55, fract(vLocal.y * 2.4));
      col *= 0.86 + 0.14 * course;
      if (an.y < 0.5) {
        float u = an.x > 0.5 ? vLocal.z : vLocal.x;
        float cell = fract(u / 3.3 + seed);
        float dormer = step(0.36, cell) * step(cell, 0.64) * step(0.9, vLocal.y) * step(vLocal.y, 3.0) * step(2.0, vInfo.z);
        win = dormer;
        vec2 id = vec2(floor(u / 3.3 + seed), 99.0 + seed * 13.0);
        lit = dormer * step(hash12(id), 0.28);
        col = mix(col, vec3(0.92, 0.94, 0.98), uSnow * 0.85);
      } else {
        col = mix(col, vec3(0.95, 0.96, 1.0), uSnow);
      }
    } else {
      col *= 0.8 + 0.2 * step(0.85, vLocal.y / max(vInfo.w, 0.01));
    }
    return;
  }

  if (an.y > 0.5) {
    col = vec3(0.33, 0.33, 0.34) * (0.8 + 0.2 * hash12(floor(vLocal.xz * 0.4) + seed * 17.0));
    if (style > 0.5 && style < 1.5) col = vec3(0.24, 0.26, 0.28);
    col = mix(col, vec3(0.94, 0.95, 0.98), uSnow);
    return;
  }

  float u = (an.x > 0.5 ? vLocal.z : vLocal.x) + 400.0;
  float v = vLocal.y;
  float H = vInfo.w;

  if (style < 0.5) {
    // Haussmann limestone: shopfront, iron balconies, tall windows, cornice.
    float shopH = 4.6;
    float fh = 3.4;
    float stone = 0.92 + 0.08 * hash12(floor(vec2(u * 1.6, v * 2.5)));
    col *= stone;
    if (v < shopH) {
      float bay = fract(u / 4.2);
      float glass = step(0.12, bay) * step(bay, 0.88) * step(0.25, v) * step(v, 3.3);
      vec3 awning = vec3(0.55, 0.12, 0.1);
      float pick = hash12(vec2(floor(u / 4.2), seed * 31.0));
      if (pick > 0.66) awning = vec3(0.1, 0.3, 0.2); else if (pick > 0.33) awning = vec3(0.12, 0.16, 0.32);
      float aw = step(3.35, v) * step(v, 4.0) * step(0.08, bay) * step(bay, 0.92);
      col = mix(col, awning, aw);
      win = glass;
      // shop interiors: dimmer than the flats above, brighter towards the ceiling
      lit = glass * (0.16 + 0.4 * pick) * (0.45 + 0.55 * smoothstep(0.25, 3.3, v));
      col = mix(col, vec3(0.08, 0.08, 0.09), glass);
    } else {
      float level = floor((v - shopH) / fh);
      float fv = fract((v - shopH) / fh) * fh;
      float cu = fract(u / 3.0);
      float w = step(0.3, cu) * step(cu, 0.72) * step(0.55, fv) * step(fv, 2.75);
      // continuous wrought-iron balconies on the 2nd and 5th floors
      float balcony = (level == 1.0 || level == 4.0) ? step(0.38, fv) * step(fv, 0.85) * (0.6 + 0.4 * step(0.5, fract(u * 3.0))) : 0.0;
      float cornice = step(H - 0.8, v) * step(v, H - 0.3) + step(fh - 0.25, fv) * step(fv, fh) * 0.4;
      col = mix(col, col * 1.08, cornice);
      col = mix(col, vec3(0.12, 0.13, 0.14), w);
      col = mix(col, vec3(0.06, 0.06, 0.07), balcony);
      win = w;
      float on = hash12(vec2(floor(u / 3.0), level) + seed * 57.0);
      lit = w * step(on, 0.42) * (0.4 + on * 1.4) * (0.6 + 0.4 * smoothstep(0.55, 2.75, fv));
    }
  } else if (style < 1.5) {
    // Glass curtain wall.
    float fh = 3.9;
    float level = floor(v / fh);
    float fv = fract(v / fh) * fh;
    float mul = step(0.06, fract(u / 1.6)) * step(fract(u / 1.6), 0.94);
    float spandrel = step(fv, 0.7);
    win = mul * (1.0 - spandrel);
    glassy = 1.0;
    col = mix(col * 0.55, col * 0.35, win);
    float on = hash12(vec2(floor(u / 6.4), level) + seed * 13.0);
    lit = win * step(on, 0.33) * (0.4 + on * 1.8);
    litCol = mix(litCol, vec3(0.75, 0.88, 1.0), 0.6);
  } else if (style < 2.5) {
    // Modernist concrete: ribbon windows.
    float fh = 3.6;
    float level = floor(v / fh);
    float fv = fract(v / fh) * fh;
    float band = step(1.0, fv) * step(fv, 2.9);
    float mul = step(0.08, fract(u / 1.8));
    win = band * mul;
    col *= 0.9 + 0.1 * hash12(floor(vec2(u * 0.5, v * 0.5)) + seed);
    col = mix(col, vec3(0.1, 0.12, 0.14), win);
    float on = hash12(vec2(floor(u / 5.4), level) + seed * 7.0);
    lit = win * step(on, 0.35) * (0.4 + on * 1.7);
  } else {
    // Old-town brick.
    float fh = 3.1;
    float level = floor(v / fh);
    float fv = fract(v / fh) * fh;
    float course = step(0.12, fract(v * 4.0)) * (0.92 + 0.08 * hash12(floor(vec2(u * 2.0 + floor(v * 4.0) * 0.5, v * 4.0))));
    col *= 0.85 + 0.15 * course;
    float cu = fract(u / 2.7);
    float w = step(0.32, cu) * step(cu, 0.68) * step(0.7, fv) * step(fv, 2.4);
    float trim = step(0.28, cu) * step(cu, 0.72) * step(0.6, fv) * step(fv, 2.5) - w;
    col = mix(col, vec3(0.88, 0.86, 0.8), trim);
    col = mix(col, vec3(0.1, 0.1, 0.11), w);
    win = w;
    float on = hash12(vec2(floor(u / 2.7), level) + seed * 23.0);
    lit = w * step(on, 0.45) * (0.4 + on * 1.3);
  }
  // grime towards the street
  col *= 0.82 + 0.18 * smoothstep(0.0, 9.0, v);
  // Procedural patterns have no mipmaps: fade them to their average when a cell is only a few pixels wide.
  float lod = smoothstep(0.25, 0.7, max(fwidth(u), fwidth(v)));
  vec3 avg = vColor.rgb * (style > 0.5 && style < 1.5 ? 0.42 : 0.62);
  col = mix(col, avg, lod);
  win *= 1.0 - lod * 0.6;
  lit *= 1.0 - lod * 0.5;
}
`;

export const BUILDING_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
float winMask; float winLit; float glassy; vec3 litCol;
facade(diffuseColor.rgb, winMask, winLit, glassy, litCol);
`;

export const BUILDING_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.06 + 0.1 * (1.0 - glassy), winMask);
`;
export const BUILDING_FRAG_METAL = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.35 + 0.5 * glassy, winMask);
`;
export const BUILDING_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += litCol * winLit * uNight * 1.4;
`;

// ---------------------------------------------------------------------------
// Ground tiles: streets, sidewalks, parks and plazas are painted procedurally
// ---------------------------------------------------------------------------

export const GROUND_VERT_HEAD = /* glsl */ `
attribute vec4 iChunk;  // origin x, origin z, birth time, unused
attribute vec4 iKinds;  // 16 block kinds, 4 bits each, packed 4 per channel
varying vec3 vFabric;
varying vec4 vKinds;
varying vec2 vChunk;
${FOLD_GLSL}

void groundVertex(out vec3 P, out vec3 N) {
  if (iChunk.w < 0.5) { P = vec3(0.0); N = vec3(0.0, 1.0, 0.0); vFabric = P; vKinds = vec4(0.0); vChunk = vec2(0.0); return; }
  vec3 fab = vec3(iChunk.x + position.x, 0.0, iChunk.y + position.z);
  float sea = limboDecay(fab.xz, 1.0);
  fab.y += ripple(fab.xz) - sea * 0.6 + sin(fab.x * 0.05 + uTime * 0.8) * cos(fab.z * 0.04 + uTime * 0.6) * 0.5 * smoothstep(0.55, 0.9, sea);
  vFabric = fab;
  vKinds = iKinds;
  vChunk = iChunk.xy;
  P = fab;
  N = vec3(0.0, 1.0, 0.0);
  applyFolds(fab.xz, P, N);
}
`;

export const GROUND_FRAG_HEAD = /* glsl */ `
varying vec3 vFabric;
varying vec4 vKinds;
varying vec2 vChunk;
uniform float uNight;
uniform float uSnow;
uniform float uWet;
uniform float uLimbo;
uniform float uTime;
uniform float uShowCreases;
uniform int uFoldCount;
uniform vec4 uFoldA[${MAX_FOLDS}];
uniform vec4 uFoldB[${MAX_FOLDS}];
uniform vec4 uCrease;   // preview hinge (hx, hz, nx, nz)
uniform float uCreaseOn;
uniform vec4 uBrush;    // x, z, radius, on
uniform vec3 uSeaColor;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float halfWidth(float line) { return mod(line, ${f(CHUNK_BLOCKS)}) < 0.5 ? ${f(BOULEVARD_HALF)} : ${f(STREET_HALF)}; }
float blockKind(vec2 f) {
  vec2 b = clamp(floor((f - vChunk) / ${f(BLOCK)}), 0.0, ${f(CHUNK_BLOCKS - 1)});
  float idx = b.x + b.y * ${f(CHUNK_BLOCKS)};
  float ch = floor(idx / 4.0);
  float slot = idx - ch * 4.0;
  float packed = ch < 0.5 ? vKinds.x : ch < 1.5 ? vKinds.y : ch < 2.5 ? vKinds.z : vKinds.w;
  return mod(floor(packed / pow(16.0, slot)), 16.0);
}
float lampPool(float lateral, float along, float hw) {
  float la = floor((along - ${f(LAMP_OFFSET)}) / ${f(LAMP_SPACING)} + 0.5) * ${f(LAMP_SPACING)} + ${f(LAMP_OFFSET)};
  float da = along - la;
  float a = lateral - (hw - 1.0);
  float b = lateral + (hw - 1.0);
  return exp(-(a * a + da * da) / 38.0) + exp(-(b * b + da * da) / 38.0);
}

// Returns albedo; writes roughness, emissive.
vec3 paintGround(vec2 f, out float rough, out vec3 glow) {
  rough = 0.9;
  glow = vec3(0.0);
  vec2 line = floor(f / ${f(BLOCK)} + 0.5);
  vec2 off = f - line * ${f(BLOCK)};
  vec2 dl = abs(off);
  vec2 hw = vec2(halfWidth(line.x), halfWidth(line.y));
  vec2 road = step(dl, hw - ${f(SIDEWALK)});
  vec2 walk = step(dl, hw);
  float n = vnoise(f * 0.7) * 0.5 + vnoise(f * 0.11) * 0.5;

  vec3 asphalt = vec3(0.15, 0.15, 0.16) * (0.85 + 0.3 * n);
  vec3 pavement = vec3(0.6, 0.58, 0.54) * (0.9 + 0.15 * n);
  vec3 col;

  if (walk.x + walk.y > 0.5) {
    if (road.x + road.y > 0.5) {
      col = asphalt;
      rough = mix(0.85, 0.22, uWet);
      // dashed centre lines and zebra crossings
      float dashX = road.x * (1.0 - walk.y) * step(abs(off.x), 0.12) * step(0.5, fract(f.y / 6.0));
      float dashZ = road.y * (1.0 - walk.x) * step(abs(off.y), 0.12) * step(0.5, fract(f.x / 6.0));
      float zebraX = road.x * step(hw.y, dl.y) * step(dl.y, hw.y + 3.5) * step(0.5, fract(f.x / 1.1));
      float zebraZ = road.y * step(hw.x, dl.x) * step(dl.x, hw.x + 3.5) * step(0.5, fract(f.y / 1.1));
      float paint = clamp(dashX + dashZ + zebraX + zebraZ, 0.0, 1.0);
      col = mix(col, vec3(0.85, 0.84, 0.78), paint * 0.85);
    } else {
      vec2 slab = abs(fract(f / 1.5) - 0.5);
      float joint = step(0.46, max(slab.x, slab.y));
      col = pavement * (1.0 - joint * 0.12);
      float curb = (step(dl.x, hw.x - ${f(SIDEWALK)} + 0.3) * walk.x + step(dl.y, hw.y - ${f(SIDEWALK)} + 0.3) * walk.y);
      col = mix(col, vec3(0.72, 0.7, 0.66), clamp(curb, 0.0, 1.0));
      rough = mix(0.8, 0.35, uWet);
    }
  } else {
    float kind = blockKind(f);
    vec2 bc = (floor(f / ${f(BLOCK)}) + 0.5) * ${f(BLOCK)};
    vec2 q = f - bc;
    if (kind < 0.5) {
      col = vec3(0.45, 0.43, 0.4) * (0.9 + 0.2 * n);
    } else if (kind < 1.5) {
      col = mix(vec3(0.24, 0.36, 0.15), vec3(0.34, 0.46, 0.2), n);
      float path = 1.0 - step(2.2, abs(abs(q.x) - abs(q.y)));
      float r = length(q);
      path = max(path, step(abs(r - 11.0), 2.0));
      col = mix(col, vec3(0.72, 0.66, 0.55), path);
      if (r < 6.0) { col = vec3(0.12, 0.3, 0.38); rough = 0.08; }
      else if (r < 7.0) col = vec3(0.7, 0.68, 0.62);
    } else if (kind < 2.5) {
      vec2 cell = floor(f / 3.0);
      col = mix(vec3(0.72, 0.69, 0.62), vec3(0.62, 0.6, 0.55), mod(cell.x + cell.y, 2.0));
      if (length(q) < 4.5) col = vec3(0.5, 0.48, 0.45);
    } else if (kind < 3.5) {
      vec2 g = abs(fract(f / 6.0) - 0.5);
      col = vec3(0.42, 0.43, 0.45) * (0.92 + 0.08 * step(0.47, max(g.x, g.y)));
      rough = mix(0.6, 0.2, uWet);
    } else {
      col = pavement;
    }
  }

  // The circus around the origin, with radiating paving.
  float r0 = length(f);
  if (r0 < 46.0) {
    float ang = atan(f.y, f.x);
    if (r0 < 14.0) col = vec3(0.7, 0.67, 0.6) * (0.92 + 0.08 * step(0.5, fract(ang * 12.0 / 6.2832)));
    else if (r0 < 24.0) col = mix(vec3(0.26, 0.38, 0.17), vec3(0.34, 0.46, 0.2), n);
    else if (r0 < 25.0) col = vec3(0.75, 0.73, 0.68);
    else if (r0 < 40.0) {
      col = asphalt;
      rough = mix(0.85, 0.22, uWet);
      if (abs(r0 - 32.5) < 0.12 && fract(ang * 24.0 / 6.2832) > 0.5) col = vec3(0.85, 0.84, 0.78);
    } else col = pavement * (0.94 + 0.06 * step(0.5, fract(ang * 16.0 / 6.2832)));
  }

  // Street-lamp light pools at night.
  float pools = lampPool(off.x, f.y, hw.x) * walk.x + lampPool(off.y, f.x, hw.y) * walk.y;
  glow += vec3(1.0, 0.72, 0.42) * pools * uNight * 0.45;

  // Snow and rain.
  float snowy = uSnow * (road.x + road.y > 0.5 ? 0.55 : 0.92);
  col = mix(col, vec3(0.9, 0.92, 0.96) * (0.95 + 0.05 * n), snowy);
  col *= 1.0 - 0.35 * uWet;

  // Limbo: the edges of the dream dissolve into a grey sea.
  if (uLimbo > 0.0) {
    float r = length(f) + (vnoise(f * 0.004) - 0.5) * 360.0;
    float sea = uLimbo * smoothstep(560.0, 700.0, r);
    float foam = uLimbo * (1.0 - smoothstep(0.0, 14.0, abs(r - 560.0))) * (0.6 + 0.4 * sin(uTime * 1.5 + f.x * 0.2));
    vec3 water = uSeaColor * (0.85 + 0.25 * vnoise(f * 0.05 + uTime * 0.05));
    col = mix(col, water, sea);
    col = mix(col, vec3(0.9, 0.92, 0.94), foam * 0.6);
    rough = mix(rough, 0.12, sea);
  }
  return col;
}

vec3 creaseGlow(vec2 f) {
  vec3 g = vec3(0.0);
  if (uShowCreases > 0.0) {
    for (int i = 0; i < ${MAX_FOLDS}; i++) {
      if (i >= uFoldCount) break;
      float d = dot(f - uFoldA[i].xy, uFoldA[i].zw);
      float L = uFoldB[i].y * abs(uFoldB[i].x);
      float line = exp(-d * d * 0.6);
      float band = step(0.0, d) * step(d, L) * 0.06;
      float dash = step(0.5, fract(dot(f, vec2(-uFoldA[i].w, uFoldA[i].z)) / 8.0 - uTime * 0.4));
      g += vec3(1.0, 0.72, 0.3) * (line * (0.6 + 0.4 * dash) + band) * uShowCreases;
    }
  }
  if (uCreaseOn > 0.0) {
    float d = dot(f - uCrease.xy, uCrease.zw);
    float side = step(0.0, d) * exp(-d * 0.01) * 0.25;
    g += vec3(0.4, 0.85, 1.0) * (exp(-d * d * 0.5) * 1.5 + side) * uCreaseOn;
  }
  if (uBrush.w > 0.0) {
    float r = length(f - uBrush.xy);
    float br = (r - uBrush.z) * 0.8;
    g += vec3(0.5, 0.9, 1.0) * (exp(-br * br) + step(r, uBrush.z) * 0.08) * uBrush.w;
  }
  return g;
}
`;

export const GROUND_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
float groundRough; vec3 groundGlow;
if (gl_FrontFacing) {
  diffuseColor.rgb = paintGround(vFabric.xz, groundRough, groundGlow);
  groundGlow += creaseGlow(vFabric.xz);
} else {
  // The underside of the dream: dark substrate with a glowing lattice.
  vec2 g = abs(fract(vFabric.xz / 16.0) - 0.5);
  float lat = smoothstep(0.47, 0.5, max(g.x, g.y));
  diffuseColor.rgb = vec3(0.03, 0.03, 0.05);
  groundRough = 0.6;
  groundGlow = vec3(0.25, 0.55, 0.9) * lat * 0.8;
}
`;
export const GROUND_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = groundRough;
`;
export const GROUND_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += groundGlow;
`;

// ---------------------------------------------------------------------------
// Props: trees, lamps, projections (people) and the totem
// ---------------------------------------------------------------------------

export const PROP_VERT_HEAD = /* glsl */ `
attribute vec4 iPosYaw;  // x, y, z, yaw
attribute vec4 iParam;   // scale, tone, birth time or walk phase, spin speed
attribute vec4 iState;   // suspicion, kind (0 tree, 1 lamp, 2 person, 3 totem), unused, unused
attribute float aPart;   // 0 solid, 1 foliage, 2 lamp glass, 3 body, 4 head, 5 metal
attribute vec3 aColor;
varying vec3 vColorV;
varying float vPart;
varying vec2 vTone;      // tone, suspicion
varying vec3 vFabric;
${FOLD_GLSL}

vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 rotAxis(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }

void propVertex(out vec3 P, out vec3 N) {
  if (iParam.x <= 0.0) {
    P = vec3(0.0); N = vec3(0.0, 1.0, 0.0);
    vColorV = P; vPart = 0.0; vTone = vec2(0.0); vFabric = P;
    return;
  }
  float kind = iState.y;
  float scale = iParam.x;
  vec3 local = position;
  vec3 nrm = normal;
  if (kind < 1.5) {
    float born = smoothstep(iParam.z, iParam.z + 1.4, uTime);
    scale *= born;
  }
  if (aPart > 0.5 && aPart < 1.5) {
    float sway = sin(uTime * 1.3 + iPosYaw.x * 0.11 + iPosYaw.z * 0.07) * 0.12 * position.y / 6.0;
    local.x += sway;
    local.z += sway * 0.6;
  }
  if (kind > 1.5 && kind < 2.5) {
    // walking bob and a slight lean into the stride
    float ph = iParam.z;
    local.y += abs(sin(ph)) * 0.05;
    if (position.y < 0.85) local.z += sin(ph) * 0.18 * sign(position.x + 0.0001) * (0.85 - position.y);
  }
  float yaw = iPosYaw.w + uTime * iParam.w;
  local = rotY(local * scale, yaw);
  nrm = rotY(nrm, yaw);
  if (kind > 2.5) {
    // the totem precesses
    float p = uTime * 0.45;
    vec3 axis = vec3(cos(p), 0.0, sin(p));
    float tilt = 0.05 + 0.02 * sin(uTime * 0.7);
    local = rotAxis(local, axis, tilt);
    nrm = rotAxis(nrm, axis, tilt);
  }
  vec3 fab = iPosYaw.xyz + local;
  float decay = limboDecay(iPosYaw.xz, 0.6);
  fab.y -= decay * 14.0;
  fab.y += ripple(fab.xz);
  vColorV = aColor;
  vPart = aPart;
  vTone = vec2(iParam.y, iState.x);
  vFabric = fab;
  P = fab;
  N = nrm;
  applyFolds(iPosYaw.xz, P, N);
}
`;

export const PROP_FRAG_HEAD = /* glsl */ `
varying vec3 vColorV;
varying float vPart;
varying vec2 vTone;
varying vec3 vFabric;
uniform float uNight;
uniform float uSnow;
uniform vec3 uFoliageA;
uniform vec3 uFoliageB;
`;

export const PROP_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
diffuseColor.rgb = vColorV;
float propMetal = 0.0;
float propRough = 0.8;
vec3 propGlow = vec3(0.0);
if (vPart > 0.5 && vPart < 1.5) {
  diffuseColor.rgb = mix(uFoliageA, uFoliageB, vTone.x) * (0.75 + 0.5 * vColorV.g);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), uSnow * 0.7);
} else if (vPart > 1.5 && vPart < 2.5) {
  propGlow = vec3(1.0, 0.78, 0.5) * (0.25 + 3.0 * uNight);
} else if (vPart > 2.5 && vPart < 4.5) {
  vec3 coats[4];
  coats[0] = vec3(0.12, 0.12, 0.14); coats[1] = vec3(0.32, 0.27, 0.22);
  coats[2] = vec3(0.18, 0.22, 0.3); coats[3] = vec3(0.4, 0.38, 0.35);
  int ci = int(floor(vTone.x * 3.999));
  vec3 coat = coats[0];
  if (ci == 1) coat = coats[1]; else if (ci == 2) coat = coats[2]; else if (ci == 3) coat = coats[3];
  if (vPart < 3.5) diffuseColor.rgb = coat;
  float s = vTone.y;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.35, 0.03, 0.03), smoothstep(0.35, 1.0, s));
  propGlow = vec3(0.9, 0.08, 0.05) * smoothstep(0.7, 1.0, s) * (vPart > 3.5 ? 1.2 : 0.15);
} else if (vPart > 4.5) {
  propMetal = 0.9;
  propRough = 0.28;
}
`;
export const PROP_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = propRough;
`;
export const PROP_FRAG_METAL = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = propMetal;
`;
export const PROP_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += propGlow;
`;

// ---------------------------------------------------------------------------
// GPU picking: renders fabric coordinates instead of colour
// ---------------------------------------------------------------------------

export const PICK_FRAG = /* glsl */ `
varying vec3 vPickFabric;
uniform float uKind;
void main() { gl_FragColor = vec4(vPickFabric, uKind); }
`;

export { CHUNK };
