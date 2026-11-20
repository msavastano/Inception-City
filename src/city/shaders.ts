import {
  BLOCK,
  BOULEVARD_HALF,
  BOULEVARD_TREES,
  CHUNK,
  CHUNK_BLOCKS,
  COLLAPSE_RADIUS,
  GUTTER,
  LAMP_OFFSET,
  LAMP_SPACING,
  LANTERN_HEIGHT,
  MAX_FOLDS,
  PLAZA_TREE_INSET,
  SIDEWALK,
  STREET_HALF,
} from '../core/config';
import { PART, PIECE } from '../people/body';
import { DETAIL } from './detail/manifest';
import { SHAPES } from './trees';

const f = (n: number) => n.toFixed(4);

/**
 * The close-up surface detail (src/city/detail.ts), shared by the ground and the buildings. The painters
 * choose a layer and the surface's coordinates with setDetail(); surfaceDetail() then reads the scanned
 * relief, roughness and cavities there. Without DETAIL (Low quality, or #detail=0) nothing is read.
 */
const DETAIL_GLSL = /* glsl */ `
${DETAIL.layers.map((l, i) => `const float D_${l.name.toUpperCase()} = ${i}.0;\nconst float M_${l.name.toUpperCase()} = ${f(l.metres)};`).join('\n')}
// What the painter chose for this pixel: the layer, where the pixel is on it (metres), the size of one tile
// (metres), how strongly it shows, whether the layer is plain grain (1: read twice, at two scales and turns,
// so that no repeat lines up) or a pattern (0: setts and boards keep their rows), and whether its rows run
// along the surface's second axis (1) rather than its first.
float gDLayer = 0.0;
vec2 gDP = vec2(0.0);
float gDSize = 2.0;
float gDGain = 0.0;
float gDGrain = 0.0;
float gDTurn = 0.0;
void setDetail(float layer, vec2 p, float size, float gain, float grain, float turn) {
  gDLayer = layer; gDP = turn > 0.5 ? p.yx : p; gDSize = size; gDGain = gain; gDGrain = grain; gDTurn = turn;
}
#ifdef DETAIL
uniform highp sampler2DArray tDetail;
uniform vec4 uDetail;  // strength of the relief, strength of the cavities, where the detail starts and finishes fading (metres)
float dHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float dNoise(vec2 p) {
  vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(dHash(i), dHash(i + vec2(1, 0)), u.x), mix(dHash(i + vec2(0, 1)), dHash(i + vec2(1, 1)), u.x), u.y);
}
// One read: the lean along u and v, the change in roughness, the cavity (1 = none). Explicit gradients, because the
// painters choose layers per pixel and texture() inside their branches would have no derivatives to go on.
vec4 detailTap(vec2 uv, vec2 gx, vec2 gy) {
  vec4 t = textureGrad(tDetail, vec3(uv, gDLayer), gx, gy);
  return vec4(t.xy * 2.0 - 1.0, t.z - 0.5, t.w * ${f(1 / DETAIL.aoMean)});
}
// The detail at this pixel, faded with distance and by how strongly the painter asked for it. Call it where every
// pixel runs it (not inside a branch): it takes the derivatives of the surface's coordinates.
vec4 surfaceDetail() {
  vec2 uv = gDP / gDSize;
  vec2 gx = dFdx(uv);
  vec2 gy = dFdy(uv);
  float k = gDGain * (1.0 - smoothstep(uDetail.z, uDetail.w, length(vViewPosition)));
  vec4 d = vec4(0.0, 0.0, 0.0, 1.0);
  if (k > 0.0) {
    // Plain grain is read at two scales, the second 1.4 times larger and turned by a third of a radian, mixed by a
    // slow noise so that no tile repeats exactly. Where the noise has settled on one of them only that one is read.
    float m = gDGrain > 0.5 ? smoothstep(0.35, 0.65, dNoise(uv * 0.43)) : 0.0;
    if (m < 0.999) d = detailTap(uv, gx, gy);
    if (m > 0.001) {
      const mat2 R = mat2(0.9450, 0.3271, -0.3271, 0.9450);
      vec4 e = detailTap(R * uv * 0.71 + vec2(0.37, 0.61), R * gx * 0.71, R * gy * 0.71);
      e.xy = e.xy * R;
      d = m < 0.999 ? mix(d, e, m) : e;
    }
    if (gDTurn > 0.5) d.xy = d.yx;
    d.xy *= k * uDetail.x;
    d.z *= k;
    d.w = mix(1.0, d.w, k * uDetail.y);
  }
  return d;
}
// The surface's own axes in view space (along the first and second coordinate of st), from screen derivatives.
void surfaceAxes(vec2 st, vec3 n, out vec3 T, out vec3 B) {
  vec3 q0 = -dFdx(vViewPosition);
  vec3 q1 = -dFdy(vViewPosition);
  vec2 st0 = dFdx(st);
  vec2 st1 = dFdy(st);
  vec3 q1p = cross(q1, n);
  vec3 q0p = cross(n, q0);
  T = q1p * st0.x + q0p * st1.x;
  B = q1p * st0.y + q0p * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float inv = det > 0.0 ? inversesqrt(det) : 0.0;
  T *= inv;
  B *= inv;
}
#else
vec4 surfaceDetail() { return vec4(0.0, 0.0, 0.0, 1.0); }
#endif
`;

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
uniform vec4 uLook;    // ambient occlusion strength, night glow strength (src/world/look.ts)
uniform vec4 uRelief;  // the walls' relief (only read when RELIEF is defined): depth of the window reveals, strength of the bumps, where the reveals start and finish fading (metres from the eye)
${DETAIL_GLSL}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float box2(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }

// The room behind the window this pixel belongs to, filled in by facade().
vec2 gPaneM;     // size of the window opening (metres)
float gShade;    // 1 in the shade under a shop awning
vec2 gRoom;      // position on the room's window wall: along the wall, above its floor (metres)
vec3 gRoomSize;  // width, height, depth (metres)
vec2 gPane;      // position inside the window opening, 0..1
vec2 gRoomId;    // one id per room, shared by all of its windows
float gRoomOn;   // brightness of the room's light, 0 when it is dark
float gRoomKind; // 0 flat, 1 shop, 2 office, 3 attic
float gLod;      // 1 when windows are only a few pixels wide

// The wall's relief. Nothing here is geometry: the walls are flat boxes, and facade() works out
// what a wall with depth would look like from where the pixel is, the eye is and the sun is.
float gPx;       // metres of wall under one pixel
float gNear;     // 1 close enough to see into the window reveals, 0 past where they have faded out
float gSunFace;  // 1 when the sun stands in front of this wall
vec2 gSunLean;   // per metre of depth, how far a shadow runs along the wall and down it
float gOpen;     // 1 inside a window opening
float gDepth;    // how far back its glass sits (metres)
vec3 gWall;      // the wall's own colour here, for the sides of the opening
vec4 gFrame;     // the window frame: its colour, and the width of its border (metres, 0 for none)
vec2 gPanes;     // leaves across and panes up between its glazing bars
vec2 gSlope;     // how the surface leans: metres out per metre along the wall, and per metre up it
float gCast;     // 0 in the shadow of a ledge that stands out above
float gRail;     // 1 on ironwork that stands in front of the windows

void setRoom(float along, float width, float y, float height, float depth, vec2 pane, vec2 id, float on, float kind) {
  gRoom = vec2(mod(along, width), y);
  gRoomSize = vec3(width, height, depth);
  gPane = pane;
  gRoomId = id;
  gRoomOn = on;
  gRoomKind = kind;
}

// RELIEF is defined on every quality tier but Low (src/city/materials.ts, setWallRelief). Without it the walls are
// flat, as they were before the relief: the helpers below become stubs that return nothing, so all of the relief's
// arithmetic in facade() folds away when the shader is compiled and Low pays nothing for it.
#ifdef RELIEF
// Detail finer than a pixel would sparkle as you walk. 1 while a line w metres wide can still be drawn, 0 once it cannot;
// and the same for a groove that wide, which has to be a few pixels across before its two sides can be told apart.
float fine(float w) { return 1.0 - smoothstep(0.5 * w, 1.5 * w, gPx); }
float carved(float w) { return 1.0 - smoothstep(0.2 * w, 0.6 * w, gPx); }

// The lean of the surface across a rounded joint w metres wide, x metres from its centre line.
float joint(float x, float w) { return clamp(2.0 * x / w, -1.0, 1.0) * step(abs(x), 0.5 * w); }

// A ledge standing 'reach' metres out from the wall shades what is 'below' it (metres), as far down as the sun's height says.
void ledge(float below, float reach) {
  float len = reach * max(gSunLean.y, 0.0);
  if (below >= 0.0 && len > 0.0) gCast = min(gCast, smoothstep(0.75 * len - 0.01, 1.1 * len + 0.02, below));
}

// A surround standing proud of the wall for 'e' metres around an opening (position p in it, size s): the lean of its bevelled outer edge.
vec2 surround(vec2 p, vec2 s, vec2 e) {
  vec2 d = max(-p, p - s) - e;
  float edge = max(d.x, d.y);
  if (edge < -0.03 || edge > 0.0) return vec2(0.0);
  vec2 side = sign(p - 0.5 * s);
  return d.x > d.y ? vec2(-side.x, 0.0) : vec2(0.0, -side.y);
}
#else
float fine(float w) { return 0.0; }
float carved(float w) { return 0.0; }
float joint(float x, float w) { return 0.0; }
void ledge(float below, float reach) {}
vec2 surround(vec2 p, vec2 s, vec2 e) { return vec2(0.0); }
#endif

// Paints one facade cell. Returns window mask, lit amount and glassiness.
void facade(inout vec3 col, out float win, out float lit, out float glassy, out vec3 litCol) {
  float style = vInfo.x;
  float seed = vInfo.y;
  vec3 an = abs(vObjN);
  col = vColor.rgb;
  win = 0.0; lit = 0.0; glassy = 0.0; gLod = 0.0;
  gPaneM = vec2(1.0); gShade = 0.0;
  gOpen = 0.0; gDepth = 0.0; gWall = col; gFrame = vec4(0.0); gPanes = vec2(1.0); gSlope = vec2(0.0); gCast = 1.0; gRail = 0.0;
  setRoom(0.0, 1.0, 0.0, 1.0, 1.0, vec2(0.0), vec2(0.0), 0.0, 0.0);
  litCol = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.9, 0.75), hash12(vec2(seed * 91.0, 3.0)));
  // everything the relief paints here has gone once the pattern itself has
#ifdef RELIEF
  float relief = 1.0 - smoothstep(0.25, 0.7, gPx);
#else
  const float relief = 0.0;
#endif

  if (style > 8.5) {
    if (style < 9.5) {
      float cy = fract(vLocal.y * 2.4);
      float course = step(0.55, cy);
      col *= 0.86 + 0.14 * course;
      if (an.y < 0.5) {
        // each course of slates laps over the one below, and its lower edge is in its own shade
        gSlope.y = 0.9 * step(cy, 0.06) * carved(0.05) * relief * uRelief.y;
        float u = an.x > 0.5 ? vLocal.z : vLocal.x;
        float cell = fract(u / 3.3 + seed);
        vec2 op = vec2((cell - 0.36) * 3.3, vLocal.y - 0.9);
        vec2 os = vec2(0.924, 2.1);
        float dormer = box2(op, vec2(0.0), os) * step(2.0, vInfo.z);
        win = dormer;
        vec2 id = vec2(floor(u / 3.3 + seed), 99.0 + seed * 13.0);
        lit = dormer * step(hash12(id), 0.28);
        setRoom(cell * 3.3, 3.3, vLocal.y - 0.3, 2.9, 3.6, op / os, id, lit * 0.8, 3.0);
        gPaneM = os;
        gSlope.y *= 1.0 - dormer;
        gOpen = dormer; gDepth = 0.16; gWall = col * 0.9; gFrame = vec4(0.8, 0.79, 0.75, 0.055); gPanes = vec2(2.0, 2.0);
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
  // the scanned grain of the wall, in the building's own coordinates (so it stays put when the city folds),
  // shifted per building so that neighbours do not match
  vec2 grainAt = vec2(u, v) + floor(vec2(hash12(vec2(seed * 13.0, 1.7)), hash12(vec2(seed * 29.0, 4.1))) * 8.0) * 1.37;
  // a few rooms per building are offices, whatever the facade
  float office = step(0.7, hash12(vec2(seed * 41.0, 5.0)));
  // the opening this pixel belongs to: where the pixel is in it, and its size (metres)
  vec2 op = vec2(0.0);
  vec2 os = vec2(1.0);
  vec2 roomId = vec2(0.0);

  if (style < 0.5) {
    // Haussmann limestone: shopfront, iron balconies, tall windows, cornice.
    float shopH = 4.6;
    float fh = 3.4;
    // dressed stone in courses, every other one half a block along
    float row = floor(v * 2.5);
    float su = u * 1.6 + 0.5 * mod(row, 2.0);
    col *= 0.92 + 0.08 * hash12(vec2(floor(su), row));
    float bed = (fract(v * 2.5 + 0.5) - 0.5) / 2.5;   // metres from the nearest joint between courses
    float perp = (fract(su + 0.5) - 0.5) / 1.6;       // and from the nearest joint between blocks
    setDetail(D_STONE, grainAt, M_STONE, 1.0, 1.0, 0.0);
    if (v < shopH) {
      float bay = fract(u / 4.2);
      op = vec2((bay - 0.12) * 4.2, v - 0.25);
      os = vec2(3.192, 3.05);
      float glass = box2(op, vec2(0.0), os);
      vec3 awning = vec3(0.55, 0.12, 0.1);
      float pick = hash12(vec2(floor(u / 4.2), seed * 31.0));
      if (pick > 0.66) awning = vec3(0.1, 0.3, 0.2); else if (pick > 0.33) awning = vec3(0.12, 0.16, 0.32);
      float under = step(0.08, bay) * step(bay, 0.92);
      float aw = step(3.35, v) * step(v, 4.0) * under;
      gDGain *= 1.0 - aw;
      // the ground floor is cut into deep bands
      float band = relief * (1.0 - aw);
      gSlope.y = 0.8 * joint(bed, 0.05) * carved(0.05) * band;
      col *= 1.0 - 0.2 * step(abs(bed), 0.02) * fine(0.04) * band;
      col = mix(col, awning, aw);
      // the awning slopes out over the pavement, and shades the shopfront under it
      gSlope.y = mix(gSlope.y, -0.8 * relief, aw);
      if (under > 0.5) ledge(3.35 - v, 0.9);
      gWall = col;
      win = glass;
      roomId = vec2(floor(u / 4.2), seed * 31.0);
      // shop interiors: dimmer than the flats above, brighter towards the ceiling
      lit = glass * (0.16 + 0.4 * pick) * (0.45 + 0.55 * smoothstep(0.25, 3.3, v));
      setRoom(u, 4.2, v, 4.0, 6.5, op / os, roomId, 0.3 + 0.5 * pick, 1.0);
      gDepth = 0.2; gFrame = vec4(0.1, 0.1, 0.11, 0.07); gPanes = vec2(2.0, 1.0);
      // the awning throws its shade down the top of the shop window
      gShade = under * smoothstep(2.3, 3.35, v) * step(v, 3.35);
      col = mix(col, vec3(0.08, 0.08, 0.09), glass);
    } else {
      float level = floor((v - shopH) / fh);
      float fv = fract((v - shopH) / fh) * fh;
      float cu = fract(u / 3.0);
      op = vec2((cu - 0.3) * 3.0, fv - 0.55);
      os = vec2(1.26, 2.2);
      float w = box2(op, vec2(0.0), os);
      // continuous wrought-iron balconies on the 2nd and 5th floors
      bool railed = level == 1.0 || level == 4.0;
      gRail = railed ? step(0.38, fv) * step(fv, 0.85) * (0.6 + 0.4 * step(0.5, fract(u * 3.0))) : 0.0;
      float top = step(H - 0.8, v) * step(v, H - 0.3);
      float course = step(fh - 0.25, fv);
      col = mix(col, col * 1.08, top + course * 0.4);
      // fine joints in the dressed stone
      float ashlar = relief * (1.0 - top) * (1.0 - course);
      gSlope = 0.6 * vec2(joint(perp, 0.022), joint(bed, 0.022)) * carved(0.022) * ashlar;
      col *= 1.0 - 0.1 * max(step(abs(perp), 0.011), step(abs(bed), 0.011)) * fine(0.022) * ashlar;
      // a raised surround frames each window
      gSlope += 0.9 * surround(op, os, vec2(0.14)) * carved(0.06) * relief;
      // the string course under each floor is a half-round, the cornice a deep shelf: both shade the wall beneath them
      gSlope.y = mix(gSlope.y, 1.1 * cos(3.1416 * (fv - fh + 0.25) / 0.25) * relief, course);
      gSlope.y = mix(gSlope.y, (v < H - 0.45 ? 1.3 : 0.0) * relief, top);
      ledge(fh - 0.25 - fv, 0.09);
      ledge(H - 0.8 - v, 0.45);
      // and so do the balconies' stone slabs
      float slab = railed ? step(0.26, fv) * step(fv, 0.38) : 0.0;
      col = mix(col, col * 1.06, slab * relief);
      gSlope.y = mix(gSlope.y, 0.0, slab);
      if (railed) ledge(0.26 - fv, 0.55);
      else if (level == 0.0 || level == 3.0) ledge(fh + 0.26 - fv, 0.55);
      gWall = col;
      col = mix(col, vec3(0.12, 0.13, 0.14), w);
      win = w;
      // a flat is two windows wide, and its lights are on or off together
      roomId = vec2(floor(u / 6.0), level) + seed * 57.0;
      float on = hash12(roomId);
      float bright = step(on, 0.42) * (0.4 + on * 1.4);
      lit = w * bright * (0.6 + 0.4 * smoothstep(0.55, 2.75, fv));
      setRoom(u, 6.0, fv, fh, 4.5 + 2.0 * hash12(roomId + 7.0), op / os, roomId, bright, 0.0);
      gDepth = 0.25; gFrame = vec4(0.8, 0.79, 0.75, 0.06); gPanes = vec2(2.0, 3.0);
    }
  } else if (style < 1.5) {
    // Glass curtain wall: the glass sits a little behind its mullions.
    float fh = 3.9;
    float level = floor(v / fh);
    float fv = fract(v / fh) * fh;
    op = vec2((fract(u / 1.6) - 0.06) * 1.6, fv - 0.7);
    os = vec2(1.408, fh - 0.7);
    win = box2(op, vec2(0.0), os);
    glassy = 1.0;
    gWall = col * 0.55;
    col = mix(col * 0.55, col * 0.35, win);
    roomId = vec2(floor(u / 6.4), level) + seed * 13.0;
    float on = hash12(roomId);
    float bright = step(on, 0.33) * (0.4 + on * 1.8);
    lit = win * bright;
    litCol = mix(litCol, vec3(0.75, 0.88, 1.0), 0.6);
    setRoom(u, 6.4, fv - 0.7, fh - 0.7, 8.0, op / os, roomId, bright, 2.0);
    gDepth = 0.07;
  } else if (style < 2.5) {
    // Modernist concrete: ribbon windows between cast panels.
    float fh = 3.6;
    // cast against boards: one board-marked tile per 2 m panel, its rows level with the panel's edges
    setDetail(D_BOARDS, vec2(grainAt.x, v), M_BOARDS, 1.0, 0.0, 0.0);
    float level = floor(v / fh);
    float fv = fract(v / fh) * fh;
    op = vec2((fract(u / 1.8) - 0.08) * 1.8, fv - 1.0);
    os = vec2(1.656, 1.9);
    win = box2(op, vec2(0.0), os);
    col *= 0.9 + 0.1 * hash12(floor(vec2(u * 0.5, v * 0.5)) + seed);
    // the joints between the panels
    vec2 pj = (fract(vec2(u, v) * 0.5 + 0.5) - 0.5) * 2.0;
    gSlope = 0.7 * vec2(joint(pj.x, 0.03), joint(pj.y, 0.03)) * carved(0.03) * relief;
    col *= 1.0 - 0.14 * max(step(abs(pj.x), 0.015), step(abs(pj.y), 0.015)) * fine(0.03) * relief;
    gWall = col;
    col = mix(col, vec3(0.1, 0.12, 0.14), win);
    roomId = vec2(floor(u / 5.4), level) + seed * 7.0;
    float on = hash12(roomId);
    float bright = step(on, 0.35) * (0.4 + on * 1.7);
    lit = win * bright;
    if (office > 0.5) litCol = mix(litCol, vec3(0.8, 0.9, 1.0), 0.5);
    setRoom(u, 5.4, fv, fh - 0.3, 5.5 + 2.0 * office, op / os, roomId, bright, 2.0 * office);
    gDepth = 0.2; gFrame = vec4(0.15, 0.16, 0.17, 0.05);
  } else {
    // Old-town brick.
    float fh = 3.1;
    // the faces of the bricks have the grain of fired clay, finer than the stone's
    setDetail(D_AGGREGATE, grainAt, 0.8, 1.0, 1.0, 0.0);
    float level = floor(v / fh);
    float fv = fract(v / fh) * fh;
    float cy = fract(v * 4.0);
    float bu = u * 2.0 + floor(v * 4.0) * 0.5;
    float course = step(0.12, cy) * (0.92 + 0.08 * hash12(floor(vec2(bu, v * 4.0))));
    // mortar between the bricks of a course too, while a brick is wide enough to see
    float mortar = fine(0.03) * relief;
    course *= 1.0 - step(fract(bu), 0.05) * mortar;
    col *= 0.85 + 0.15 * course;
    gSlope = 0.55 * vec2(joint((fract(bu) - 0.025) * 0.5, 0.025), joint((cy - 0.06) * 0.25, 0.03)) * carved(0.03) * relief;
    float cu = fract(u / 2.7);
    op = vec2((cu - 0.32) * 2.7, fv - 0.7);
    os = vec2(0.972, 1.7);
    float w = box2(op, vec2(0.0), os);
    vec2 edge = vec2(0.108, 0.1);
    float trim = box2(op, -edge, os + edge) - w;
    col = mix(col, vec3(0.88, 0.86, 0.8), trim);
    if (trim > 0.5) setDetail(D_STONE, grainAt, M_STONE, 1.0, 1.0, 0.0);
    // the stone trim stands proud of the brick, and its sill shades the courses under it
    gSlope = mix(gSlope, vec2(0.0), trim) + 0.9 * surround(op, os, edge) * carved(0.06) * relief;
    if (op.x > -edge.x && op.x < os.x + edge.x) ledge(-edge.y - op.y, 0.07);
    // a corbelled course along the top of the wall
    float cap = step(H - 0.36, v) * step(v, H - 0.06);
    gSlope.y = mix(gSlope.y, (v < H - 0.2 ? 1.0 : 0.0) * relief, cap);
    ledge(H - 0.36 - v, 0.12);
    gWall = vec3(0.84, 0.82, 0.76);
    col = mix(col, vec3(0.1, 0.1, 0.11), w);
    win = w;
    roomId = vec2(floor(u / 5.4), level) + seed * 23.0;
    float on = hash12(roomId);
    float bright = step(on, 0.45) * (0.4 + on * 1.3);
    lit = w * bright;
    setRoom(u, 5.4, fv, fh - 0.1, 4.0 + 1.5 * hash12(roomId + 3.0), op / os, roomId, bright, 0.0);
    gDepth = 0.18; gFrame = vec4(0.82, 0.81, 0.77, 0.055); gPanes = vec2(2.0, 2.0);
  }
  gPaneM = os;
  gOpen = win;
  // grime towards the street
  float grime = 0.82 + 0.18 * smoothstep(0.0, 9.0, v);
  col *= grime;
  gWall *= grime;
  // Procedural patterns have no mipmaps: fade them to their average when a cell is only a few pixels wide.
  float lod = smoothstep(0.25, 0.7, gPx);
  vec3 avg = vColor.rgb * (style > 0.5 && style < 1.5 ? 0.42 : 0.62);
  col = mix(col, avg, lod);
  win *= 1.0 - lod * 0.6;
  lit *= 1.0 - lod * 0.5;
  gRail *= 1.0 - lod;
  // the glass in an opening is flat, whatever the wall around it does
  gSlope *= uRelief.y * (1.0 - gOpen);
  gCast = mix(1.0, gCast, relief);
  gLod = lod;
}

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

// Ambient occlusion for a wall, worked out from where the pixel is (nothing is sampled).
// x: how much of the sky's light reaches it, y: how deep it is in the corner the wall makes with the pavement.
vec2 wallOcclusion() {
  if (vInfo.x > 9.5) return vec2(1.0, 0.0);
  if (vInfo.x > 8.5) {
    // a mansard: the gutter where the slope meets the wall below is the darkest part
    return vec2(mix(0.78, 1.0, smoothstep(0.0, 1.4, vLocal.y)), 0.0);
  }
  if (abs(vObjN.y) > 0.5) return vec2(1.0, 0.0);
  // A street is a canyon: the foot of a wall sees a strip of sky, the cornice sees half of it.
  float open = smoothstep(0.0, 24.0, vFabric.y);
  // and the last metre and a half sits in the corner
  float foot = exp(-max(vLocal.y, 0.0) / 0.55);
  return vec2(mix(0.56, 1.0, open) * (1.0 - 0.42 * foot), foot);
}

// A window sits back in its wall, so its edges are in the wall's shade, most of all under the lintel.
float openingRim() {
  vec2 e = min(gPane, 1.0 - gPane) * gPaneM;
  float lintel = (1.0 - gPane.y) * gPaneM.y;
  float rim = smoothstep(0.0, 0.16, min(e.x, e.y)) * (0.72 + 0.28 * smoothstep(0.0, 0.5, lintel));
  // a rim narrower than a pixel would sparkle as you walk, so it thins out with distance
  vec3 px = fwidth(vLocal);
  float fade = 1.0 - smoothstep(0.06, 0.3, max(px.x + px.z, px.y));
  return mix(1.0, mix(0.5, 1.0, clamp(rim, 0.0, 1.0)), fade);
}

// 1 where x lies inside a span from 0 to 'size', with edges 'soft' wide.
float spanLit(float x, float size, float soft) {
  return smoothstep(-soft, soft, x) * (1.0 - smoothstep(size - soft, size + soft, x));
}

// The window's frame and glazing bars, which stand on the glass. q: position in the opening (metres).
float frameMask(vec2 q) {
  float border = gFrame.a;
  if (border <= 0.0) return 0.0;
  float aa = 0.75 * gPx + 0.002;
  vec2 e = min(q, gPaneM - q);
  float m = 1.0 - smoothstep(border - aa, border + aa, min(e.x, e.y));
  // the stiles where two leaves meet are wider than the glazing bars across them
  vec2 pane = gPaneM / gPanes;
  vec2 d = abs(fract(q / pane + 0.5) - 0.5) * pane;
  vec2 wide = vec2(0.032, 0.016);
  vec2 bars = (1.0 - smoothstep(wide - aa, wide + aa, d)) * min(vec2(1.0), wide / aa) * step(1.5, gPanes);
  return max(m, max(bars.x, bars.y));
}

float streetHalf(float line) { return mod(line, ${f(CHUNK_BLOCKS)}) < 0.5 ? ${f(BOULEVARD_HALF)} : ${f(STREET_HALF)}; }

// The street lamps' light on the facades at night. The lamps stand on a known lattice
// (a metre in from every building line), so the nearest one is found without looking anything up.
float lampWash() {
  if (abs(vObjN.y) > 0.5 || vInfo.x > 8.5 || vFabric.y > 16.0) return 0.0;
  bool xFace = abs(vObjN.x) > 0.5;
  float across = xFace ? vFabric.x : vFabric.z;
  float along = xFace ? vFabric.z : vFabric.x;
  float line = floor(across / ${f(BLOCK)} + 0.5);
  float off = across - line * ${f(BLOCK)};
  // only walls that face that street, and stand on it
  if (-sign(off) * (xFace ? vObjN.x : vObjN.z) < 0.5) return 0.0;
  float lat = abs(abs(off) - (streetHalf(line) - 1.0));
  if (lat > 6.0) return 0.0;
  float da = along - (floor((along - ${f(LAMP_OFFSET)}) / ${f(LAMP_SPACING)} + 0.5) * ${f(LAMP_SPACING)} + ${f(LAMP_OFFSET)});
  float dy = vFabric.y - ${f(LANTERN_HEIGHT - 0.4)};
  float r2 = da * da + dy * dy;
  // a pool of light beside the lantern that is gone before the next lamp's begins, so the night's blue stays between them
  float d = lat + 1.6;
  return d * d * d / pow(d * d + r2, 1.5) / (1.0 + lat * lat * 0.25);
}
`;

export const BUILDING_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
// How much wall is under this pixel, and how the wall lies: its own axes in view space (along it, up it, out of it).
vec3 rAn = abs(vObjN);
float rU = rAn.x > 0.5 ? vLocal.z : vLocal.x;
gPx = max(fwidth(rU), fwidth(vLocal.y));
gNear = 0.0; gSunFace = 0.0; gSunLean = vec2(0.0);
vec3 rT = vec3(0.0);
vec3 rB = vec3(0.0);
bool reliefOn = false;
#if defined(RELIEF) || defined(DETAIL)
reliefOn = rAn.y < 0.5 && vInfo.x < 9.5 && gPx < 0.7;
if (reliefOn) {
#ifdef RELIEF
  gNear = 1.0 - smoothstep(uRelief.z, uRelief.w, length(vViewPosition));
#endif
  vec3 rN = normalize(vNormal);
  vec3 q0 = -dFdx(vViewPosition);
  vec3 q1 = -dFdy(vViewPosition);
  vec2 st0 = dFdx(vec2(rU, vLocal.y));
  vec2 st1 = dFdy(vec2(rU, vLocal.y));
  vec3 q1p = cross(q1, rN);
  vec3 q0p = cross(rN, q0);
  rT = q1p * st0.x + q0p * st1.x;
  rB = q1p * st0.y + q0p * st1.y;
  float det = max(dot(rT, rT), dot(rB, rB));
  float inv = det > 0.0 ? inversesqrt(det) : 0.0;
  rT *= inv;
  rB *= inv;
  // (without axes there is nothing to turn the normal with)
  reliefOn = det > 0.0;
#if defined(RELIEF) && NUM_DIR_LIGHTS > 0
  // where the sun (the moon, at night) stands from the wall's point of view
  vec3 sunV = directionalLights[0].direction;
  vec3 sunW = vec3(dot(sunV, rT), dot(sunV, rB), dot(sunV, rN));
  gSunFace = smoothstep(0.0, 0.08, sunW.z);
  gSunLean = clamp(sunW.xy / max(sunW.z, 0.1), -6.0, 6.0);
#endif
}
#endif
float winMask; float winLit; float glassy; vec3 litCol;
facade(diffuseColor.rgb, winMask, winLit, glassy, litCol);
// The scanned grain lies on the wall's face only: not on the glass, nor in the openings, nor on the
// ironwork, nor in the holes the blast makes. It is read at the end, where every pixel runs it.
float dWall = 1.0 - winMask;
vec2 wallAO = wallOcclusion();
// The café explosion: a blown-out cell opens onto the room behind it like a window with no glass.
vec4 blast = blastWall();
float hole = blast.x;
// the torn edge shows the thickness of the wall, and the room is sooty near it
float rim = hole * (1.0 - smoothstep(0.02, 0.06, blast.z));
float soot = mix(1.0, (1.0 - rim) * (0.3 + 0.7 * smoothstep(0.06, 0.35, blast.z)), hole);

// The glass sits back in the wall. Follow the line of sight in from the wall's face: it either
// meets a side of the opening first (the reveal: stone, lit or shaded by where the sun is), or
// reaches the glass further along than where it went in, which is what makes the window a hole.
vec3 reliefN = vec3(-gSlope, 1.0);
float sunShade = gCast;
float revealAO = 1.0;
float frame = 0.0;
vec3 revealGlow = vec3(0.0);
vec3 rd = vec3(rAn.x > 0.5 ? vViewF.z : vViewF.x, vViewF.y, -dot(vViewF, vObjN));
float revealDepth = 0.0;
#ifdef RELIEF
revealDepth = gDepth * uRelief.x * gNear;
if (gOpen > 0.5 && hole < 0.5 && revealDepth > 0.001) {
  float soft = 0.012 + gPx;
  vec2 pm = gPane * gPaneM;
  vec2 k = rd.xy / max(rd.z, 1e-3);
  vec2 ks = vec2(abs(k.x) > 1e-5 ? k.x : 1e-5, abs(k.y) > 1e-5 ? k.y : 1e-5);
  // how deep the line of sight is when it meets a side of the opening, and its sill or lintel
  vec2 zSide = (step(0.0, ks) * gPaneM - pm) / ks;
  float z = min(zSide.x, zSide.y);
  if (z < revealDepth) {
    vec2 h = pm + k * z;
    float sunlit;
    if (zSide.x < zSide.y) {
      reliefN = vec3(-sign(ks.x), 0.0, 0.0);
      sunlit = spanLit(h.y + gSunLean.y * z, gPaneM.y, soft);
    } else {
      reliefN = vec3(0.0, -sign(ks.y), 0.0);
      sunlit = spanLit(h.x + gSunLean.x * z, gPaneM.x, soft);
    }
    sunShade *= sunlit * gSunFace;
    revealAO = mix(1.0, 0.62, z / revealDepth);
    diffuseColor.rgb = gWall;
    // a lit room spills a little of its light onto the stone
    revealGlow = gWall * litCol * (gRoomOn * 0.25 * uNight * z / revealDepth);
    winMask = 0.0;
    winLit = 0.0;
  } else {
    vec2 q = pm + k * revealDepth;
    gRoom += q - pm;
    gPane = q / gPaneM;
    // the edge of the wall throws its shadow across the glass and whatever hangs behind it
    vec2 e = q + gSunLean * revealDepth;
    sunShade *= spanLit(e.x, gPaneM.x, soft) * spanLit(e.y, gPaneM.y, soft);
    frame = frameMask(q) * gNear;
  }
}
#endif
float pane = winMask;
float rimAO = 1.0;
if (pane > 0.01) rimAO = mix(1.0, openingRim(), (1.0 - gLod) * uLook.x);
rimAO *= 1.0 - 0.35 * gShade * uLook.x;
// dirt gathers where the wall meets the pavement, and the glass darkens towards its frame
diffuseColor.rgb *= (1.0 - 0.24 * wallAO.y * uLook.x) * mix(1.0, rimAO, 0.6);
// Far away a lit window is a flat warm pane; up close it opens onto a room.
vec3 winGlow = litCol * winLit * 1.4 * uNight * (1.0 - hole);
if ((pane > 0.01 || hole > 0.5) && gLod < 0.98 && frame < 0.99) {
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
#ifdef RELIEF
    // and close to, that cloth hangs in the daylight that comes through the glass, so the reveal's shadow falls across it
    diffuseColor.rgb = mix(diffuseColor.rgb, dr.rgb * 0.45, dr.a * 0.5 * gNear * (1.0 - uNight) * step(0.001, revealDepth));
#endif
  }
  vec3 near = (nightCol * mix(1.0, rimAO, 0.5) * uNight + dayCol * rimAO * (1.0 - uNight)) * max(pane, hole) * soot;
  winGlow = mix(near, winGlow, gLod);
}
#ifdef RELIEF
// the frame stands in front of the room
diffuseColor.rgb = mix(diffuseColor.rgb, gFrame.rgb * mix(1.0, rimAO, 0.6), frame);
winMask *= 1.0 - frame;
winGlow = winGlow * (1.0 - frame) + revealGlow;
#endif
if (hole > 0.5) {
  diffuseColor.rgb = mix(vec3(0.03, 0.027, 0.025), vColor.rgb * 0.3, rim);
  winMask = 0.0;
  reliefN = vec3(0.0, 0.0, 1.0);
} else {
  diffuseColor.rgb *= 1.0 - blast.y * 0.6 * (1.0 - gLod);
  // the wave blows the glass out of the windows it passes
  winMask *= 1.0 - blast.w;
  // the balconies' ironwork stands in front of the wall and its windows
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.06, 0.07), gRail);
  winMask *= 1.0 - gRail;
  winGlow *= 1.0 - gRail;
  reliefN = mix(reliefN, vec3(0.0, 0.0, 1.0), gRail);
}
dWall *= (1.0 - hole) * (1.0 - gRail);
// (read after the room trace, so that its result does not have to be kept through it)
vec4 gDet = surfaceDetail();
diffuseColor.rgb *= mix(1.0, gDet.w, dWall);
reliefN.xy += gDet.xy * dWall * max(reliefN.z, 0.0);
`;

// The wall's relief turns the surface the light falls on: bumps lean it, a reveal's side faces across the opening.
export const BUILDING_FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
#if defined(RELIEF) || defined(DETAIL)
if (reliefOn) normal = normalize(rT * reliefN.x + rB * reliefN.y + normal * reliefN.z);
#endif
`;

export const BUILDING_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * (1.0 + 1.2 * gDet.z * dWall), 0.04, 1.0);
roughnessFactor = mix(roughnessFactor, 0.06 + 0.1 * (1.0 - glassy), winMask);
`;
export const BUILDING_FRAG_METAL = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.35 + 0.5 * glassy, winMask);
`;
export const BUILDING_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += winGlow;
if (uNight > 0.02 && uLook.y > 0.0) totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.72, 0.42) * (lampWash() * uNight * uLook.y * 0.5);
`;
// Runs after lighting: the sky's light (not the sun's) is dimmed where the pixel cannot see much sky,
// and the sun's where a ledge or the side of a window opening stands in its way.
export const BUILDING_FRAG_AO = /* glsl */ `
#include <aomap_fragment>
{
  float skyAO = mix(1.0, wallAO.x * rimAO, uLook.x);
#ifdef RELIEF
  skyAO *= revealAO;
  // the sun is the only light that arrives from one direction, so the relief's shadows are cut out of it here
  reflectedLight.directDiffuse *= sunShade;
  reflectedLight.directSpecular *= sunShade;
#endif
  reflectedLight.indirectDiffuse *= skyAO;
  reflectedLight.indirectSpecular *= mix(1.0, skyAO, 0.7);
}
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
uniform vec4 uLook;     // ambient occlusion strength, night glow strength (src/world/look.ts)
${DETAIL_GLSL}

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
  // Unpack with integer shifts: dividing by pow(16, slot) in floats can land a hair under a whole
  // number on some GPUs, and the kind then flips in scattered rows of pixels.
  return float((int(packed + 0.5) >> (4 * (idx & 3))) & 15);
}
// Painted lines have no mipmaps: each one is box-filtered over the pixel's footprint w (from fwidth),
// or distant stripes and checkers alias into moire that crawls as the camera moves.
// Coverage of stripes d wide centred on every whole number t.
float stripesInt(float t, float d) { t += 0.5 * d; return floor(t) * d + min(fract(t), d); }
float stripes(float t, float d, float w) {
  w = max(w, 1e-4);
  t = fract(t);
  return (stripesInt(t + 0.5 * w, d) - stripesInt(t - 0.5 * w, d)) / w;
}
// Coverage of the single stripe |x| < h.
float stripe(float x, float h, float w) {
  w = max(w, 1e-4);
  return (clamp(x + 0.5 * w, -h, h) - clamp(x - 0.5 * w, -h, h)) / w;
}
// mod(floor(p.x) + floor(p.y), 2.0), filtered.
float checker(vec2 p, vec2 w) {
  w = max(w, 1e-4);
  vec2 i = 2.0 * (abs(fract((p - 0.5 * w) * 0.5) - 0.5) - abs(fract((p + 0.5 * w) * 0.5) - 0.5)) / w;
  return 0.5 - 0.5 * i.x * i.y;
}
// How much of the sky's light reaches this pixel (ambient occlusion), 1 in the open.
float gAO = 1.0;
// The shade under a tree: a broad, soft pool below the crown (r2: its squared radius) and a tight one round the trunk.
float crownShade(vec2 trunk, vec2 crown, float r2) { return 0.3 * exp(-dot(crown, crown) / r2) + 0.35 * exp(-dot(trunk, trunk) / 0.25); }
// Boulevard trees stand in a row down each side (see BOULEVARD_TREES in src/core/config.ts), their crowns
// leaning out over the road (SHAPES in src/city/trees.ts).
float boulevardTrees(float lateral, float along) {
  float a = mod(along, ${f(BLOCK)});
  float nearest = clamp(floor((a - ${f(BOULEVARD_TREES.first)}) / ${f(BOULEVARD_TREES.step)} + 0.5), 0.0, ${f(BOULEVARD_TREES.count - 1)}) * ${f(BOULEVARD_TREES.step)} + ${f(BOULEVARD_TREES.first)};
  vec2 d = vec2(lateral - ${f(BOULEVARD_HALF - BOULEVARD_TREES.inset)}, a - nearest);
  return crownShade(d, d + vec2(${f(SHAPES[0].centre[0] * 1.07)}, 0.0), ${f((SHAPES[0].radii[0] * 1.07) ** 2)});
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
  // the block this pixel belongs to; out in the street, the block on this side of the centre line
  float kind = blockKind(f);

  if (walk.x + walk.y > 0.5) {
    if (road.x + road.y > 0.5) {
      col = asphalt;
      rough = mix(0.85, 0.22, uWet);
      // dashed centre lines and zebra crossings
      float dashX = road.x * (1.0 - walk.y) * stripe(off.x, 0.12, fw.x) * stripes(f.y / 6.0 - 0.75, 0.5, fw.y / 6.0);
      float dashZ = road.y * (1.0 - walk.x) * stripe(off.y, 0.12, fw.y) * stripes(f.x / 6.0 - 0.75, 0.5, fw.x / 6.0);
      float zebraX = road.x * step(hw.y, dl.y) * step(dl.y, hw.y + 3.5) * stripes(f.x / 1.1 - 0.75, 0.5, fw.x / 1.1);
      float zebraZ = road.y * step(hw.x, dl.x) * step(dl.x, hw.x + 3.5) * stripes(f.y / 1.1 - 0.75, 0.5, fw.y / 1.1);
      float paint = clamp(dashX + dashZ + zebraX + zebraZ, 0.0, 1.0);
      // the paint fills the grain of the asphalt
      setDetail(D_ASPHALT, f, M_ASPHALT, 1.0 - 0.6 * paint, 1.0, 0.0);
      // a gutter of granite setts along each kerb, rows running with the street (not across the street that crosses it; src/city/surface.ts reads it the same way)
      float settsX = road.x * (1.0 - walk.y) * step(hw.x - ${f(SIDEWALK + GUTTER)}, dl.x);
      float settsZ = road.y * (1.0 - walk.x) * step(hw.y - ${f(SIDEWALK + GUTTER)}, dl.y);
      if (settsX + settsZ > 0.5) {
        col = vec3(0.25, 0.245, 0.24) * (0.85 + 0.3 * n);
        setDetail(D_SETTS, f, M_SETTS, 1.0 - 0.6 * paint, 0.0, settsX);
      }
      col = mix(col, vec3(0.85, 0.84, 0.78), paint * 0.85);
      float gutter = max(road.x * step(hw.x - ${f(SIDEWALK)} - 0.8, dl.x), road.y * step(hw.y - ${f(SIDEWALK)} - 0.8, dl.y));
      gPuddle = max(smoothstep(0.6 - pw, 0.66 + pw, pn), gutter * smoothstep(0.42 - pw, 0.5 + pw, pn));
    } else {
      float joint = 1.0 - (1.0 - stripes(f.x / 1.5, 0.08, fw.x / 1.5)) * (1.0 - stripes(f.y / 1.5, 0.08, fw.y / 1.5));
      col = pavement * (1.0 - joint * 0.12);
      float curb = stripe(dl.x - (hw.x - ${f(SIDEWALK)} + 0.15), 0.15, fw.x) * walk.x + stripe(dl.y - (hw.y - ${f(SIDEWALK)} + 0.15), 0.15, fw.y) * walk.y;
      col = mix(col, vec3(0.72, 0.7, 0.66), clamp(curb, 0.0, 1.0));
      // the pavement's aggregate, and the kerb's dressed stone
      if (curb > 0.5) setDetail(D_STONE, f, M_STONE, 1.0, 1.0, 0.0);
      else setDetail(D_AGGREGATE, f, M_AGGREGATE, 0.9, 1.0, 0.0);
      rough = mix(0.8, 0.35, uWet);
      gPuddle = smoothstep(0.66 - pw, 0.7 + pw, pn);
    }
  } else {
    vec2 bc = (floor(f / ${f(BLOCK)}) + 0.5) * ${f(BLOCK)};
    vec2 q = f - bc;
    if (kind < 0.5) {
      // the courtyard in the middle of a block is laid with setts
      col = vec3(0.45, 0.43, 0.4) * (0.9 + 0.2 * n);
      setDetail(D_SETTS, f, M_SETTS, 1.0, 0.0, 0.0);
    } else if (kind < 1.5) {
      col = mix(vec3(0.24, 0.36, 0.15), vec3(0.34, 0.46, 0.2), n);
      float path = 1.0 - step(2.2, abs(abs(q.x) - abs(q.y)));
      float r = length(q);
      path = max(path, step(abs(r - 11.0), 2.0));
      col = mix(col, vec3(0.72, 0.66, 0.55), path);
      paved = path * 0.6;
      // gravel on the paths (the grass has none)
      setDetail(D_GRAVEL, f, M_GRAVEL, path, 1.0, 0.0);
      if (r < 6.0) { col = vec3(0.12, 0.3, 0.38); rough = 0.08; pondWater = 1.0; gDGain = 0.0; }
      else if (r < 7.0) { col = vec3(0.7, 0.68, 0.62); paved = 1.0; setDetail(D_STONE, f, M_STONE, 1.0, 1.0, 0.0); }
    } else if (kind < 2.5) {
      // stone flags, and setts laid in fans in the middle of the square
      col = mix(vec3(0.72, 0.69, 0.62), vec3(0.62, 0.6, 0.55), checker(f / 3.0, fw / 3.0));
      setDetail(D_STONE, f, M_STONE, 1.0, 1.0, 0.0);
      if (length(q) < 4.5) { col = vec3(0.5, 0.48, 0.45); setDetail(D_FAN, f, M_FAN, 1.0, 0.0, 0.0); }
    } else if (kind < 3.5) {
      float seam = 1.0 - (1.0 - stripes(f.x / 6.0, 0.06, fw.x / 6.0)) * (1.0 - stripes(f.y / 6.0, 0.06, fw.y / 6.0));
      col = vec3(0.42, 0.43, 0.45) * (0.92 + 0.08 * seam);
      setDetail(D_STONE, f, M_STONE, 1.0, 1.0, 0.0);
      rough = mix(0.6, 0.2, uWet);
      gPuddle = smoothstep(0.64 - pw, 0.7 + pw, pn);
    } else {
      col = pavement;
      setDetail(D_AGGREGATE, f, M_AGGREGATE, 0.9, 1.0, 0.0);
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
    if (r0 < 14.0) { col = vec3(0.7, 0.67, 0.6) * (0.92 + 0.08 * stripes(turn * 12.0 - 0.75, 0.5, tw * 12.0)); setDetail(D_FAN, f, M_FAN, 1.0, 0.0, 0.0); }
    else if (r0 < 24.0) { col = mix(vec3(0.26, 0.38, 0.17), vec3(0.34, 0.46, 0.2), n); paved = 0.0; gDGain = 0.0; }
    else if (r0 < 25.0) { col = vec3(0.75, 0.73, 0.68); setDetail(D_STONE, f, M_STONE, 1.0, 1.0, 0.0); }
    else if (r0 < 40.0) {
      col = asphalt;
      rough = mix(0.85, 0.22, uWet);
      float ring = stripe(r0 - 32.5, 0.12, max(fw.x, fw.y)) * stripes(turn * 24.0 - 0.75, 0.5, tw * 24.0);
      col = mix(col, vec3(0.85, 0.84, 0.78), ring);
      setDetail(D_ASPHALT, f, M_ASPHALT, 1.0 - 0.6 * ring, 1.0, 0.0);
      gPuddle = smoothstep(0.6, 0.66, pn);
    } else { col = pavement * (0.94 + 0.06 * stripes(turn * 16.0 - 0.75, 0.5, tw * 16.0)); setDetail(D_AGGREGATE, f, M_AGGREGATE, 0.9, 1.0, 0.0); }
  }

  // Ambient occlusion. The generator's layout is known here, so the shade that walls, trees and
  // lamp posts cast on the sky's light is computed, not sampled.
  if (uLook.x > 0.0) {
    vec2 inb = dl - hw;   // metres into the block from its building lines (negative out in the street)
    float occ = 0.0;
    float grime = 0.0;
    if (kind < 0.5) {
      if (walk.x + walk.y > 0.5) {
        // A perimeter block's wall stands on the building line and hides half the sky at its foot,
        // less further out. (The block across the street is not known here, so each side's shade
        // fades out at the centre line and the two always meet.)
        vec2 gap = max(-inb, 0.0);
        float d = length(gap);
        float wall = 0.5 * (1.0 - d * inversesqrt(d * d + 324.0));
        wall *= 1.0 - smoothstep(0.5, 1.0, max(gap.x / hw.x, gap.y / hw.y));
        // and the corner where it meets the pavement is darker still
        occ = wall + 0.22 * exp(-d / 0.5);
        grime = exp(-d / 0.4);
      } else {
        // the courtyard is a well
        occ = mix(0.5, 0.22, smoothstep(11.0, 26.0, min(inb.x, inb.y)));
      }
    }
    // things too small to see from far away fade out before they turn to noise
    float fine = 1.0 - smoothstep(0.2, 0.8, max(fw.x, fw.y));
    float small = 0.0;
    if (fine > 0.0) {
      if (hw.x > ${f(BOULEVARD_HALF - 0.5)}) small = boulevardTrees(dl.x, f.y);
      if (hw.y > ${f(BOULEVARD_HALF - 0.5)}) small = max(small, boulevardTrees(dl.y, f.x));
      if (kind > 1.5 && kind < 2.5) { vec2 t = inb - ${f(PLAZA_TREE_INSET)}; small = max(small, crownShade(t, t, ${f((SHAPES[1].radii[0] * 1.1) ** 2)})); }
      // lamp posts stand a metre in from the building line
      vec2 da = f.yx - (floor((f.yx - ${f(LAMP_OFFSET)}) / ${f(LAMP_SPACING)} + 0.5) * ${f(LAMP_SPACING)} + ${f(LAMP_OFFSET)});
      vec2 dp = inb + 1.0;
      vec2 post = exp(-(dp * dp + da * da) / 0.1) * walk;
      small = max(small, 0.4 * max(post.x, post.y));
    }
    // the monument balances on its point
    occ = max(occ, 0.5 * exp(-r0 * r0 / 40.0));
    gAO = (1.0 - occ) * (1.0 - small * fine);
    col *= 1.0 - 0.22 * grime * uLook.x;
  }

  // Street-lamp light pools at night.
  float pools = lampPool(off.x, f.y, hw.x) * walk.x + lampPool(off.y, f.x, hw.y) * walk.y;
  // pale paving throws more of the lamps' light back than asphalt does
  float pale = smoothstep(0.08, 0.6, dot(col, vec3(0.3333)));
  glow += vec3(1.0, 0.72, 0.42) * pools * uNight * 0.45 * mix(1.0, 0.45 + 0.75 * pale, uLook.y);

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
  // snow fills the grain, and standing water lies flat over it
  gDGain *= (1.0 - 0.8 * snowy) * (1.0 - smoothstep(0.2, 0.7, gPuddle / max(uWet, 1e-3)));
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
    gDGain *= 1.0 - sea;
    gAO = mix(gAO, 1.0, sea);
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
// The scanned grain of the surface close to (out here, where every pixel runs it): its cavities darken the paint.
vec4 gDet = surfaceDetail();
diffuseColor.rgb *= gDet.w;
`;
export const GROUND_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = clamp(groundRough * (1.0 + 1.2 * gDet.z), 0.02, 1.0);
`;
// The grain's relief leans the ground's normal, along the fabric's own axes (they turn with the folds).
export const GROUND_FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
#ifdef DETAIL
{
  vec3 dT; vec3 dB;
  surfaceAxes(vFabric.xz, normal, dT, dB);
  normal = normalize(normal + dT * gDet.x + dB * gDet.y);
}
#endif
`;
// Runs after lighting: on wet, flat street the plain sky reflection gives way to
// the mirrored city (or, without a mirror, to the reflected street lamps).
export const GROUND_FRAG_WET = /* glsl */ `
#include <aomap_fragment>
{
  // the sky's light (not the sun's) is dimmed where the pixel cannot see much sky
  float skyAO = mix(1.0, gAO, uLook.x);
  reflectedLight.indirectDiffuse *= skyAO;
  reflectedLight.indirectSpecular *= mix(1.0, skyAO, 0.7);
}
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
// Props: trees, lamps and the totem
// ---------------------------------------------------------------------------

export const PROP_VERT_HEAD = /* glsl */ `
attribute vec4 iPosYaw;  // x, y, z, yaw
attribute vec4 iParam;   // scale, tone, birth time, spin speed
attribute vec4 iState;   // unused, kind (1 lamp, 3 totem; the trees have their own mesh, src/city/treeField.ts), unused, unused
attribute float aPart;   // 0 solid, 2 lamp glass, 5 metal, 6 glowing
attribute vec3 aColor;
varying vec3 vColorV;
varying float vPart;
varying vec2 vTone;      // tone, unused
varying vec3 vFabric;
varying float vUp;       // height on the model, before scaling (for ambient occlusion)
${FOLD_GLSL}

vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 rotAxis(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }

void propVertex(out vec3 P, out vec3 N) {
  if (iParam.x <= 0.0) {
    P = vec3(0.0); N = vec3(0.0, 1.0, 0.0);
    vColorV = P; vPart = 0.0; vTone = vec2(0.0); vFabric = P; vUp = 0.0;
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
  vUp = position.y;
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
varying float vUp;
uniform float uNight;
uniform float uSnow;
uniform vec4 uLook;      // ambient occlusion strength, night glow strength (src/world/look.ts)
uniform vec3 uFoliageA;
uniform vec3 uFoliageB;
`;

export const PROP_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
diffuseColor.rgb = vColorV;
float propMetal = 0.0;
float propRough = 0.8;
vec3 propGlow = vec3(0.0);
// Ambient occlusion: whatever stands on the pavement is darkest where it meets it
float propAO = vPart < 0.5 ? mix(0.5, 1.0, smoothstep(0.0, 0.6, vUp)) : 1.0;
if (vPart > 1.5 && vPart < 2.5) {
  propGlow = vec3(1.0, 0.78, 0.5) * (0.25 + 3.0 * uNight);
} else if (vPart > 4.5 && vPart < 5.5) {
  propMetal = 0.9;
  propRough = 0.28;
} else if (vPart > 5.5) {
  // Heist mode's sleep machine lights and gramophone horn: lit by their own colour
  diffuseColor.rgb = vColorV * 0.3;
  propGlow = vColorV * 2.2;
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
export const PROP_FRAG_AO = /* glsl */ `
#include <aomap_fragment>
{
  float skyAO = mix(1.0, propAO, uLook.x);
  reflectedLight.indirectDiffuse *= skyAO;
  reflectedLight.indirectSpecular *= mix(1.0, skyAO, 0.7);
}
`;

// ---------------------------------------------------------------------------
// Trees: London planes (src/city/trees.ts), a near and a far version (src/city/treeField.ts)
// ---------------------------------------------------------------------------

export const TREE_VERT_HEAD = /* glsl */ `
attribute vec4 iTree;    // fabric x, z, yaw, scale (0: nobody here)
attribute vec4 iLook;    // tone, birth time, seed (0 to 1), shape * 2 + 1 if mirrored
attribute vec4 aWood;    // part (0 bark, 1 leaves), sky it sees, sway (0 the foot, 1 the top), limb (-1 the trunk)
attribute vec4 aLeaf;    // atlas u, v, flutter phase, shape (0 boulevard, 1 park)
#ifdef TREE_FAR
attribute vec4 aCard;    // a far leaf card's corner, from its centre (metres), and its roll
#endif
uniform vec4 uTrees;     // the near version fades out between x and y metres; share of the leaves the season has taken; wind
uniform vec3 uEye;       // the main camera, so the shadow and the mirror pick the same version it sees
uniform vec2 uTreeShadow; // trees cast shadows out to here from the eye (metres: fade start, end)
varying vec2 vUv;
varying vec4 vTree;      // part, sky, tone, how much of this version shows (0 to 1)
varying vec3 vFabric;
varying vec3 vLocal;     // where on the model (metres, before scaling): the bark's pattern
varying float vUpN;      // how much the surface faces up (snow settles there)
${FOLD_GLSL}

vec3 treeYaw(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
// Where the sun's shadow is looked up, moved this far from the surface (see treeMaterial in src/city/materials.ts).
vec3 treeShadowPush = vec3(0.0);

void treeNobody(out vec3 P, out vec3 N) {
  P = vec3(0.0); N = vec3(0.0, 1.0, 0.0);
  vUv = vec2(0.0); vTree = vec4(0.0); vFabric = P; vLocal = P; vUpN = 0.0;
}

void treeVertex(out vec3 P, out vec3 N) {
  float shape = floor(iLook.w * 0.5 + 0.01);
  // the geometry holds both shapes: a tree keeps only its own
  if (iTree.w <= 0.0 || abs(aLeaf.w - shape) > 0.5) { treeNobody(P, N); return; }
  // which version shows from here: the near one up close, the far one beyond the fade, a dither between
  vec3 base = vec3(iTree.x, 0.0, iTree.y);
  vec3 baseN = vec3(0.0, 1.0, 0.0);
  applyFolds(iTree.xy, base, baseN);
  float fromEye = distance(base, uEye);
  float near = 1.0 - smoothstep(uTrees.x, uTrees.y, fromEye);
#ifdef TREE_SHADOW
  near = step(0.5, near);
  // far out, a tree's shadow shrinks away (each leaf card's shadow is many shadow-map texels to fill)
  float shadowReach = 1.0 - smoothstep(uTreeShadow.x, uTreeShadow.y, fromEye);
  if (shadowReach <= 0.0) { treeNobody(P, N); return; }
#endif
#ifdef TREE_FAR
  float show = 1.0 - near;
#else
  float show = near;
#endif
  if (show <= 0.0) { treeNobody(P, N); return; }

  float scale = iTree.w * smoothstep(iLook.y, iLook.y + 1.4, uTime);
#ifdef TREE_SHADOW
  scale *= shadowReach;
#endif
  vec3 local = position;
  vec3 nrm = normal;
  if (fract(iLook.w * 0.5) > 0.25) { local.z = -local.z; nrm.z = -nrm.z; }
  // Each tree turns and stretches its limbs its own way, so no two in a row are the same.
  if (aWood.w >= 0.0) {
    bool bvd = shape < 0.5;
    float h1 = hash12(vec2(iLook.z * 91.7 + aWood.w * 3.1, aWood.w + 1.3));
    float h2 = hash12(vec2(aWood.w * 7.1 + 0.5, iLook.z * 53.3));
    float turn = (h1 - 0.5) * 2.0 * (bvd ? ${f(SHAPES[0].turn)} : ${f(SHAPES[1].turn)});
    float fork = bvd ? ${f(SHAPES[0].fork)} : ${f(SHAPES[1].fork)};
    float stretch = 0.9 + 0.2 * h2;
    local = treeYaw(local, turn);
    nrm = treeYaw(nrm, turn);
    local.xz *= stretch;
    local.y = fork + (local.y - fork) * (0.94 + 0.06 * stretch);
    // a boulevard tree keeps clear of the facades behind it
    if (bvd) local.x = max(local.x, ${f(SHAPES[0].back)});
  }
  // Wind: the crown leans and comes back; the leaves flutter.
  float ph = iTree.x * 0.11 + iTree.y * 0.07;
  float lean = (sin(uTime * 0.9 + ph) * 0.6 + sin(uTime * 2.1 + ph * 1.7) * 0.25) * 0.16 * uTrees.w * aWood.z;
  if (aWood.x > 0.5) local += nrm * sin(uTime * (5.0 + 3.0 * uTrees.w) + aLeaf.z) * 0.035 * uTrees.w * (0.4 + aWood.z);
  vLocal = local;
  vUpN = nrm.y;
  local = treeYaw(local * scale, iTree.z);
  nrm = treeYaw(nrm, iTree.z);
  vec3 fab = vec3(iTree.x, 0.0, iTree.y) + local;
  fab.xz += vec2(0.8, 0.6) * lean * scale;
  fab.y -= limboDecay(iTree.xy, 0.6) * 14.0;
  fab.y += ripple(fab.xz);
  vUv = aLeaf.xy;
  vTree = vec4(aWood.x, aWood.y, iLook.x, show);
  vFabric = fab;
  P = fab;
  N = nrm;
  applyFolds(iTree.xy, P, N);
#ifdef TREE_FAR
  // A far leaf card stands at its centre (all four corners do) and is spread out facing the camera.
  if (aWood.x > 0.5) {
    float cr = cos(aCard.z), sr = sin(aCard.z);
    vec2 c = vec2(cr * aCard.x - sr * aCard.y, sr * aCard.x + cr * aCard.y) * scale;
    vec3 spread = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * c.x + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * c.y;
    P += spread;
    // and lit as a piece of the round crown it belongs to, not as a flat card
    N = normalize(N + spread / (4.5 * max(scale, 0.1)));
    // In the shadow pass the same card turns to face the sun instead, so half of it would lie in its own
    // shadow, cut off along a straight line. Looking the shadow up a little way out of the crown avoids that,
    // and the cards on the far side of the crown are still in the shade of those in front.
    treeShadowPush = N * 1.1 * scale;
  }
#endif
}
`;

const TREE_FRAG_PARS = /* glsl */ `
varying vec2 vUv;
varying vec4 vTree;
varying vec3 vFabric;
varying vec3 vLocal;
varying float vUpN;
uniform sampler2D tLeaves;  // the leaf atlas (src/city/trees.ts): which leaf, twig, light on the leaf, leaf
uniform vec4 uTrees;
`;

export const TREE_FRAG_HEAD = /* glsl */ `
${TREE_FRAG_PARS}
uniform float uNight;
uniform float uSnow;
uniform vec4 uLook;      // ambient occlusion strength, night glow strength (src/world/look.ts)
uniform vec3 uFoliageA;
uniform vec3 uFoliageB;
float treeHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float treeNoise(vec3 p) {
  vec3 i = floor(p); vec3 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(mix(treeHash(i), treeHash(i + vec3(1, 0, 0)), u.x), mix(treeHash(i + vec3(0, 1, 0)), treeHash(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(treeHash(i + vec3(0, 0, 1)), treeHash(i + vec3(1, 0, 1)), u.x), mix(treeHash(i + vec3(0, 1, 1)), treeHash(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
// A plane tree's bark flakes off in patches: grey-brown, olive, and cream where it is fresh.
vec3 treeBark(vec3 p) {
  float n = treeNoise(p * vec3(2.2, 0.8, 2.2)) * 0.62 + treeNoise(p * vec3(6.5, 2.6, 6.5) + 17.0) * 0.38;
  float w = fwidth(n) + 0.01;
  vec3 c = mix(vec3(0.3, 0.28, 0.24), vec3(0.44, 0.43, 0.32), smoothstep(0.44 - w, 0.44 + w, n));
  c = mix(c, vec3(0.66, 0.62, 0.48), smoothstep(0.6 - w, 0.6 + w, n));
  // greyer up in the crown, where the limbs are thin
  return mix(c, vec3(0.34, 0.33, 0.3), smoothstep(5.0, 11.0, p.y) * 0.6);
}
// Interleaved gradient noise: the dither the near and far versions share out between them.
float treeDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// The street lamps' light from below, on the crowns at night. The lamps stand a metre in from the building line
// along every street (see lampWash in the building shader), so the nearest two are found without looking anything up.
float treeLampLight(vec3 p) {
  float sum = 0.0;
  for (int k = 0; k < 2; k++) {
    float across = k == 0 ? p.x : p.z;
    float along = k == 0 ? p.z : p.x;
    float line = floor(across / ${f(BLOCK)} + 0.5);
    float off = across - line * ${f(BLOCK)};
    float hw = mod(line, ${f(CHUNK_BLOCKS)}) < 0.5 ? ${f(BOULEVARD_HALF)} : ${f(STREET_HALF)};
    float lat = abs(off) - (hw - 1.0);
    float da = along - (floor((along - ${f(LAMP_OFFSET)}) / ${f(LAMP_SPACING)} + 0.5) * ${f(LAMP_SPACING)} + ${f(LAMP_OFFSET)});
    float dy = p.y - ${f(LANTERN_HEIGHT)};
    float r2 = lat * lat + da * da + dy * dy;
    sum += smoothstep(-1.0, 1.5, dy) / (1.0 + r2 * 0.18);
  }
  return sum;
}
`;

// The version on its way out leaves a dither pattern that the other one fills.
const TREE_FADE_DISCARD = /* glsl */ `
#ifdef TREE_FAR
if (treeDither(gl_FragCoord.xy) < 1.0 - vTree.w) discard;
#else
if (treeDither(gl_FragCoord.xy) >= vTree.w) discard;
#endif
`;

export const TREE_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
${TREE_FADE_DISCARD}
float treeSky = vTree.y;
float treeRough = 0.92;
vec3 treeAlbedo;
bool treeLeafy = vTree.x > 0.5;
if (!treeLeafy) {
  treeAlbedo = treeBark(vLocal);
  diffuseColor.a = 1.0;
} else {
  vec4 lt = texture2D(tLeaves, vUv);
  // the season takes some of the leaves (all of them in the snow); the twigs stay
  float keep = smoothstep(uTrees.z - 0.06, uTrees.z + 0.06, lt.r);
  float leafA = lt.a * keep;
  vec3 green = mix(uFoliageA, uFoliageB, clamp(vTree.z * 0.55 + (lt.r - 0.5) * 0.9 + 0.22, 0.0, 1.0));
  green *= 0.5 + 0.72 * lt.b;
  treeAlbedo = leafA >= lt.g ? green : vec3(0.15, 0.13, 0.11);
  diffuseColor.a = max(leafA, lt.g);
  treeRough = 0.78;
}
// snow settles on whatever faces up
treeAlbedo = mix(treeAlbedo, vec3(0.92, 0.94, 0.97), uSnow * smoothstep(0.15, 0.7, vUpN) * (treeLeafy ? 0.55 : 0.85));
diffuseColor.rgb = treeAlbedo;
vec3 treeGlow = vec3(0.0);
#if NUM_DIR_LIGHTS > 0
if (treeLeafy) {
  // the sun through the leaves, seen from underneath or against the light
  vec3 tV = normalize(vViewPosition);
  float through = max(dot(-tV, directionalLights[0].direction), 0.0);
  treeGlow += treeAlbedo * directionalLights[0].color * (through * through * through) * 0.16 * treeSky;
}
#endif
// the lamps light the crowns from below at night
if (uNight > 0.01 && vFabric.y < 14.0) treeGlow += treeAlbedo * vec3(1.0, 0.72, 0.42) * treeLampLight(vFabric) * uNight * 2.2 * uLook.y;
`;
export const TREE_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = treeRough;
`;
export const TREE_FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
// a leaf card is lit the same from either side: its normal is the crown's, not the card's
if (treeLeafy) normal = normalize(vNormal);
`;
export const TREE_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += treeGlow;
`;
export const TREE_FRAG_AO = /* glsl */ `
#include <aomap_fragment>
{
  float skyAO = mix(1.0, treeSky, uLook.x);
  reflectedLight.indirectDiffuse *= skyAO;
  reflectedLight.indirectSpecular *= mix(1.0, skyAO, 0.8);
}
`;

/**
 * The depth pass drawn before the trees' colour (see treePrepassMaterial in src/city/materials.ts): the same leaves,
 * cut out exactly as the colour pass cuts them (the same texel, the same test, the same alpha to coverage), so that
 * the colour pass then lights only the leaf in front at each pixel.
 */
export const TREE_PREPASS_FRAG_HEAD = /* glsl */ `
${TREE_FRAG_PARS}
float treeDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;
export const TREE_PREPASS_FRAG_TEST = /* glsl */ `
#include <alphatest_fragment>
${TREE_FADE_DISCARD}
float treeCover = 1.0;
if (vTree.x > 0.5) {
  vec4 lt = texture2D(tLeaves, vUv);
  float keep = smoothstep(uTrees.z - 0.06, uTrees.z + 0.06, lt.r);
  treeCover = max(lt.a * keep, lt.g);
}
// (three.js's alpha test with alpha to coverage, as the colour pass has it)
treeCover = smoothstep(0.5, 0.5 + fwidth(treeCover), treeCover);
if (treeCover == 0.0) discard;
`;
export const TREE_PREPASS_FRAG_OUT = /* glsl */ `
gl_FragColor.a = treeCover;
}`;

/**
 * The shadow pass: leaves cast the shade of their clusters, read from a smaller mip level than the eye sees so
 * that it does not sparkle as they sway (a shadow-map texel is about a third of a metre).
 */
export const TREE_DEPTH_FRAG_HEAD = TREE_FRAG_PARS;
export const TREE_DEPTH_FRAG_TEST = /* glsl */ `
if (vTree.x > 0.5) {
#ifdef TREE_FAR
  vec4 lt = textureLod(tLeaves, vUv, 3.0);
#else
  vec4 lt = textureLod(tLeaves, vUv, 4.0);
#endif
  float keep = smoothstep(uTrees.z - 0.06, uTrees.z + 0.06, lt.r);
  if (max(lt.a * keep, lt.g) < 0.5) discard;
}
`;

// ---------------------------------------------------------------------------
// People: the dreamer's projections (src/people/crowd.ts)
// ---------------------------------------------------------------------------

export const PERSON_VERT_HEAD = /* glsl */ `
attribute vec4 iPosYaw;  // x, y, z, yaw
attribute vec4 iAnim;    // bone-texture row of the clip, row of the clip being left, how much of that one remains, head turn (radians, to the left)
attribute vec4 iBody;    // scale, build (0 the man, 1 the woman), pieces worn (bit flags), suspicion
attribute vec4 iColA;    // jacket rgb, skin (0 pale to 1 dark)
attribute vec4 iColB;    // trousers or skirt rgb, hair (0 black, brown, fair, 1 grey)
attribute vec4 iColC;    // tie or scarf rgb, tights under a skirt
attribute vec3 aMorph;   // from the man's vertex to the woman's
attribute vec4 aSkin;    // two bones, the weight of the first, how much of the head's turn this vertex takes
attribute vec2 aInfo;    // part (PART in src/people/body.ts), piece (PIECE)
uniform sampler2D tBones;   // a row a frame, three texels a bone: the rows of its 3 x 4 skinning matrix
uniform vec2 uBoneTexel;    // 1 / the texture's width and height
varying vec3 vColorV;
varying vec3 vTone;      // on the head (1) or not, suspicion, roughness
varying vec3 vFabric;
varying float vUp;       // height on the body, before scaling (for ambient occlusion)
${FOLD_GLSL}

vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }

void boneAt(float b, float row, out vec4 r0, out vec4 r1, out vec4 r2) {
  // exactly on a texel across (one bone must not bleed into the next), between two down (two frames, blended)
  float u = (b * 3.0 + 0.5) * uBoneTexel.x;
  float v = (row + 0.5) * uBoneTexel.y;
  r0 = texture2D(tBones, vec2(u, v));
  r1 = texture2D(tBones, vec2(u + uBoneTexel.x, v));
  r2 = texture2D(tBones, vec2(u + 2.0 * uBoneTexel.x, v));
}

void poseAt(float row, out vec4 r0, out vec4 r1, out vec4 r2) {
  boneAt(aSkin.x, row, r0, r1, r2);
  if (aSkin.z < 0.998) {
    vec4 s0; vec4 s1; vec4 s2;
    boneAt(aSkin.y, row, s0, s1, s2);
    r0 = mix(s0, r0, aSkin.z); r1 = mix(s1, r1, aSkin.z); r2 = mix(s2, r2, aSkin.z);
  }
}

vec3 hairColor(float t) {
  vec3 black = vec3(0.035, 0.03, 0.028);
  vec3 brown = vec3(0.17, 0.1, 0.06);
  vec3 fair = vec3(0.5, 0.38, 0.21);
  vec3 grey = vec3(0.56, 0.56, 0.54);
  if (t < 0.4) return mix(black, brown, t / 0.4);
  if (t < 0.75) return mix(brown, fair, (t - 0.4) / 0.35);
  return mix(fair, grey, (t - 0.75) / 0.25);
}

void personVertex(out vec3 P, out vec3 N) {
  int piece = int(aInfo.y + 0.5);
  int worn = int(iBody.z + 0.5);
  bool skirt = ((worn >> ${PIECE.skirt - 1}) & 1) == 1;
  // (the same rule as wears() in src/people/body.ts)
  bool hidden = piece == ${PIECE.thighs} ? skirt : (piece > 0 && ((worn >> (piece - 1)) & 1) == 0);
  if (iBody.x <= 0.0 || hidden) {
    // nobody here, or a piece this person is not wearing: its triangles shrink to a point
    P = iPosYaw.xyz; N = vec3(0.0, 1.0, 0.0);
    vColorV = vec3(0.0); vTone = vec3(0.0); vFabric = P; vUp = 0.0;
    return;
  }
  vec3 local = position + aMorph * iBody.y;
  vec3 nrm = normal;
  // the head turns on the neck, then the whole body is posed
  float turn = iAnim.w * aSkin.w;
  if (abs(turn) > 0.001) {
    const vec3 neck = vec3(0.0, 0.0, -0.01);
    local = rotY(local - neck, turn) + neck;
    nrm = rotY(nrm, turn);
  }
  vec4 r0; vec4 r1; vec4 r2;
  poseAt(iAnim.x, r0, r1, r2);
  if (iAnim.z > 0.004) {
    vec4 s0; vec4 s1; vec4 s2;
    poseAt(iAnim.y, s0, s1, s2);
    r0 = mix(r0, s0, iAnim.z); r1 = mix(r1, s1, iAnim.z); r2 = mix(r2, s2, iAnim.z);
  }
  vec4 lp = vec4(local, 1.0);
  vec3 posed = vec3(dot(r0, lp), dot(r1, lp), dot(r2, lp));
  nrm = normalize(vec3(dot(r0.xyz, nrm), dot(r1.xyz, nrm), dot(r2.xyz, nrm)));

  vec3 fab = iPosYaw.xyz + rotY(posed * iBody.x, iPosYaw.w);
  nrm = rotY(nrm, iPosYaw.w);
  float decay = limboDecay(iPosYaw.xz, 0.6);
  fab.y -= decay * 14.0;
  fab.y += ripple(iPosYaw.xz);

  // what the vertex is made of decides its colour
  int part = int(aInfo.x + 0.5);
  bool shirt = ((worn >> ${PIECE.shirtFront - 1}) & 1) == 1;
  vec3 skin = mix(vec3(0.84, 0.66, 0.54), vec3(0.29, 0.18, 0.12), iColA.w);
  vec3 col = iColA.rgb;
  float rough = 0.84;
  float head = 0.0;
  if (part == ${PART.trousers}) col = skirt ? mix(skin * 0.94, vec3(0.03), iColC.w) : iColB.rgb;
  else if (part == ${PART.shirt}) col = shirt ? vec3(0.84, 0.83, 0.79) : iColA.rgb;
  else if (part == ${PART.tie}) col = iColC.rgb;
  else if (part == ${PART.skin}) { col = skin; rough = 0.62; head = step(1.45, position.y); }
  else if (part == ${PART.hair}) { col = hairColor(iColB.w); rough = 0.72; head = 1.0; }
  else if (part == ${PART.shoes}) { col = vec3(0.035, 0.032, 0.03); rough = 0.4; }
  else if (part == ${PART.hat}) { col = iColA.rgb * 0.55 + 0.012; head = 1.0; }
  else if (part == ${PART.bag}) { col = mix(vec3(0.05, 0.045, 0.04), vec3(0.19, 0.105, 0.05), step(0.5, fract(iColB.w * 7.31))); rough = 0.5; }
  else if (part == ${PART.skirt}) col = iColB.rgb;

  vColorV = col;
  vTone = vec3(head, iBody.w, rough);
  vFabric = fab;
  vUp = posed.y;
  P = fab;
  N = nrm;
  applyFolds(iPosYaw.xz, P, N);
}
`;

export const PERSON_FRAG_HEAD = /* glsl */ `
varying vec3 vColorV;
varying vec3 vTone;
varying vec3 vFabric;
varying float vUp;
uniform vec4 uLook;      // ambient occlusion strength, night glow strength (src/world/look.ts)
`;

export const PERSON_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
diffuseColor.rgb = vColorV;
// someone who has noticed the dreamer reddens, and a hunter's face glows
float personS = vTone.y;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.35, 0.03, 0.03), smoothstep(0.35, 1.0, personS));
vec3 personGlow = vec3(0.9, 0.08, 0.05) * smoothstep(0.7, 1.0, personS) * (vTone.x > 0.5 ? 1.2 : 0.15);
// Ambient occlusion: darkest where the feet meet the pavement, and a little under the chin and the hem
float personAO = mix(0.5, 1.0, smoothstep(0.0, 0.5, vUp));
`;
export const PERSON_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = vTone.z;
`;
export const PERSON_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += personGlow;
`;
export const PERSON_FRAG_AO = /* glsl */ `
#include <aomap_fragment>
{
  float skyAO = mix(1.0, personAO, uLook.x);
  reflectedLight.indirectDiffuse *= skyAO;
  reflectedLight.indirectSpecular *= mix(1.0, skyAO, 0.7);
}
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
// The street life kit: café furniture, street furniture and parked cars, modelled in Blender
// (art/street/build_street.py, src/city/streetKit.ts) and drawn one instanced list per model (src/city/kitField.ts)
// ---------------------------------------------------------------------------

/** How fast the café explosion's wave runs out (m/s of dream time): WAVE_SPEED in src/world/collapse.ts. */
export const KIT_WAVE_SPEED = 140;

export const KIT_VERT_HEAD = /* glsl */ `
attribute vec4 iKit;     // fabric x, z, yaw, birth time
attribute vec4 iLook;    // paint tone, cloth tone, drawn out to this far from the eye (m), 1 if the café explosion throws it
attribute vec4 aTint;    // base colour, kind / 16 (KINDS in build_street.py)
attribute vec2 aKitUv;   // posters and stairwells: where on them (metres)
uniform vec3 uEye;       // the main camera: the shadow pass fades by the same distances it sees
uniform vec2 uKitShadow; // the kit casts shadows out to here from the eye (metres: fade start, end)
uniform vec4 uBlast;     // the café explosion: centre x, z (fabric), wave front radius, strength (0 while the dream holds)
varying vec3 vKitColor;
varying vec3 vKitPaint;  // the instance's own colour: a car's paint (kind 4) or a café's cloth (kind 5)
varying float vKind;
varying vec2 vKitUv;
varying vec3 vFabric;
varying vec3 vLocal;     // where on the model (metres, before it is turned): low parts are darker
varying float vUpN;      // how much the surface faces up (snow settles there)
${FOLD_GLSL}

// Car paint, about as often as each colour is seen parked in Paris (linear).
vec3 kitPaint(float t) {
  if (t < 0.2) return vec3(0.74, 0.74, 0.72);
  if (t < 0.38) return vec3(0.42, 0.43, 0.44);
  if (t < 0.52) return vec3(0.16, 0.17, 0.18);
  if (t < 0.68) return vec3(0.018, 0.018, 0.02);
  if (t < 0.78) return vec3(0.02, 0.045, 0.13);
  if (t < 0.85) return vec3(0.36, 0.025, 0.025);
  if (t < 0.89) return vec3(0.03, 0.08, 0.045);
  if (t < 0.94) return vec3(0.45, 0.38, 0.27);
  if (t < 0.97) return vec3(0.18, 0.32, 0.46);
  return vec3(0.55, 0.38, 0.03);
}
// A café's colours: its chairs' weave and its parasols.
vec3 kitCloth(float t) {
  if (t < 0.22) return vec3(0.46, 0.05, 0.04);
  if (t < 0.4) return vec3(0.05, 0.2, 0.1);
  if (t < 0.55) return vec3(0.05, 0.08, 0.22);
  if (t < 0.7) return vec3(0.62, 0.56, 0.44);
  if (t < 0.82) return vec3(0.28, 0.04, 0.08);
  if (t < 0.92) return vec3(0.6, 0.42, 0.12);
  return vec3(0.04, 0.04, 0.045);
}
vec3 kitRotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 kitTumble(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }

void kitVertex(out vec3 P, out vec3 N) {
  // how far the piece's foot is from the eye, folded: it shrinks into the pavement over the last stretch of its ring
  vec3 foot = vec3(iKit.x, 0.0, iKit.y);
  vec3 up = vec3(0.0, 1.0, 0.0);
  applyFolds(iKit.xy, foot, up);
  float d = distance(foot, uEye);
  float s = smoothstep(iKit.w, iKit.w + 1.2, uTime) * (1.0 - smoothstep(iLook.z * 0.9, iLook.z, d));
#ifdef KIT_SHADOW
  s *= step(d, uKitShadow.y);
#endif
  if (s < 0.01) {
    P = vec3(0.0); N = vec3(0.0, 1.0, 0.0);
    vKitColor = P; vKitPaint = P; vKind = 0.0; vKitUv = vec2(0.0); vFabric = P; vLocal = P; vUpN = 0.0;
    return;
  }
  vec3 local = position * s;
  vec3 nrm = normal;
  vec3 fab = vec3(iKit.x, 0.0, iKit.y);
  // The café explosion: light furniture is thrown out from the blast, tumbling, and lands; as the dream heals it flies back.
  if (iLook.w > 0.5 && uBlast.w > 0.0) {
    vec2 away = iKit.xy - uBlast.xy;
    float dist = length(away);
    float t = (uBlast.z - dist) / ${f(KIT_WAVE_SPEED)};
    float reach = 1.0 - smoothstep(${f(COLLAPSE_RADIUS * 0.45)}, ${f(COLLAPSE_RADIUS)}, dist);
    if (t > 0.0 && reach > 0.0) {
      float seed = hash12(iKit.xy * 1.37);
      vec2 dir = away / max(dist, 0.001);
      float lift = (2.5 + 4.0 * seed) * reach;
      float speed = (5.0 + 9.0 * hash12(iKit.yx * 2.11)) * reach;
      float land = 2.0 * lift / 9.8;
      float tf = min(t, land);
      float slide = min(max(t - land, 0.0), 0.5);
      float k = uBlast.w;
      vec3 axis = normalize(vec3(-dir.y, 0.4 * (seed - 0.5), dir.x));
      float spin = (2.5 + 4.0 * seed) * tf * k;
      vec3 pivot = vec3(0.0, 0.45, 0.0);
      local = kitTumble(local - pivot, axis, spin) + pivot;
      nrm = kitTumble(nrm, axis, spin);
      fab.xz += dir * speed * (tf + slide * 0.5) * k;
      fab.y += (lift * tf - 4.9 * tf * tf) * k;
    }
  }
  fab += kitRotY(local, iKit.z);
  nrm = kitRotY(nrm, iKit.z);
  fab.y -= limboDecay(iKit.xy, 0.6) * 14.0;
  fab.y += ripple(fab.xz);
  vKitColor = aTint.rgb;
  vKind = aTint.w * 16.0;
  vKitPaint = vKind > 4.5 ? kitCloth(iLook.y) : kitPaint(iLook.x);
  vKitUv = aKitUv;
  vFabric = fab;
  vLocal = position;
  P = fab;
  N = nrm;
  applyFolds(iKit.xy, P, N);
  vUpN = N.y;
}
`;

export const KIT_FRAG_HEAD = /* glsl */ `
varying vec3 vKitColor;
varying vec3 vKitPaint;
varying float vKind;
varying vec2 vKitUv;
varying vec3 vFabric;
varying vec3 vLocal;
varying float vUpN;
uniform float uNight;
uniform float uSnow;
uniform float uWet;
uniform vec4 uLook;      // ambient occlusion strength, night glow strength (src/world/look.ts)
uniform vec3 uFoliageA;
uniform vec3 uFoliageB;
float kitHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float kitNoise(vec2 p) {
  vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(kitHash(i), kitHash(i + vec2(1, 0)), u.x), mix(kitHash(i + vec2(0, 1)), kitHash(i + vec2(1, 1)), u.x), u.y);
}
vec3 kitPosterInk(float h) {
  if (h < 0.18) return vec3(0.62, 0.08, 0.05);
  if (h < 0.32) return vec3(0.05, 0.12, 0.35);
  if (h < 0.46) return vec3(0.8, 0.62, 0.12);
  if (h < 0.58) return vec3(0.04, 0.04, 0.05);
  if (h < 0.7) return vec3(0.12, 0.38, 0.32);
  if (h < 0.82) return vec3(0.75, 0.3, 0.1);
  return vec3(0.55, 0.12, 0.4);
}
// Posters (or, smaller, magazines) in rows: a picture block and lines of print on each, a thin dark margin between.
// uv in metres, scale the size of a sheet (1: a poster); dw how far uv moves across a pixel, to soften what is too fine to see.
vec3 kitPosters(vec2 uv, float scale, float dw) {
  vec2 cell = vec2(0.84, 1.14) * scale;
  vec2 g = uv / cell;
  g.x += 0.5 * mod(floor(g.y), 2.0);
  vec2 id = floor(g);
  vec2 f = fract(g);
  float h = kitHash(id + 3.7);
  float h2 = kitHash(id.yx + 9.1);
  vec3 paper = h2 < 0.35 ? vec3(0.78, 0.74, 0.64) : kitPosterInk(fract(h * 3.1));
  vec3 ink = h2 < 0.35 ? kitPosterInk(h) : (h2 < 0.7 ? vec3(0.8, 0.77, 0.7) : vec3(0.03));
  // a picture: a block or a disc in the upper part
  vec2 q = (f - vec2(0.5, 0.62)) * cell;
  float pic = h < 0.5 ? step(abs(q.x), cell.x * 0.32) * step(abs(q.y), cell.y * 0.2) : step(length(q), cell.x * 0.3);
  // lines of print below it
  float lines = step(0.12, f.y) * step(f.y, 0.34) * step(0.5, fract(f.y * 18.0)) * step(0.14, f.x) * step(f.x, 0.86 - 0.3 * kitHash(vec2(floor(f.y * 18.0), h)));
  vec3 col = mix(paper, ink, max(pic * (0.55 + 0.45 * h2), lines));
  vec2 m = 0.03 / cell;
  float sheet = step(m.x, f.x) * step(f.x, 1.0 - m.x) * step(m.y, f.y) * step(f.y, 1.0 - m.y);
  col = mix(vec3(0.03, 0.05, 0.04), col, sheet);
  // too fine to see: the sheet's average
  vec3 mean = mix(paper, ink, 0.3) * 0.9;
  return mix(col, mean, smoothstep(0.08, 0.3, dw / cell.x));
}
`;

export const KIT_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
// taken before any branch on the kind (a derivative inside one is undefined)
float kitDw = max(fwidth(vKitUv.x), fwidth(vKitUv.y));
float kind = floor(vKind + 0.5);
vec3 kitCol = vKitColor;
float kitRough = 0.82;
float kitMetal = 0.0;
vec3 kitGlow = vec3(0.0);
float kitSnow = 1.0;
// whatever stands on the pavement is darkest where it meets it
float kitAO = mix(0.55, 1.0, smoothstep(0.0, 0.45, vLocal.y));
if (kind < 1.5) {
  // matte: stone, wood, rattan, marble
} else if (kind < 2.5) {
  kitRough = 0.5; kitMetal = 0.35;
} else if (kind < 3.5) {
  kitRough = 0.22; kitMetal = 1.0;
} else if (kind < 4.5) {
  kitCol *= vKitPaint; kitRough = 0.28; kitMetal = 0.25;
} else if (kind < 5.5) {
  kitCol *= vKitPaint; kitRough = 0.92;
} else if (kind < 6.5) {
  kitCol = vec3(0.015, 0.017, 0.02); kitRough = 0.06; kitMetal = 0.1;
} else if (kind < 7.5) {
  kitGlow = vKitColor * (0.25 + 4.5 * uNight) * mix(1.0, uLook.y, uNight);
  kitCol *= 0.5; kitRough = 0.2; kitSnow = 0.0;
} else if (kind < 8.5) {
  kitRough = 0.95;
} else if (kind < 9.5) {
  // posters (green = 1) or magazines (smaller): lit from inside after dark
  kitCol = kitPosters(vKitUv, vKitColor.g, kitDw);
  kitRough = 0.6;
  kitGlow = kitCol * 0.6 * uNight * uLook.y;
  kitSnow = 0.0;
} else if (kind < 10.5) {
  float n = kitNoise(vFabric.xz * 9.0 + vLocal.y * 7.0) * 0.6 + kitNoise(vFabric.zx * 23.0 - vLocal.y * 19.0) * 0.4;
  kitCol = mix(uFoliageA, uFoliageB, n) * (0.55 + 0.6 * n);
  kitRough = 0.85;
  kitAO *= 0.75 + 0.25 * n;
} else if (kind < 11.5) {
  kitSnow = 0.0;
  if (vKitColor.r < 0.005) {
    // the shade under a car
    kitCol = vec3(0.004);
  } else {
    // the steps down into the metro: a light nosing on each, darker the deeper they go
    float depth = vKitUv.y;
    float step01 = smoothstep(0.78, 0.86, fract(depth / 0.3)) * (1.0 - smoothstep(0.02, 0.6, kitDw * 3.0));
    float walls = smoothstep(0.62, 0.8, abs(vKitUv.x));
    kitCol = vec3(0.1, 0.095, 0.085) * exp(-depth * 0.75) * (0.55 + 0.45 * step01) * (1.0 - 0.6 * walls);
  }
  kitRough = 0.9;
} else {
  kitRough = 0.3;
}
// snow settles on what faces up; rain makes everything shine
float kitSnowCover = uSnow * kitSnow * smoothstep(0.55, 0.85, vUpN);
kitCol = mix(kitCol, vec3(0.88, 0.9, 0.93), kitSnowCover);
kitRough = mix(kitRough, 0.75, kitSnowCover);
kitMetal *= 1.0 - kitSnowCover;
kitRough = mix(kitRough, kitRough * 0.45, uWet * (1.0 - kitSnowCover));
diffuseColor.rgb = kitCol;
`;
export const KIT_FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = kitRough;
`;
export const KIT_FRAG_METAL = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = kitMetal;
`;
export const KIT_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += kitGlow;
`;
export const KIT_FRAG_AO = /* glsl */ `
#include <aomap_fragment>
{
  float skyAO = mix(1.0, kitAO, uLook.x);
  reflectedLight.indirectDiffuse *= skyAO;
  reflectedLight.indirectSpecular *= mix(1.0, skyAO, 0.7);
}
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
