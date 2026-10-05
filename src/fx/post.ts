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
  col = (col - 0.5) * uContrast + 0.5;
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

  get u() {
    return this.grade.uniforms as typeof GradeShader.uniforms;
  }
}
