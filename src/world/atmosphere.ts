import * as THREE from 'three';

/**
 * The air between the eye and the city.
 *
 * One function describes the colour of the sky in any direction, and it is shared by
 * the sky dome and by everything that stands in front of it. Distant things take on the
 * colour of the air along the line of sight, so a district hanging overhead goes blue
 * like a far hill, and a street running to the horizon pales the way the horizon does.
 * At the very edge of the streamed city things do not fade to a colour at all: they turn
 * transparent, and what shows through is the sky that was drawn first, clouds, stars and
 * all. That is what hides the edge, whichever way you look at it.
 */

/** Sky colours, shared by the dome and the haze. The uniforms live in U (src/city/materials.ts). */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyBottom;
uniform vec3 uSkyFog;
uniform vec3 uSkySun;
uniform vec3 uSkySunDir;

// The empty sky in direction d: the gradient, before anything is put in it.
vec3 skyGradient(vec3 d) {
  vec3 col = mix(uSkyHorizon, uSkyTop, pow(clamp(d.y, 0.0, 1.0), 0.55));
  return mix(col, uSkyBottom, smoothstep(0.0, 0.25, -d.y));
}
// The glow of the air around the sun (the disc itself is the dome's business).
vec3 skySunGlow(vec3 d) {
  float s = max(dot(d, uSkySunDir), 0.0);
  return uSkySun * (pow(s, 60.0) * 0.6 + pow(s, 6.0) * 0.12) * smoothstep(-0.08, 0.05, uSkySunDir.y);
}
// Near the horizon the sky melts into the fog colour, and stays that colour below it.
vec3 skyHorizonMelt(vec3 col, vec3 d) {
  return mix(col, uSkyFog, 1.0 - smoothstep(-0.02, 0.16, d.y));
}
`;

const HAZE_PARS = /* glsl */ `
#include <fog_pars_fragment>
#ifdef USE_FOG
${SKY_GLSL}
uniform vec4 uHaze; // density of the air (1/m), extra density of the mist that lies on the ground, 1 / height of that mist, sun in-scatter
#endif
`;

// Replaces three's fog. fogNear and fogFar (still set through scene.fog) are where the
// edge of the streamed city starts and finishes dissolving.
const HAZE_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
{
  // camera to surface, in world space
  vec3 hzRay = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz;
  float hzDist = length(hzRay);
  vec3 hzDir = hzRay / max(hzDist, 1e-3);
  // The mist thins out with height, so average it along the ray. (Heights are clamped at the
  // street: the wet-street mirror looks up from below it.)
  float hzA = max(cameraPosition.y, 0.0) * uHaze.z;
  float hzB = max(cameraPosition.y + hzRay.y, 0.0) * uHaze.z;
  float hzT = hzB - hzA;
  float hzMist = abs(hzT) > 0.01 ? (exp(-hzA) - exp(-hzB)) / hzT : exp(-hzA);
  float hzAmount = 1.0 - exp(-hzDist * (uHaze.x + uHaze.y * hzMist));
  // what the air scatters towards the eye: the sky behind, warmed towards the sun
  float hzSun = max(dot(hzDir, uSkySunDir), 0.0);
  vec3 hzAir = skyHorizonMelt(skyGradient(hzDir) + skySunGlow(hzDir), hzDir);
  hzAir += uSkySun * (hzSun * hzSun * hzSun * hzSun) * uHaze.w * smoothstep(-0.08, 0.05, uSkySunDir.y);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hzAir, hzAmount);
  gl_FragColor.a *= 1.0 - smoothstep(fogNear, fogFar, hzDist);
}
#endif
`;

function must(src: string, find: string): string {
  if (!src.includes(find)) throw new Error(`shader patch target missing: ${find}`);
  return find;
}

/** Swap three's fog for the haze in a built-in material's fragment shader (call from onBeforeCompile). */
export function patchHaze(shader: { fragmentShader: string }): void {
  let f = shader.fragmentShader;
  f = f.replace(must(f, '#include <fog_pars_fragment>'), HAZE_PARS);
  f = f.replace(must(f, '#include <fog_fragment>'), HAZE_FRAGMENT);
  shader.fragmentShader = f;
}

/**
 * Let a material dissolve into the sky at the edge of the streamed city. It stays in the
 * opaque pass (drawn front to back, writing depth): only its last stretch before the edge
 * has an alpha below one, and there it is blended over the sky that is already in the frame.
 */
export function blendIntoSky(mat: THREE.Material): void {
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.SrcAlphaFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  // the frame's own alpha stays at one
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
}
