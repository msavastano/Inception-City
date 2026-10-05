import { BLOCK, BOULEVARD_HALF, CHUNK, CHUNK_BLOCKS, COLLAPSE_RADIUS, LAMP_OFFSET, LAMP_SPACING, MAX_FOLDS, SIDEWALK, STREET_HALF } from '../core/config';

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

// ex and ey are the fabric x and y axes, carried through the same rotations
// (like foldPoint's basis) so callers can take vectors back into fabric space.
void applyFoldsFrame(vec2 f, inout vec3 p, inout vec3 nrm, inout vec3 ex, inout vec3 ey) {
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
    ex = foldRotate(ex, A.zw, c, s);
    ey = foldRotate(ey, A.zw, c, s);
  }
}

void applyFolds(vec2 f, inout vec3 p, inout vec3 nrm) {
  vec3 ex = vec3(1.0, 0.0, 0.0);
  vec3 ey = vec3(0.0, 1.0, 0.0);
  applyFoldsFrame(f, p, nrm, ex, ey);
}

// The camera-to-vertex ray expressed in fabric space (the unfolded sheet), so
// procedural interiors and reflections can be traced as if nothing were folded.
vec3 fabricViewRay(vec3 worldP, vec3 ex, vec3 ey) {
  vec3 v = worldP - cameraPosition;
  return vec3(dot(ex, v), dot(ey, v), dot(cross(ex, ey), v));
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
// Per-building constants are flat: interpolation would wobble their last bits,
// and the hashes that pick lit rooms and furniture would turn that into speckle.
flat varying vec4 vColor;
flat varying vec4 vInfo;    // style, seed, extra, height
varying vec3 vFabric;
varying vec3 vViewF;   // camera-to-surface ray in fabric space (for the rooms behind the windows)
${FOLD_GLSL}

void buildingVertex(out vec3 P, out vec3 N) {
  if (iSize.x <= 0.0) {
    // empty slab slot: collapse to a point and skip the fold loop
    P = vec3(0.0); N = vec3(0.0, 1.0, 0.0);
    vLocal = P; vObjN = N; vColor = vec4(0.0); vInfo = vec4(0.0); vFabric = P; vViewF = N;
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
  vec3 ex = vec3(1.0, 0.0, 0.0);
  vec3 ey = vec3(0.0, 1.0, 0.0);
  applyFoldsFrame(fab.xz, P, N, ex, ey);
  vViewF = fabricViewRay((modelMatrix * vec4(P, 1.0)).xyz, ex, ey);
}
`;

export const BUILDING_FRAG_HEAD = /* glsl */ `
varying vec3 vLocal;
varying vec3 vObjN;
flat varying vec4 vColor;
flat varying vec4 vInfo;
varying vec3 vFabric;
varying vec3 vViewF;
uniform float uNight;
uniform float uSnow;
uniform float uTime;
uniform vec4 uBlast;   // the café explosion: centre x, z (fabric), wave front radius, strength (0 while the dream holds)
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// The room behind the window this pixel belongs to, filled in by facade().
vec2 gRoom;      // position on the room's window wall: along the wall, above its floor (metres)
vec3 gRoomSize;  // width, height, depth (metres)
vec2 gPane;      // position inside the window opening, 0..1
vec2 gRoomId;    // one id per room, shared by all of its windows
float gRoomOn;   // brightness of the room's light, 0 when it is dark
float gRoomKind; // 0 flat, 1 shop, 2 office, 3 attic
float gLod;      // 1 when windows are only a few pixels wide

void setRoom(float along, float width, float y, float height, float depth, vec2 pane, vec2 id, float on, float kind) {
  gRoom = vec2(mod(along, width), y);
  gRoomSize = vec3(width, height, depth);
  gPane = pane;
  gRoomId = id;
  gRoomOn = on;
  gRoomKind = kind;
}

// Paints one facade cell. Returns window mask, lit amount and glassiness.
void facade(inout vec3 col, out float win, out float lit, out float glassy, out vec3 litCol) {
  float style = vInfo.x;
  float seed = vInfo.y;
  vec3 an = abs(vObjN);
  col = vColor.rgb;
  win = 0.0; lit = 0.0; glassy = 0.0; gLod = 0.0;
  setRoom(0.0, 1.0, 0.0, 1.0, 1.0, vec2(0.0), vec2(0.0), 0.0, 0.0);
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
        setRoom(cell * 3.3, 3.3, vLocal.y - 0.3, 2.9, 3.6, vec2((cell - 0.36) / 0.28, (vLocal.y - 0.9) / 2.1), id, lit * 0.8, 3.0);
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
  // a few rooms per building are offices, whatever the facade
  float office = step(0.7, hash12(vec2(seed * 41.0, 5.0)));

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
      setRoom(u, 4.2, v, 4.0, 6.5, vec2((bay - 0.12) / 0.76, (v - 0.25) / 3.05), vec2(floor(u / 4.2), seed * 31.0), 0.3 + 0.5 * pick, 1.0);
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
      // a flat is two windows wide, and its lights are on or off together
      vec2 id = vec2(floor(u / 6.0), level) + seed * 57.0;
      float on = hash12(id);
      float bright = step(on, 0.42) * (0.4 + on * 1.4);
      lit = w * bright * (0.6 + 0.4 * smoothstep(0.55, 2.75, fv));
      setRoom(u, 6.0, fv, fh, 4.5 + 2.0 * hash12(id + 7.0), vec2((cu - 0.3) / 0.42, (fv - 0.55) / 2.2), id, bright, 0.0);
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
    vec2 id = vec2(floor(u / 6.4), level) + seed * 13.0;
    float on = hash12(id);
    float bright = step(on, 0.33) * (0.4 + on * 1.8);
    lit = win * bright;
    litCol = mix(litCol, vec3(0.75, 0.88, 1.0), 0.6);
    setRoom(u, 6.4, fv - 0.7, fh - 0.7, 8.0, vec2(fract(u / 1.6), (fv - 0.7) / (fh - 0.7)), id, bright, 2.0);
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
    vec2 id = vec2(floor(u / 5.4), level) + seed * 7.0;
    float on = hash12(id);
    float bright = step(on, 0.35) * (0.4 + on * 1.7);
    lit = win * bright;
    if (office > 0.5) litCol = mix(litCol, vec3(0.8, 0.9, 1.0), 0.5);
    setRoom(u, 5.4, fv, fh - 0.3, 5.5 + 2.0 * office, vec2(fract(u / 1.8), (fv - 1.0) / 1.9), id, bright, 2.0 * office);
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
    vec2 id = vec2(floor(u / 5.4), level) + seed * 23.0;
    float on = hash12(id);
    float bright = step(on, 0.45) * (0.4 + on * 1.3);
    lit = w * bright;
    setRoom(u, 5.4, fv, fh - 0.1, 4.0 + 1.5 * hash12(id + 3.0), vec2((cu - 0.32) / 0.36, (fv - 0.7) / 1.7), id, bright, 0.0);
  }
  // grime towards the street
  col *= 0.82 + 0.18 * smoothstep(0.0, 9.0, v);
  // Procedural patterns have no mipmaps: fade them to their average when a cell is only a few pixels wide.
  float lod = smoothstep(0.25, 0.7, max(fwidth(u), fwidth(v)));
  vec3 avg = vColor.rgb * (style > 0.5 && style < 1.5 ? 0.42 : 0.62);
  col = mix(col, avg, lod);
  win *= 1.0 - lod * 0.6;
  lit *= 1.0 - lod * 0.5;
  gLod = lod;
}

float box2(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }

// Furniture, seen as a cut-out card standing across the middle of the room.
// Returns coverage and writes its colour and how much it glows on its own.
float furniture(vec2 c, float s, out vec3 fc, out float glow) {
  vec3 S = gRoomSize;
  fc = vec3(0.16, 0.13, 0.11);
  glow = 0.0;
  float m = 0.0;
  if (gRoomKind > 1.5 && gRoomKind < 2.5) {
    // office: rows of desks with glowing monitors
    float cell = fract(c.x / 1.6);
    float desk = step(0.68, c.y) * step(c.y, 0.76) + step(c.y, 0.68) * step(abs(cell - 0.5), 0.03) * 2.0;
    float screen = box2(vec2(cell, c.y), vec2(0.3, 0.84), vec2(0.7, 1.18));
    fc = mix(vec3(0.22), vec3(0.6, 0.75, 1.0), screen);
    glow = screen * 1.6;
    m = clamp(desk + screen, 0.0, 1.0);
  } else if (gRoomKind > 0.5 && gRoomKind < 1.5) {
    // shop: a counter and a display table
    m = box2(c, vec2(0.4, 0.0), vec2(S.x * 0.45, 1.0)) + box2(c, vec2(S.x * 0.6, 0.0), vec2(S.x - 0.4, 0.75));
    fc = mix(vec3(0.3, 0.2, 0.12), vec3(0.6, 0.55, 0.45), step(0.92, c.y) * step(c.x, S.x * 0.45));
  } else if (gRoomKind < 0.5) {
    float pick = fract(s * 7.13);
    float a = 0.4 + fract(s * 3.7) * max(S.x - 2.8, 0.1);
    if (pick < 0.45) {
      // a sofa
      m = box2(c, vec2(a, 0.12), vec2(a + 2.0, 0.5)) + box2(c, vec2(a + 0.1, 0.5), vec2(a + 1.9, 0.88))
        + box2(c, vec2(a - 0.05, 0.12), vec2(a + 0.2, 0.66)) + box2(c, vec2(a + 1.8, 0.12), vec2(a + 2.05, 0.66));
      vec3 cloth[4];
      cloth[0] = vec3(0.32, 0.1, 0.08); cloth[1] = vec3(0.12, 0.2, 0.16); cloth[2] = vec3(0.24, 0.22, 0.2); cloth[3] = vec3(0.12, 0.14, 0.26);
      int ci = int(floor(fract(s * 11.3) * 3.999));
      fc = cloth[0];
      if (ci == 1) fc = cloth[1]; else if (ci == 2) fc = cloth[2]; else if (ci == 3) fc = cloth[3];
    } else if (pick < 0.75) {
      // a table with a chair either side
      m = box2(c, vec2(a, 0.72), vec2(a + 1.3, 0.79)) + box2(c, vec2(a + 0.08, 0.0), vec2(a + 0.14, 0.72)) + box2(c, vec2(a + 1.16, 0.0), vec2(a + 1.22, 0.72))
        + box2(c, vec2(a - 0.5, 0.0), vec2(a - 0.44, 1.0)) + box2(c, vec2(a - 0.5, 0.44), vec2(a - 0.1, 0.5))
        + box2(c, vec2(a + 1.74, 0.0), vec2(a + 1.8, 1.0)) + box2(c, vec2(a + 1.4, 0.44), vec2(a + 1.8, 0.5));
      fc = vec3(0.3, 0.19, 0.11);
    }
    // a floor lamp in some rooms
    if (fract(s * 5.9) < 0.35) {
      float lx = S.x - 0.6;
      float shade = box2(c, vec2(lx - 0.22 + (c.y - 1.45) * 0.3, 1.45), vec2(lx + 0.22 - (c.y - 1.45) * 0.3, 1.75));
      float pole = box2(c, vec2(lx - 0.02, 0.0), vec2(lx + 0.02, 1.45));
      if (shade + pole > 0.5) { fc = mix(vec3(0.1), vec3(1.0, 0.85, 0.6), shade); glow = shade * 2.5 * step(0.01, gRoomOn); }
      m += shade + pole;
    }
    // now and then someone stands looking out: a projection, watching the street
    if (fract(s * 17.7) < 0.07 && gRoomOn > 0.0) {
      float px = S.x * (0.3 + 0.4 * fract(s * 23.1));
      float body = step(abs(c.x - px), 0.2 - 0.06 * smoothstep(1.0, 1.45, c.y)) * step(c.y, 1.5);
      float head = step(length(vec2(c.x - px, c.y - 1.64)), 0.12);
      if (body + head > 0.5) { fc = vec3(0.03); glow = 0.0; }
      m += body + head;
    }
  }
  return clamp(m, 0.0, 1.0);
}

// Interior mapping: the window is a hole into a box-shaped room, traced along
// the view ray so walls, floor, ceiling and furniture shift with parallax as you
// walk past. Returns the surface's colour and writes how strongly the room's own
// light (lamp) and the daylight through the window (day) fall on it.
vec3 roomInterior(vec3 rd, out float lamp, out float day) {
  vec3 S = gRoomSize;
  vec3 o = vec3(gRoom, 0.0);
  vec3 r = vec3(rd.x < 0.0 ? min(rd.x, -1e-4) : max(rd.x, 1e-4), rd.y < 0.0 ? min(rd.y, -1e-4) : max(rd.y, 1e-4), max(rd.z, 1e-4));
  vec3 t3 = (step(0.0, r) * S - o) / r;
  float t = min(min(t3.x, t3.y), t3.z);
  vec3 h = o + r * t;
  float s = hash12(gRoomId * 1.37 + 0.5);

  bool office = gRoomKind > 1.5 && gRoomKind < 2.5;
  bool shop = gRoomKind > 0.5 && gRoomKind < 1.5;
  vec3 walls[6];
  walls[0] = vec3(0.78, 0.7, 0.56); walls[1] = vec3(0.56, 0.62, 0.5); walls[2] = vec3(0.72, 0.54, 0.5);
  walls[3] = vec3(0.56, 0.62, 0.7); walls[4] = vec3(0.78, 0.62, 0.38); walls[5] = vec3(0.8, 0.78, 0.74);
  int wi = int(floor(s * 5.999));
  vec3 wall = walls[5];
  if (wi == 0) wall = walls[0]; else if (wi == 1) wall = walls[1]; else if (wi == 2) wall = walls[2]; else if (wi == 3) wall = walls[3]; else if (wi == 4) wall = walls[4];
  if (office) wall = vec3(0.74, 0.75, 0.76);
  if (shop) wall = fract(s * 4.7) < 0.5 ? vec3(0.36, 0.26, 0.18) : vec3(0.7, 0.68, 0.62);
  // shops line their walls with shelves of goods
  float shelfY = 0.0;
  float stocked = 0.0;
  vec3 goods = vec3(0.0);
  if (shop) {
    shelfY = step(fract(h.y / 0.55), 0.08) * step(h.y, 2.4);
    vec2 item = floor(vec2(h.x + h.z, h.y) * vec2(5.0, 1.8));
    goods = mix(vec3(0.45, 0.4, 0.34), vec3(hash12(item + 1.0), hash12(item + 2.0), hash12(item + 3.0)), 0.55) * 0.75;
    stocked = step(h.y, 2.4) * step(0.35, fract((h.x + h.z) * 5.0)) * 0.8;
  }

  vec3 alb;
  vec3 n;
  float glow = 0.0;
  if (t3.z <= t3.x && t3.z <= t3.y) {
    n = vec3(0.0, 0.0, -1.0);
    alb = wall;
    float d = fract(s * 13.1);
    if (shop) {
      alb = mix(mix(alb, goods, stocked), vec3(0.3, 0.22, 0.15), shelfY);
    } else if (!office) {
      if (d < 0.35) {
        // a framed picture
        float cx = S.x * (0.3 + 0.4 * fract(s * 5.3));
        float fr = box2(h.xy, vec2(cx - 0.45, 1.25), vec2(cx + 0.45, 1.95));
        float art = box2(h.xy, vec2(cx - 0.38, 1.32), vec2(cx + 0.38, 1.88));
        alb = mix(alb, vec3(0.25, 0.18, 0.08), fr);
        alb = mix(alb, mix(vec3(0.2, 0.3, 0.45), vec3(0.6, 0.45, 0.25), fract(s * 9.1 + h.y)), art);
      } else if (d < 0.65) {
        // a bookcase
        float bx = S.x * 0.15;
        float bk = box2(h.xy, vec2(bx, 0.0), vec2(bx + 1.6, 2.2));
        vec2 book = vec2(floor(h.x * 14.0), floor(h.y / 0.44));
        vec3 spines = vec3(hash12(book), hash12(book + 4.0), hash12(book + 9.0) * 0.6) * 0.5 + 0.1;
        float board = step(fract(h.y / 0.44), 0.08);
        alb = mix(alb, mix(spines, vec3(0.28, 0.18, 0.1), board), bk);
      } else if (d < 0.8) {
        // a door
        float dx = S.x * 0.65;
        alb = mix(alb, vec3(0.42, 0.3, 0.2), box2(h.xy, vec2(dx, 0.0), vec2(dx + 0.9, 2.1)));
      }
    }
  } else if (t3.y < t3.x) {
    if (r.y < 0.0) {
      n = vec3(0.0, 1.0, 0.0);
      if (office) alb = vec3(0.3, 0.31, 0.33);
      else if (shop) alb = mix(vec3(0.55, 0.52, 0.48), vec3(0.3, 0.29, 0.28), mod(floor(h.x * 2.0) + floor(h.z * 2.0), 2.0));
      else alb = vec3(0.36, 0.22, 0.12) * (0.85 + 0.15 * step(0.5, fract(h.z * 2.6 + floor(h.x * 0.9) * 0.37)));
    } else {
      n = vec3(0.0, -1.0, 0.0);
      alb = vec3(0.86, 0.84, 0.8);
      if (office) {
        // ceiling light panels
        vec2 g = fract(h.xz / vec2(1.6, 1.8));
        glow = box2(g, vec2(0.2, 0.3), vec2(0.8, 0.7)) * 2.4;
      } else {
        // the pendant lamp
        glow = (1.0 - smoothstep(0.12, 0.22, length(h.xz - S.xz * 0.5))) * 6.0;
      }
    }
  } else {
    n = vec3(r.x < 0.0 ? 1.0 : -1.0, 0.0, 0.0);
    alb = wall * 0.92;
    if (shop) alb = mix(mix(alb, goods, stocked), vec3(0.3, 0.22, 0.15), shelfY);
  }

  // furniture standing across the room
  float zc = S.z * (0.4 + 0.25 * fract(s * 2.9));
  float tc = zc / r.z;
  if (tc < t) {
    vec2 c = o.xy + r.xy * tc;
    vec3 fc;
    float fg;
    if (c.x > 0.0 && c.x < S.x && furniture(c, s, fc, fg) > 0.5) {
      h = vec3(c, zc);
      n = vec3(0.0, 0.0, -1.0);
      alb = fc;
      glow = fg;
    }
  }

  vec3 L = vec3(S.x * 0.5, S.y - 0.35, S.z * 0.5);
  vec3 dl = L - h;
  float dist2 = dot(dl, dl);
  if (office || shop) lamp = 0.55 + 0.45 * max(dot(n, normalize(dl)), 0.0);
  else lamp = 0.12 + 2.2 * max(dot(n, normalize(dl)), 0.0) / (1.0 + 0.35 * dist2);
  lamp += glow;
  day = (0.25 + 0.75 * exp(-h.z * 0.3)) * (n.y > 0.5 ? 1.2 : 1.0);
  return alb;
}

// A wall cracked into cells (Voronoi). x: distance to the nearest crack, yz: the cell's id.
vec3 wallCell(vec2 p) {
  vec2 i = floor(p);
  vec2 fp = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  vec2 id = i;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + 0.1 + 0.8 * vec2(hash12(i + g), hash12(i + g + 17.31)) - fp;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = i + g; }
      else if (d < d2) d2 = d;
    }
  }
  return vec3(sqrt(d2) - sqrt(d1), id);
}

// The café explosion. Where its wave has passed, the wall cracks into cells and
// some of them are blown out. Returns (hole, crack, distance to the hole's edge, passed).
// The chance and the delay match planShards() in src/world/collapse.ts.
vec4 blastWall() {
  if (uBlast.w <= 0.0 || vInfo.x > 8.5 || abs(vObjN.y) > 0.5) return vec4(0.0);
  float dist = length(vFabric.xz - uBlast.xy);
  if (dist > ${f(COLLAPSE_RADIUS)}) return vec4(0.0);
  float u = (abs(vObjN.x) > 0.5 ? vLocal.z : vLocal.x) + vInfo.y * 131.0;
  vec3 c = wallCell(vec2(u / 2.2, vLocal.y / 1.8));
  float h = hash12(c.yz + vInfo.y * 7.0);
  float passed = uBlast.z - dist - h * 10.0;
  if (passed <= 0.0) return vec4(0.0);
  float crack = (1.0 - smoothstep(0.0, 0.025, c.x)) * smoothstep(0.0, 4.0, passed) * uBlast.w;
  float chance = 0.45 * (1.0 - smoothstep(${f(COLLAPSE_RADIUS * 0.4)}, ${f(COLLAPSE_RADIUS)}, dist)) * uBlast.w;
  if (h >= chance) return vec4(0.0, crack, 0.0, uBlast.w);
  return vec4(1.0, 0.0, c.x, uBlast.w);
}

// Curtains, sheers and blinds hang in the window itself. Returns colour and coverage.
vec4 drapes(vec2 p, float s) {
  vec4 res = vec4(0.0);
  if (gRoomKind > 1.5 && gRoomKind < 2.5) {
    // office blinds, part-way down
    float down = 1.0 - fract(s * 3.3) * 1.3;
    float blinds = step(down, p.y) * step(0.3, fract(p.y * 26.0));
    res = vec4(vec3(0.75, 0.76, 0.74), blinds * 0.9 * step(0.4, fract(s * 8.1)));
  } else if (gRoomKind < 0.5 || gRoomKind > 2.5) {
    // Paris sheers
    if (fract(s * 6.7) < 0.4) res = vec4(vec3(0.92, 0.9, 0.85), 0.3);
    // heavy drapes, gathered at the sides
    float drawn = fract(s * 4.1);
    if (drawn > 0.3) {
      float wl = 0.1 + 0.28 * fract(s * 9.7);
      float side = step(p.x, wl) + step(1.0 - wl, p.x);
      vec3 cols[4];
      cols[0] = vec3(0.45, 0.08, 0.07); cols[1] = vec3(0.75, 0.68, 0.52); cols[2] = vec3(0.16, 0.3, 0.2); cols[3] = vec3(0.2, 0.22, 0.4);
      int ci = int(floor(fract(s * 12.7) * 3.999));
      vec3 dc = cols[0];
      if (ci == 1) dc = cols[1]; else if (ci == 2) dc = cols[2]; else if (ci == 3) dc = cols[3];
      dc *= 0.8 + 0.2 * sin(p.x * 70.0);
      if (side > 0.5) res = vec4(dc, 0.95);
    }
  }
  return res;
}
`;

export const BUILDING_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
float winMask; float winLit; float glassy; vec3 litCol;
facade(diffuseColor.rgb, winMask, winLit, glassy, litCol);
// The café explosion: a blown-out cell opens onto the room behind it like a window with no glass.
vec4 blast = blastWall();
float hole = blast.x;
// the torn edge shows the thickness of the wall, and the room is sooty near it
float rim = hole * (1.0 - smoothstep(0.02, 0.06, blast.z));
float soot = mix(1.0, (1.0 - rim) * (0.3 + 0.7 * smoothstep(0.06, 0.35, blast.z)), hole);
// Far away a lit window is a flat warm pane; up close it opens onto a room.
vec3 winGlow = litCol * winLit * 1.4 * uNight * (1.0 - hole);
if ((winMask > 0.01 || hole > 0.5) && gLod < 0.98) {
  vec3 an = abs(vObjN);
  vec3 rd = vec3(an.x > 0.5 ? vViewF.z : vViewF.x, vViewF.y, -dot(vViewF, vObjN));
  float lamp; float day;
  vec3 room = roomInterior(rd, lamp, day);
  float s = hash12(gRoomId * 1.37 + 0.5);
  vec3 light = litCol;
  // a few lit rooms are lit only by a television
  if (fract(s * 31.3) < 0.1 && gRoomKind < 0.5) light = vec3(0.45, 0.6, 1.0) * (0.55 + 0.45 * sin(uTime * 9.0 + sin(uTime * 2.3) * 4.0));
  vec3 nightCol = room * (lamp * light * gRoomOn * 1.1 + 0.012);
  vec3 dayCol = room * day * 0.09;
  if (hole < 0.5) {
    vec4 dr = drapes(clamp(gPane, 0.0, 1.0), s);
    // backlit curtains glow; seen from outside by day they are just cloth
    nightCol = mix(nightCol, dr.rgb * (light * gRoomOn * (dr.a < 0.5 ? 0.5 : 0.3) + 0.01), dr.a);
    dayCol = mix(dayCol, dr.rgb * 0.08, dr.a);
  }
  vec3 near = (nightCol * uNight + dayCol * (1.0 - uNight)) * max(winMask, hole) * soot;
  winGlow = mix(near, winGlow, gLod);
}
if (hole > 0.5) {
  diffuseColor.rgb = mix(vec3(0.03, 0.027, 0.025), vColor.rgb * 0.3, rim);
  winMask = 0.0;
} else {
  diffuseColor.rgb *= 1.0 - blast.y * 0.6 * (1.0 - gLod);
  // the wave blows the glass out of the windows it passes
  winMask *= 1.0 - blast.w;
}
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
totalEmissiveRadiance += winGlow;
`;

// ---------------------------------------------------------------------------
// Ground tiles: streets, sidewalks, parks and plazas are painted procedurally
// ---------------------------------------------------------------------------

export const GROUND_VERT_HEAD = /* glsl */ `
attribute vec4 iChunk;  // origin x, origin z, birth time, unused
attribute vec4 iKinds;  // 16 block kinds, 4 bits each, packed 4 per channel
varying vec3 vFabric;
// flat: one value per tile, passed through untouched rather than interpolated
flat varying vec4 vKinds;
flat varying vec2 vChunk;
varying vec3 vWorldP;  // folded world position (for the wet-street mirror)
varying vec3 vViewF;   // camera-to-ground ray in fabric space (for lamp reflections)
${FOLD_GLSL}

void groundVertex(out vec3 P, out vec3 N) {
  if (iChunk.w < 0.5) { P = vec3(0.0); N = vec3(0.0, 1.0, 0.0); vFabric = P; vKinds = vec4(0.0); vChunk = vec2(0.0); vWorldP = P; vViewF = N; return; }
  vec3 fab = vec3(iChunk.x + position.x, 0.0, iChunk.y + position.z);
  float sea = limboDecay(fab.xz, 1.0);
  fab.y += ripple(fab.xz) - sea * 0.6 + sin(fab.x * 0.05 + uTime * 0.8) * cos(fab.z * 0.04 + uTime * 0.6) * 0.5 * smoothstep(0.55, 0.9, sea);
  vFabric = fab;
  vKinds = iKinds;
  vChunk = iChunk.xy;
  P = fab;
  N = vec3(0.0, 1.0, 0.0);
  vec3 ex = vec3(1.0, 0.0, 0.0);
  vec3 ey = vec3(0.0, 1.0, 0.0);
  applyFoldsFrame(fab.xz, P, N, ex, ey);
  vWorldP = (modelMatrix * vec4(P, 1.0)).xyz;
  vViewF = fabricViewRay(vWorldP, ex, ey);
}
`;

export const GROUND_FRAG_HEAD = /* glsl */ `
varying vec3 vFabric;
flat varying vec4 vKinds;
flat varying vec2 vChunk;
varying vec3 vWorldP;
varying vec3 vViewF;
uniform sampler2D tReflect;  // the city rendered from below the street (see src/fx/reflection.ts)
uniform mat4 uReflMatrix;    // world position -> tReflect coordinates
uniform float uReflOn;       // 0 when there is no mirror this frame
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
  int idx = int(b.x + b.y * ${f(CHUNK_BLOCKS)});
  int ch = idx >> 2;
  float packed = ch == 0 ? vKinds.x : ch == 1 ? vKinds.y : ch == 2 ? vKinds.z : vKinds.w;
  // Integer unpacking: float division by pow(16, slot) can land a hair under a whole number on
  // some GPUs, which flips a block's kind in scattered rows of pixels.
  return float((int(packed + 0.5) >> (4 * (idx & 3))) & 15);
}
// Painted lines have no mipmaps: each one is box-filtered over the pixel's footprint w (from fwidth),
// or distant stripes and checkers alias into moire that crawls as the camera moves.
// Coverage of bands d wide centred on every whole number t.
float bandsInt(float t, float d) { t += 0.5 * d; return floor(t) * d + min(fract(t), d); }
float bands(float t, float d, float w) {
  w = max(w, 1e-4);
  t = fract(t);
  return (bandsInt(t + 0.5 * w, d) - bandsInt(t - 0.5 * w, d)) / w;
}
// Coverage of the single band |x| < h.
float band(float x, float h, float w) {
  w = max(w, 1e-4);
  return (clamp(x + 0.5 * w, -h, h) - clamp(x - 0.5 * w, -h, h)) / w;
}
// mod(floor(p.x) + floor(p.y), 2.0), filtered.
float checker(vec2 p, vec2 w) {
  w = max(w, 1e-4);
  vec2 i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w;
  return 0.5 - 0.5 * i.x * i.y;
}
// How wet this pixel is (0 dry, 1 soaked) and how much of it is standing water.
float gWet = 0.0;
float gPuddle = 0.0;
vec2 gRipple = vec2(0.0);

// Raindrops landing in standing water: expanding rings, returned as a slope.
vec2 rainRipples(vec2 f) {
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 g = f * 1.7 + float(k) * vec2(0.37, 0.71);
    vec2 cell = floor(g);
    vec2 q = fract(g) - 0.5 - (vec2(hash12(cell + 1.3), hash12(cell + 7.1)) - 0.5) * 0.3;
    float life = fract(uTime * 0.8 + hash12(cell + float(k) * 9.0));
    float r = length(q);
    float x = (r - life * 0.32) * 28.0;
    acc += q / max(r, 1e-3) * sin(x) * exp(-x * x * 0.12) * (1.0 - life);
  }
  return acc;
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
  // the pixel's footprint in metres, taken before any per-pixel branch
  vec2 fw = fwidth(f);
  vec2 line = floor(f / ${f(BLOCK)} + 0.5);
  vec2 off = f - line * ${f(BLOCK)};
  vec2 dl = abs(off);
  vec2 hw = vec2(halfWidth(line.x), halfWidth(line.y));
  vec2 road = step(dl, hw - ${f(SIDEWALK)});
  vec2 walk = step(dl, hw);
  // fine grit fades to its average once it is smaller than a pixel, or it sparkles
  float n = mix(vnoise(f * 0.7), 0.5, smoothstep(0.4, 1.2, max(fw.x, fw.y) * 0.7)) * 0.5 + vnoise(f * 0.11) * 0.5;

  vec3 asphalt = vec3(0.15, 0.15, 0.16) * (0.85 + 0.3 * n);
  vec3 pavement = vec3(0.6, 0.58, 0.54) * (0.9 + 0.15 * n);
  vec3 col;
  // paved surfaces hold a film of rain, grass soaks it up; puddles gather on roads and in the gutters
  float paved = 1.0;
  float pn = vnoise(f * 0.13 + 3.7) * 0.65 + vnoise(f * 0.41) * 0.35;
  // puddle edges soften to at least a pixel wide
  float pw = fwidth(pn);
  float pondWater = 0.0;

  if (walk.x + walk.y > 0.5) {
    if (road.x + road.y > 0.5) {
      col = asphalt;
      rough = mix(0.85, 0.22, uWet);
      // dashed centre lines and zebra crossings
      float dashX = road.x * (1.0 - walk.y) * band(off.x, 0.12, fw.x) * bands(f.y / 6.0 - 0.75, 0.5, fw.y / 6.0);
      float dashZ = road.y * (1.0 - walk.x) * band(off.y, 0.12, fw.y) * bands(f.x / 6.0 - 0.75, 0.5, fw.x / 6.0);
      float zebraX = road.x * step(hw.y, dl.y) * step(dl.y, hw.y + 3.5) * bands(f.x / 1.1 - 0.75, 0.5, fw.x / 1.1);
      float zebraZ = road.y * step(hw.x, dl.x) * step(dl.x, hw.x + 3.5) * bands(f.y / 1.1 - 0.75, 0.5, fw.y / 1.1);
      float paint = clamp(dashX + dashZ + zebraX + zebraZ, 0.0, 1.0);
      col = mix(col, vec3(0.85, 0.84, 0.78), paint * 0.85);
      float gutter = max(road.x * step(hw.x - ${f(SIDEWALK)} - 0.8, dl.x), road.y * step(hw.y - ${f(SIDEWALK)} - 0.8, dl.y));
      gPuddle = max(smoothstep(0.6 - pw, 0.66 + pw, pn), gutter * smoothstep(0.42 - pw, 0.5 + pw, pn));
    } else {
      float joint = 1.0 - (1.0 - bands(f.x / 1.5, 0.08, fw.x / 1.5)) * (1.0 - bands(f.y / 1.5, 0.08, fw.y / 1.5));
      col = pavement * (1.0 - joint * 0.12);
      float curb = band(dl.x - (hw.x - ${f(SIDEWALK)} + 0.15), 0.15, fw.x) * walk.x + band(dl.y - (hw.y - ${f(SIDEWALK)} + 0.15), 0.15, fw.y) * walk.y;
      col = mix(col, vec3(0.72, 0.7, 0.66), clamp(curb, 0.0, 1.0));
      rough = mix(0.8, 0.35, uWet);
      gPuddle = smoothstep(0.66 - pw, 0.7 + pw, pn);
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
      paved = path * 0.6;
      if (r < 6.0) { col = vec3(0.12, 0.3, 0.38); rough = 0.08; pondWater = 1.0; }
      else if (r < 7.0) { col = vec3(0.7, 0.68, 0.62); paved = 1.0; }
    } else if (kind < 2.5) {
      col = mix(vec3(0.72, 0.69, 0.62), vec3(0.62, 0.6, 0.55), checker(f / 3.0, fw / 3.0));
      if (length(q) < 4.5) col = vec3(0.5, 0.48, 0.45);
    } else if (kind < 3.5) {
      float seam = 1.0 - (1.0 - bands(f.x / 6.0, 0.06, fw.x / 6.0)) * (1.0 - bands(f.y / 6.0, 0.06, fw.y / 6.0));
      col = vec3(0.42, 0.43, 0.45) * (0.92 + 0.08 * seam);
      rough = mix(0.6, 0.2, uWet);
      gPuddle = smoothstep(0.64 - pw, 0.7 + pw, pn);
    } else {
      col = pavement;
    }
  }

  // The circus around the origin, with radiating paving.
  float r0 = length(f);
  if (r0 < 46.0) {
    // turns around the centre; its footprint comes from fw, since fwidth(atan) spikes at the seam
    float turn = atan(f.y, f.x) / 6.2832;
    float tw = length(fw) / (6.2832 * max(r0, 1e-3));
    paved = 1.0;
    gPuddle = 0.0;
    if (r0 < 14.0) col = vec3(0.7, 0.67, 0.6) * (0.92 + 0.08 * bands(turn * 12.0 - 0.75, 0.5, tw * 12.0));
    else if (r0 < 24.0) { col = mix(vec3(0.26, 0.38, 0.17), vec3(0.34, 0.46, 0.2), n); paved = 0.0; }
    else if (r0 < 25.0) col = vec3(0.75, 0.73, 0.68);
    else if (r0 < 40.0) {
      col = asphalt;
      rough = mix(0.85, 0.22, uWet);
      col = mix(col, vec3(0.85, 0.84, 0.78), band(r0 - 32.5, 0.12, max(fw.x, fw.y)) * bands(turn * 24.0 - 0.75, 0.5, tw * 24.0));
      gPuddle = smoothstep(0.6, 0.66, pn);
    } else col = pavement * (0.94 + 0.06 * bands(turn * 16.0 - 0.75, 0.5, tw * 16.0));
  }

  // Street-lamp light pools at night.
  float pools = lampPool(off.x, f.y, hw.x) * walk.x + lampPool(off.y, f.x, hw.y) * walk.y;
  glow += vec3(1.0, 0.72, 0.42) * pools * uNight * 0.45;

  // Snow and rain.
  float snowy = uSnow * (road.x + road.y > 0.5 ? 0.55 : 0.92);
  col = mix(col, vec3(0.9, 0.92, 0.96) * (0.95 + 0.05 * n), snowy);
  col *= 1.0 - 0.35 * uWet * paved;
  // wet paving scatters less light back: the lamp pools turn into reflections
  glow *= 1.0 - 0.45 * uWet * paved;
  gWet = uWet * max(paved, 0.15);
  gPuddle = max(gPuddle * paved, pondWater) * uWet;
  // standing water is darker and a near-perfect mirror
  col *= 1.0 - 0.45 * gPuddle;
  rough = mix(rough, 0.03, gPuddle);
  // rings from the rain, faded out before they shimmer into noise
  float rippleFade = 1.0 - smoothstep(0.12, 0.4, fwidth(f.x) * 1.7);
  if (gPuddle > 0.01 && rippleFade > 0.0) gRipple = rainRipples(f) * rippleFade;

  // Limbo: the edges of the dream dissolve into a grey sea.
  if (uLimbo > 0.0) {
    float r = length(f) + (vnoise(f * 0.004) - 0.5) * 360.0;
    // No surf line: the streets fade into the sea over 140 m with the city still standing in it,
    // so any line drawn at a fixed radius lands on dry streets and plazas.
    float sea = uLimbo * smoothstep(560.0, 700.0, r);
    vec3 water = uSeaColor * (0.85 + 0.25 * vnoise(f * 0.05 + uTime * 0.05));
    col = mix(col, water, sea);
    rough = mix(rough, 0.12, sea);
    // Limbo's sea mirrors whatever is left of the city
    gWet = max(gWet, sea * 0.8);
    gPuddle = max(gPuddle, sea * 0.6);
  }
  return col;
}

// Wet asphalt smears a light into a long streak pointing at the viewer.
float lampStreak(vec2 d, vec2 dir, float t) {
  float along = dot(d, dir);
  float across = dot(d, vec2(-dir.y, dir.x));
  float wa = 0.1 + 0.01 * t;
  float wl = 1.0 + 0.4 * t;
  return exp(-across * across / (wa * wa) - along * along / (wl * wl)) / (1.0 + 0.03 * t);
}

// The street lamps reflected in the wet street, traced analytically in fabric
// space: follow the reflected view ray up to lantern height and measure how
// close it passes to the nearest lamp on either kind of street. Used when the
// mirror is off (low quality, or high above the city).
vec3 lampReflections(vec2 f, vec3 vd) {
  if (vd.y > -1e-3) return vec3(0.0);
  vec3 r = normalize(vec3(vd.x, -vd.y, vd.z));
  float t = 4.95 / max(r.y, 0.02);
  vec2 q = f + r.xz * t;
  vec2 dir = normalize(r.xz + vec2(1e-5));
  // streaks are longer than the gap between lamps, so take both neighbours on both kerbs
  float lx = floor(q.x / ${f(BLOCK)} + 0.5) * ${f(BLOCK)};
  float lz = floor(q.y / ${f(BLOCK)} + 0.5) * ${f(BLOCK)};
  float hx = halfWidth(lx / ${f(BLOCK)}) - 1.0;
  float hz = halfWidth(lz / ${f(BLOCK)}) - 1.0;
  vec2 k = floor((q - ${f(LAMP_OFFSET)}) / ${f(LAMP_SPACING)}) * ${f(LAMP_SPACING)} + ${f(LAMP_OFFSET)};
  float acc = 0.0;
  for (int i = 0; i < 2; i++) {
    float side = i == 0 ? -1.0 : 1.0;
    for (int j = 0; j < 2; j++) {
      float dk = float(j) * ${f(LAMP_SPACING)};
      acc += lampStreak(q - vec2(lx + side * hx, k.y + dk), dir, t);
      acc += lampStreak(q - vec2(k.x + dk, lz + side * hz), dir, t);
    }
  }
  return vec3(1.0, 0.76, 0.48) * acc;
}

// Samples the mirror, blurred by mip level and smeared vertically into streaks.
vec3 mirrorTaps(vec2 uv, float lod, float streak) {
  vec3 c = textureLod(tReflect, uv, lod).rgb * 0.36;
  c += (textureLod(tReflect, uv + vec2(0.0, streak), lod).rgb + textureLod(tReflect, uv - vec2(0.0, streak), lod).rgb) * 0.2;
  c += (textureLod(tReflect, uv + vec2(0.0, streak * 2.4), lod).rgb + textureLod(tReflect, uv - vec2(0.0, streak * 2.4), lod).rgb) * 0.12;
  return c;
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
// Runs after lighting: on wet, flat street the plain sky reflection gives way to
// the mirrored city (or, without a mirror, to the reflected street lamps).
export const GROUND_FRAG_WET = /* glsl */ `
#include <aomap_fragment>
if (gl_FrontFacing && gWet > 0.001) {
  float wetNV = saturate(dot(geometryNormal, geometryViewDir));
  // a generous Fresnel: a rain-soaked street reads as a mirror long before physics says it should
  float wetF = 0.04 + 0.96 * pow(1.0 - wetNV, 3.0);
  float soak = gWet * mix(0.7, 1.0, gPuddle / max(uWet, 0.3));
  vec3 wn = inverseTransformDirection(geometryNormal, viewMatrix);
  float level = smoothstep(0.985, 0.998, wn.y) * (1.0 - smoothstep(0.25, 0.7, abs(vWorldP.y)));
  float mirrorOn = uReflOn * level;
  if (mirrorOn > 0.001) {
    vec4 rc = uReflMatrix * vec4(vWorldP, 1.0);
    float still = clamp(gPuddle / max(uWet, 0.3), 0.0, 1.0);
    vec2 uv = rc.xy / rc.w + gRipple * 0.012 * still;
    vec3 mirror = mirrorTaps(uv, mix(1.8, 0.2, still), mix(0.016, 0.0015, still));
    reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, mirror * wetF, mirrorOn * soak);
  }
  if (mirrorOn < 0.999) {
    reflectedLight.indirectSpecular += lampReflections(vFabric.xz, vViewF) * (0.1 + 1.6 * uNight) * wetF * soak * (1.0 - mirrorOn);
  }
}
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
// Shards: pieces of wall blown out by the café explosion (src/world/collapse.ts)
// ---------------------------------------------------------------------------

export const SHARD_VERT_HEAD = /* glsl */ `
attribute vec4 aOrigin;  // fabric x, y, z where it left the wall, break time (shard clock)
attribute vec4 aVel;     // velocity (fabric m/s), spin (rad/s)
attribute vec4 aSpin;    // spin axis, yaw of the wall it came from
attribute vec4 aShape;   // width, height, thickness, glass (0 or 1)
attribute vec4 aTint;    // rgb, building seed
attribute float aSink;   // the building's height: in Limbo the shard sinks with it
uniform vec4 uShatter;   // shard clock (s), size (1 whole, 0 gone), gravity (m/s²), unused
varying vec3 vTint;
varying float vGlass;
varying float vEdge;
${FOLD_GLSL}

vec3 shardYaw(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 shardRot(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }

void shardVertex(out vec3 P, out vec3 N) {
  float age = uShatter.x - aOrigin.w;
  if (age <= 0.0 || uShatter.y <= 0.0 || aShape.x <= 0.0) {
    // still part of the wall (or an unused slot)
    P = vec3(0.0); N = vec3(0.0, 1.0, 0.0); vTint = P; vGlass = 0.0; vEdge = 0.0;
    return;
  }
  // It flies on a parabola and stops where it lands on the street.
  float g = max(uShatter.z, 1e-3);
  float rest = 0.3 * aShape.z;
  float land = (aVel.y + sqrt(aVel.y * aVel.y + 2.0 * g * max(aOrigin.y - rest, 0.0))) / g;
  float t = min(age, land);
  vec3 c = aOrigin.xyz + aVel.xyz * t;
  c.y = max(c.y - 0.5 * g * t * t, rest);
  // flat against its wall at first (the slab's faces look along +z), then tumbling
  vec3 local = shardYaw(position * aShape.xyz * uShatter.y, aSpin.w);
  vec3 nrm = shardYaw(normal, aSpin.w);
  float a = aVel.w * t;
  local = shardRot(local, aSpin.xyz, a);
  nrm = shardRot(nrm, aSpin.xyz, a);
  float decay = limboDecay(aOrigin.xz, aTint.w);
  c.y -= decay * (aSink * 0.45 + 6.0);
  vTint = aTint.rgb;
  vGlass = aShape.w;
  vEdge = step(abs(normal.z), 0.5);
  P = c + local;
  N = nrm;
  applyFolds(c.xz, P, N);
}
`;

export const SHARD_FRAG_HEAD = /* glsl */ `
varying vec3 vTint;
varying float vGlass;
varying float vEdge;
`;

export const SHARD_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
// broken edges show the paler stone inside; glass is dark and glossy
diffuseColor.rgb = mix(vTint * (1.0 + 0.18 * vEdge), vec3(0.05, 0.07, 0.08), vGlass);
`;
export const SHARD_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = mix(0.92, 0.06, vGlass);
`;
export const SHARD_FRAG_METAL = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = mix(0.0, 0.7, vGlass);
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
