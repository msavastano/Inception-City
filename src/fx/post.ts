import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** Display-referred finishing: grade, chromatic aberration from instability, vignette, grain, kick flash. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uFlash: { value: 0 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.035 },
    uDim: { value: 0 },
    uHurt: { value: 0 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uAberration;
uniform vec3 uTint;
uniform float uSaturation;
uniform float uContrast;
uniform float uFlash;
uniform float uVignette;
uniform float uGrain;
uniform float uDim;
uniform float uHurt;
varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  vec2 off = c * r2 * uAberration;
  vec3 col;
  col.r = texture2D(tDiffuse, vUv + off).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv - off).b;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  // teal shadows, warm highlights
  col *= mix(vec3(0.94, 1.0, 1.04), uTint, smoothstep(0.1, 0.8, l));
  // contrast is an S-curve through mid-grey, so black stays black and white stays white
  col = clamp(col, 0.0, 1.0);
  vec3 up = pow(col, vec3(uContrast));
  vec3 down = pow(1.0 - col, vec3(uContrast));
  col = up / (up + down);
  col *= 1.0 - uVignette * smoothstep(0.08, 0.55, r2 * 1.6);
  // hurt: the edges of the picture run red
  float hurtEdge = uHurt * smoothstep(0.04, 0.5, r2 * 1.6);
  col = mix(col, col * vec3(0.9, 0.2, 0.16) + vec3(0.16, 0.0, 0.0), hurtEdge);
  col += (h(vUv * 913.0 + fract(uTime) * 71.0) - 0.5) * uGrain;
  col = mix(col, vec3(1.0), uFlash);
  col *= 1.0 - uDim;
  gl_FragColor = vec4(col, 1.0);
}`,
};

/** A rough size for a render target on the GPU: colour (with mips and MSAA samples) plus its depth buffer. */
export function targetBytes(t: THREE.RenderTarget): number {
  const px = t.width * t.height;
  const bpp = t.texture.type === THREE.HalfFloatType ? 8 : t.texture.type === THREE.FloatType ? 16 : 4;
  const colour = px * bpp * (t.texture.generateMipmaps ? 4 / 3 : 1);
  const msaa = t.samples > 0 ? px * bpp * t.samples : 0;
  const depth = t.depthBuffer ? px * 4 * Math.max(1, t.samples) : 0;
  return colour + msaa + depth;
}

export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  enabled = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    samples = 4,
  ) {
    const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.3, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Every render target the chain owns (for the bench's memory estimate). */
  targets(): THREE.RenderTarget[] {
    const b = this.bloom;
    return [this.composer.renderTarget1, this.composer.renderTarget2, b.renderTargetBright, ...b.renderTargetsHorizontal, ...b.renderTargetsVertical];
  }

  get u() {
    return this.grade.uniforms as typeof GradeShader.uniforms;
  }
}
