import * as THREE from 'three';
import { U } from '../city/materials';
import { DreamLevel, LEVELS, Palette, Weather } from './themes';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uTime;
uniform float uCloud;
uniform vec3 uFog;
varying vec3 vDir;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float h2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n2(vec2 p) { vec2 i = floor(p); vec2 u = fract(p); u = u * u * (3.0 - 2.0 * u);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), u.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n2(p); p *= 2.07; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col = mix(uHorizon, uTop, pow(clamp(y, 0.0, 1.0), 0.55));
  col = mix(col, uBottom, smoothstep(0.0, 0.25, -y));
  float s = max(dot(d, uSunDir), 0.0);
  float vis = smoothstep(-0.08, 0.05, uSunDir.y);
  col += uSunColor * (pow(s, 900.0) * 30.0 + pow(s, 60.0) * 0.6 + pow(s, 6.0) * 0.12) * vis;
  // the moon
  vec3 moonDir = normalize(vec3(-0.4, 0.55, -0.73));
  float m = max(dot(d, moonDir), 0.0);
  col += vec3(0.8, 0.85, 1.0) * (smoothstep(0.9993, 0.9996, m) * 2.0 + pow(m, 80.0) * 0.08) * uNight;
  // stars
  vec3 cell = floor(d * 380.0);
  float star = step(0.9975, h3(cell)) * smoothstep(0.0, 0.25, y);
  col += vec3(star) * uNight * (0.6 + 0.4 * sin(uTime * 2.0 + h3(cell + 3.0) * 30.0));
  // drifting clouds
  if (y > 0.0) {
    vec2 uv = d.xz / (y + 0.12) * 1.4 + vec2(uTime * 0.012, uTime * 0.004);
    float c = smoothstep(0.48, 0.82, fbm(uv)) * uCloud * smoothstep(0.0, 0.2, y);
    vec3 cloudCol = mix(uHorizon * 1.05, uSunColor, 0.25 * vis) * (1.0 - 0.6 * uNight);
    col = mix(col, cloudCol, c * 0.85);
  }
  // melt into the fog at the horizon so the edge of the streamed city never shows
  col = mix(col, uFog, 1.0 - smoothstep(-0.02, 0.16, y));
  gl_FragColor = vec4(col, 1.0);
}`;

const WEATHER_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam;
uniform float uTime;
uniform vec3 uBox;
uniform float uSpeed;
uniform vec2 uWind;
uniform float uSize;
uniform float uStreak;
varying float vFade;
void main() {
  vec3 p = aSeed.xyz * uBox;
  float t = uTime * (0.75 + 0.5 * aSeed.w);
  p.y -= t * uSpeed;
  p.xz += uWind * t + vec2(sin(t * 0.7 + aSeed.w * 30.0), cos(t * 0.5 + aSeed.w * 20.0)) * (1.0 - uStreak) * 1.5;
  p = mod(p - uCam + uBox * 0.5, uBox) + uCam - uBox * 0.5;
  // rain is drawn as streaks: odd vertices trail along the fall direction
  p += vec3(uWind.x, -uSpeed, uWind.y) * 0.045 * uStreak * mod(float(gl_VertexID), 2.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFade = 1.0 - smoothstep(uBox.x * 0.25, uBox.x * 0.5, length(mv.xyz));
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * 60.0 / max(1.0, -mv.z);
}`;

const WEATHER_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uStreak;
varying float vFade;
void main() {
  float a = uOpacity * vFade;
  if (uStreak < 0.5) {
    vec2 c = gl_PointCoord - 0.5;
    a *= smoothstep(0.5, 0.15, length(c));
  }
  gl_FragColor = vec4(uColor, a);
}`;

const tmp = new THREE.Color();

function lerpColor(target: THREE.Color, hex: number, k: number): void {
  tmp.setHex(hex);
  target.lerp(tmp, k);
}

/** Sky, sun, fog, weather and the dream-level look. */
export class Environment {
  readonly sky: THREE.Mesh;
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly fog = new THREE.Fog(0xcccccc, 200, 1000);
  readonly sunDir = new THREE.Vector3(0.3, 0.8, 0.4).normalize();
  level: DreamLevel = LEVELS[0];
  time = LEVELS[0].time;
  night = 0;
  private weatherRain: THREE.LineSegments;
  private weatherFlakes: THREE.Points;
  private weatherUniforms;
  private skyU;
  private colors = {
    top: new THREE.Color(),
    horizon: new THREE.Color(),
    bottom: new THREE.Color(),
    fog: new THREE.Color(),
    sun: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
  };
  private scalars = { sun: 2, hemi: 1, snow: 0, wet: 0, limbo: 0 };
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envDirty = 1;
  private envClock = 0;

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) {
    this.skyU = {
      uTop: { value: this.colors.top },
      uHorizon: { value: this.colors.horizon },
      uBottom: { value: this.colors.bottom },
      uSunColor: { value: this.colors.sun },
      uSunDir: { value: this.sunDir },
      uNight: { value: 0 },
      uTime: U.uTime,
      uCloud: { value: 0.7 },
      uFog: { value: this.colors.fog },
    };
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyU,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);
    this.envScene.add(new THREE.Mesh(this.sky.geometry, skyMat));

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.8;
    const cam = this.sun.shadow.camera;
    cam.near = 10;
    cam.far = 3000;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;

    this.weatherUniforms = {
      uCam: { value: new THREE.Vector3() },
      uTime: U.uTime,
      uBox: { value: new THREE.Vector3(140, 90, 140) },
      uSpeed: { value: 30 },
      uWind: { value: new THREE.Vector2(3, 1) },
      uSize: { value: 2 },
      uStreak: { value: 1 },
      uColor: { value: new THREE.Color(0.7, 0.75, 0.85) },
      uOpacity: { value: 0.35 },
    };
    const rainGeo = new THREE.BufferGeometry();
    const drops = 7000;
    const rainSeeds = new Float32Array(drops * 2 * 4);
    for (let i = 0; i < drops; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      rainSeeds.set(s, i * 8);
      rainSeeds.set(s, i * 8 + 4);
    }
    rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(rainSeeds, 4));
    rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(drops * 2 * 3), 3));
    const wMat = () =>
      new THREE.ShaderMaterial({
        uniforms: this.weatherUniforms,
        vertexShader: WEATHER_VERT,
        fragmentShader: WEATHER_FRAG,
        transparent: true,
        depthWrite: false,
      });
    this.weatherRain = new THREE.LineSegments(rainGeo, wMat());
    const flakeGeo = new THREE.BufferGeometry();
    const flakes = 9000;
    const flakeSeeds = new Float32Array(flakes * 4);
    for (let i = 0; i < flakeSeeds.length; i++) flakeSeeds[i] = Math.random();
    flakeGeo.setAttribute('aSeed', new THREE.BufferAttribute(flakeSeeds, 4));
    flakeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flakes * 3), 3));
    this.weatherFlakes = new THREE.Points(flakeGeo, wMat());
    for (const w of [this.weatherRain, this.weatherFlakes]) {
      w.frustumCulled = false;
      w.visible = false;
      scene.add(w);
    }

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.applyInstant();
  }

  setLevel(level: DreamLevel, time = level.time): void {
    this.level = level;
    this.time = time;
    this.envDirty = 1;
  }

  setTime(t: number): void {
    this.time = t;
    this.envDirty = 1;
  }

  private targetPalette(): { p: Palette; dusk: number } {
    const t = this.time;
    const night = THREE.MathUtils.smoothstep(t, 0.48, 0.78);
    const dusk = Math.exp(-(((t - 0.52) / 0.11) ** 2));
    const a = this.level.day;
    const b = this.level.night;
    const mix = (x: number, y: number) => tmp.setHex(x).lerp(new THREE.Color(y), night).getHex();
    return {
      p: {
        skyTop: mix(a.skyTop, b.skyTop),
        skyHorizon: mix(a.skyHorizon, b.skyHorizon),
        skyBottom: mix(a.skyBottom, b.skyBottom),
        fog: mix(a.fog, b.fog),
        sun: mix(a.sun, b.sun),
        sunIntensity: THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, night),
        hemiSky: mix(a.hemiSky, b.hemiSky),
        hemiGround: mix(a.hemiGround, b.hemiGround),
        hemiIntensity: THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, night),
      },
      dusk,
    };
  }

  /** Jump straight to the target look (no cross-fade). */
  applyInstant(): void {
    this.blend(1);
    this.night = THREE.MathUtils.smoothstep(this.time, 0.48, 0.78);
  }

  private blend(k: number): void {
    const { p, dusk } = this.targetPalette();
    const c = this.colors;
    lerpColor(c.top, p.skyTop, k);
    lerpColor(c.horizon, p.skyHorizon, k);
    lerpColor(c.bottom, p.skyBottom, k);
    lerpColor(c.fog, p.fog, k);
    lerpColor(c.sun, p.sun, k);
    lerpColor(c.hemiSky, p.hemiSky, k);
    lerpColor(c.hemiGround, p.hemiGround, k);
    // sunset warmth
    const warm = dusk * (1 - this.level.limbo * 0.5) * k;
    c.horizon.lerp(tmp.setHex(0xf09060), warm * 0.55);
    c.fog.lerp(tmp.setHex(0xc89078), warm * 0.35);
    c.sun.lerp(tmp.setHex(0xff8a40), warm * 0.7);
    const s = this.scalars;
    s.sun += (p.sunIntensity - s.sun) * k;
    s.hemi += (p.hemiIntensity - s.hemi) * k;
    s.snow += (this.level.snow - s.snow) * k;
    s.wet += (this.level.wet - s.wet) * k;
    s.limbo += (this.level.limbo - s.limbo) * k;
  }

  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3, shadowExtent: number): void {
    const k = 1 - Math.exp(-dt * 2.2);
    this.blend(k);
    const c = this.colors;
    const night = THREE.MathUtils.smoothstep(this.time, 0.48, 0.78);
    this.night += (night - this.night) * k;

    const elev = THREE.MathUtils.degToRad(62) * Math.cos(this.time * Math.PI * 0.95);
    const az = this.level.sunAzimuth;
    this.sunDir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).normalize();
    const lightDir = this.sunDir.y > 0.05 ? this.sunDir : new THREE.Vector3(-0.4, 0.55, -0.73).normalize();

    this.sun.color.copy(c.sun);
    this.sun.intensity = this.scalars.sun * (this.sunDir.y > 0.05 ? THREE.MathUtils.smoothstep(this.sunDir.y, 0.0, 0.2) : 1);
    this.hemi.color.copy(c.hemiSky);
    this.hemi.groundColor.copy(c.hemiGround);
    this.hemi.intensity = this.scalars.hemi;
    this.fog.color.copy(c.fog);

    this.sun.position.copy(focus).addScaledVector(lightDir, 1200);
    this.sun.target.position.copy(focus);
    const sc = this.sun.shadow.camera;
    if (sc.right !== shadowExtent) {
      sc.left = -shadowExtent;
      sc.right = shadowExtent;
      sc.top = shadowExtent;
      sc.bottom = -shadowExtent;
      sc.updateProjectionMatrix();
    }

    this.sky.position.copy(camera.position);
    this.skyU.uNight.value = this.night;
    this.skyU.uCloud.value = this.level.weather === 'none' ? 0.55 : 0.9;

    U.uNight.value = this.night;
    U.uSnow.value = this.scalars.snow;
    U.uWet.value = this.scalars.wet;
    U.uLimbo.value = this.scalars.limbo;
    U.uSeaColor.value.lerp(tmp.setHex(this.level.sea), k);
    U.uFoliageA.value.lerp(tmp.setHex(this.level.foliageA), k);
    U.uFoliageB.value.lerp(tmp.setHex(this.level.foliageB), k);

    this.updateWeather(this.level.weather, camera);

    // Re-render the reflection environment while the look is changing.
    this.envClock += dt;
    if (this.envDirty > 0 && this.envClock > 0.4) {
      this.envClock = 0;
      this.envDirty -= 0.2;
      this.envTarget?.dispose();
      this.envScene.children[0].position.set(0, 0, 0);
      this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 6000);
      this.scene.environment = this.envTarget.texture;
    }
    this.scene.environmentIntensity = 0.6 * (1 - this.night * 0.75);
  }

  private updateWeather(kind: Weather, camera: THREE.Camera): void {
    const u = this.weatherUniforms;
    u.uCam.value.copy(camera.position);
    this.weatherRain.visible = kind === 'rain';
    this.weatherFlakes.visible = kind === 'snow' || kind === 'ash';
    if (kind === 'rain') {
      u.uSpeed.value = 34;
      u.uWind.value.set(4, 1.5);
      u.uStreak.value = 1;
      u.uColor.value.setRGB(0.68, 0.74, 0.84);
      u.uOpacity.value = 0.32;
    } else if (kind === 'snow') {
      u.uSpeed.value = 2.2;
      u.uWind.value.set(1.2, 0.4);
      u.uStreak.value = 0;
      u.uSize.value = 2.6;
      u.uColor.value.setRGB(0.97, 0.98, 1);
      u.uOpacity.value = 0.9;
    } else if (kind === 'ash') {
      u.uSpeed.value = 0.9;
      u.uWind.value.set(-0.8, 0.5);
      u.uStreak.value = 0;
      u.uSize.value = 1.6;
      u.uColor.value.setRGB(0.55, 0.53, 0.5);
      u.uOpacity.value = 0.6;
    }
  }
}
