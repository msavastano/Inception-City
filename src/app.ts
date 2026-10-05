import * as THREE from 'three';
import { COLLAPSE_RADIUS, MAX_FOLDS } from './core/config';
import { Fold, FoldStack, foldPoint } from './core/fold';
import { totemGeometry } from './city/geometry';
import { U } from './city/materials';
import { CityStreamer } from './city/streamer';
import { DreamAudio } from './fx/audio';
import { Picker } from './fx/picking';
import { PostFX } from './fx/post';
import { ArchitectMode, Tool } from './modes/architect';
import { DreamContext } from './modes/context';
import { DreamWalk } from './modes/dreamwalk';
import { PRESETS, Preset } from './modes/presets';
import { Totem } from './ui/totem';
import { Collapse, planShards } from './world/collapse';
import { Environment } from './world/environment';
import { HALL_LENGTH, Hallway } from './world/hallway';
import { Projections } from './world/projections';
import { LEVELS } from './world/themes';

type Mode = 'architect' | 'walk';
type QualityName = 'low' | 'medium' | 'high' | 'ultra';

const PUBLIC_URL = 'https://msavastano.github.io/Inception-City/';

// mirror: resolution of the wet-street reflection as a fraction of the screen (0 = lamp glints only)
// shards: pieces of wall the café explosion throws when stability hits zero
const QUALITY: Record<QualityName, { pr: number; shadow: number; extent: number; bloom: boolean; view: number; props: number; chunks: number; crowd: number; mirror: number; shards: number }> = {
  ultra: { pr: 2, shadow: 4096, extent: 460, bloom: true, view: 1300, props: 650, chunks: 150, crowd: 900, mirror: 0.5, shards: 7000 },
  high: { pr: 1.5, shadow: 2048, extent: 380, bloom: true, view: 1050, props: 480, chunks: 120, crowd: 600, mirror: 0.5, shards: 5000 },
  medium: { pr: 1, shadow: 2048, extent: 320, bloom: true, view: 820, props: 360, chunks: 90, crowd: 400, mirror: 0.35, shards: 3200 },
  low: { pr: 0.75, shadow: 0, extent: 260, bloom: false, view: 620, props: 240, chunks: 60, crowd: 180, mirror: 0, shards: 1600 },
};
/** Instability at which the dream collapses (the HUD reads 0% stability). */
const COLLAPSE_AT = 0.995;
const ORDER: QualityName[] = ['low', 'medium', 'high', 'ultra'];
const MAX_CHUNKS = 150;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '∞';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor((sec / 3600) % 24);
  const d = Math.floor(sec / 86400);
  const p = (n: number) => String(n).padStart(2, '0');
  if (d >= 365) return `${(d / 365).toFixed(1)} years`;
  if (d > 0) return `${d}d ${p(h)}h ${p(m)}m`;
  if (h > 0) return `${h}h ${p(m)}m ${p(s)}s`;
  return `${p(m)}:${p(s)}`;
}

/**
 * The dream: owns the renderer, the fold stack, the streamed city and the two
 * ways of being in it (architect and dreamer), and runs the frame loop.
 */
export class App implements DreamContext {
  readonly canvas = $<HTMLCanvasElement>('scene');
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.5, 9000);
  readonly folds = new FoldStack();
  readonly streamer: CityStreamer;
  readonly picker: Picker;
  readonly audio = new DreamAudio();
  readonly env: Environment;
  readonly post: PostFX;
  readonly architect: ArchitectMode;
  readonly walk: DreamWalk;
  readonly crowd: Projections;
  readonly hallway = new Hallway();
  readonly collapse = new Collapse(QUALITY.ultra.shards);
  private totem: Totem;
  time = 0;
  snap = true;
  mode: Mode = 'architect';
  private started = false;
  private seed: number;
  private levelIndex = 0;
  private instability = 0;
  private flash = 0;
  private realElapsed = 0;
  private dreamElapsed = 0;
  private quality: QualityName = 'high';
  private autoQuality = true;
  private frameAvg = 1 / 60;
  private qualityClock = 0;
  private lastQualityChange = 0;
  private lastDowngrade = -100;
  private statsClock = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 60;
  private crowdCount: number;
  private foldsVersion = -1;
  private toastTimer = 0;
  private pendingPreset: Preset | null = null;
  private timer = new THREE.Timer();

  constructor() {
    const params = new URLSearchParams(location.hash.slice(1));
    this.seed = Number(params.get('s')) || Math.floor(Math.random() * 1e6);
    const mobile = matchMedia('(pointer: coarse)').matches;
    const forced = params.get('q') as QualityName | null;
    this.quality = forced && forced in QUALITY ? forced : mobile ? 'medium' : 'high';
    if (forced) this.autoQuality = false;
    this.crowdCount = QUALITY[this.quality].crowd;
    if (mobile) document.body.classList.add('touch');

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.env = new Environment(this.scene, this.renderer);
    this.streamer = new CityStreamer(this.seed, MAX_CHUNKS);
    this.scene.add(this.streamer.group);
    this.picker = new Picker(this.renderer, this.streamer.pickGroup);

    // The folds' uniform arrays are shared with every folded material.
    U.uFoldA.value = this.folds.uA;
    U.uFoldB.value = this.folds.uB;

    this.scene.add(this.makeTotem());
    this.crowd = new Projections(this.streamer.propMaterial, this.streamer.propDepth, QUALITY.ultra.crowd);
    this.crowd.setCount(this.crowdCount, 0, 0);
    this.crowd.onCaught = () => {
      if (this.mode === 'walk') {
        this.kick('The projections found you');
        setTimeout(() => this.setMode('architect'), 700);
      }
    };
    this.scene.add(this.crowd.mesh);
    this.scene.add(this.hallway.mesh);
    this.scene.add(this.collapse.mesh);

    this.post = new PostFX(this.renderer, this.scene, this.camera, mobile || this.quality === 'low' ? 0 : 4);
    this.architect = new ArchitectMode(this);
    this.walk = new DreamWalk(this);
    this.walk.onPause = () => {
      if (this.mode === 'walk') $('pause').hidden = false;
    };
    this.totem = new Totem($<HTMLCanvasElement>('totem'));

    const lvl = Math.min(LEVELS.length - 1, Math.max(0, (Number(params.get('l')) || 1) - 1));
    this.setLevel(lvl, params.has('t') ? Number(params.get('t')) : undefined);
    if (params.get('f')) this.folds.deserialize(params.get('f')!);

    this.camera.position.set(520, 300, -380);
    this.camera.lookAt(0, 30, 0);
    this.architect.controls.target.set(0, 20, 0);

    this.applyQuality(this.quality);
    this.bindUI();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private makeTotem(): THREE.Mesh {
    const base = totemGeometry();
    const g = new THREE.InstancedBufferGeometry();
    for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
    g.setAttribute('iPosYaw', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, 0]), 4));
    g.setAttribute('iParam', new THREE.InstancedBufferAttribute(new Float32Array([1, 0.5, 0, 1.6]), 4));
    g.setAttribute('iState', new THREE.InstancedBufferAttribute(new Float32Array([0, 3, 0, 0]), 4));
    g.instanceCount = 1;
    const mesh = new THREE.Mesh(g, this.streamer.propMaterial);
    mesh.customDepthMaterial = this.streamer.propDepth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  // ---------------------------------------------------------------- context

  foldCommitted(strength: number): void {
    this.audio.braam(0.55 + 0.45 * strength);
    this.instability = Math.min(1, this.instability + 0.1 + 0.16 * strength);
    this.flash = Math.max(this.flash, 0.06 * strength);
  }

  hint(text: string): void {
    $('hint').textContent = text;
  }

  kick(reason?: string): void {
    this.collapse.release();
    this.audio.kick();
    if (this.hallway.active) this.walk.collapseHallway();
    const f = this.focus();
    U.uRipple.value.set(f.x, f.z, this.time, 7);
    this.folds.clear(3.2);
    this.flash = 0.85;
    this.instability = 0;
    this.crowd.calm();
    if (this.mode === 'walk' && this.levelIndex > 0) {
      this.setLevel(this.levelIndex - 1);
      this.toast(reason ?? 'Kick', `You wake up into ${LEVELS[this.levelIndex].name}.`);
    } else {
      this.toast(reason ?? 'Kick', 'The dream snaps flat.');
    }
  }

  /** Stability hit zero: the facades blow out around the dreamer and hang in slow motion until the kick. */
  private blowUp(): void {
    let f = this.focus();
    if (this.mode === 'architect') {
      // the architect is looking at the middle of the screen, which may be on a folded flap
      const r = this.canvas.getBoundingClientRect();
      const hit = this.picker.pick(this.camera, r.left + r.width / 2, r.top + r.height / 2);
      if (hit) f = { x: hit.x, z: hit.z };
    }
    const near = this.streamer.buildingsNear(f.x, f.z, COLLAPSE_RADIUS);
    this.collapse.start(f.x, f.z, planShards(near, f.x, f.z, QUALITY[this.quality].shards, Math.floor(this.time * 1000)));
    this.audio.shatter();
    this.flash = Math.max(this.flash, 0.3);
  }

  // ---------------------------------------------------------------- modes

  setMode(mode: Mode): void {
    if (mode === this.mode && this.started) return;
    this.mode = mode;
    document.body.classList.toggle('walk', mode === 'walk');
    $('pause').hidden = true;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) b.classList.toggle('on', b.dataset.mode === mode);
    if (mode === 'walk') {
      this.architect.exit();
      this.camera.near = 0.1;
      this.camera.updateProjectionMatrix();
      const r = this.canvas.getBoundingClientRect();
      const hit = this.picker.pick(this.camera, r.left + r.width / 2, r.top + r.height / 2);
      const t = this.architect.controls.target;
      this.walk.enter(hit ? hit.x : t.x, hit ? hit.z : t.z);
      if (this.hallway.open) {
        // start a few steps from the hallway's open end, facing in
        const [ax, az] = this.hallway.axis;
        this.walk.x = this.hallway.cx - ax * (HALL_LENGTH / 2 + 8);
        this.walk.z = this.hallway.cz - az * (HALL_LENGTH / 2 + 8);
        this.walk.yaw = this.hallway.axisYaw;
      }
    } else {
      const fromWalk = this.walk.active;
      this.walk.exit();
      this.camera.near = 0.5;
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
      this.camera.up.set(0, 1, 0);
      this.architect.enter();
      if (fromWalk) {
        const p = new THREE.Vector3(this.walk.x, 0, this.walk.z);
        foldPoint(this.folds.active, this.walk.x, this.walk.z, p);
        const back = new THREE.Vector3(-Math.sin(this.walk.yaw), 0, -Math.cos(this.walk.yaw));
        this.architect.controls.target.copy(this.camera.position);
        this.architect.flyTo(p.clone().addScaledVector(back, 140).add(new THREE.Vector3(0, 110, 0)), p, 2.0);
      }
    }
  }

  setTool(tool: Tool): void {
    this.architect.setTool(tool);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tool-seg button')) b.classList.toggle('on', b.dataset.tool === tool);
  }

  setLevel(i: number, time?: number): void {
    this.levelIndex = i;
    const level = LEVELS[i];
    this.env.setLevel(level, time ?? level.time);
    $('level-name').textContent = level.name;
    $('level-sub').textContent = level.subtitle;
    $('dilation').textContent = Number.isFinite(level.dilation) ? `1 second here = ${level.dilation} in the dream` : 'Time has no meaning here';
    $<HTMLInputElement>('time').value = String(this.env.time);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#level-seg button')) b.classList.toggle('on', Number(b.dataset.level) === i);
  }

  applyPreset(p: Preset): void {
    if (this.hallway.rider) this.walk.collapseHallway();
    if (p.hallway) this.hallway.spawn(p.hallway.x, p.hallway.z, p.hallway.alongX);
    else this.hallway.dismiss();
    for (const f of this.folds.live()) this.folds.remove(f);
    for (const s of p.folds) this.folds.add(s.hx, s.hz, s.nx, s.nz, s.angle, s.radius, 2.4);
    if (this.mode === 'architect') {
      this.architect.flyTo(new THREE.Vector3(...p.camera.pos), new THREE.Vector3(...p.camera.target), 2.6);
    }
    this.foldCommitted(1);
    this.toast(p.name, p.blurb);
  }

  /** Test hook: finish every animation now (used by the headless screenshot script). */
  settle(seconds = 12): void {
    this.time += seconds;
    for (const f of this.folds.folds) {
      f.angle = f.target;
      f.vel = 0;
    }
    this.architect.finishFlight();
    this.walk.finishTransition();
    this.hallway.settle();
    this.env.applyInstant();
    if (this.pendingPreset) {
      this.applyPreset(this.pendingPreset);
      this.pendingPreset = null;
      for (const f of this.folds.folds) {
        f.angle = f.target;
        f.vel = 0;
      }
      this.architect.finishFlight();
    }
  }

  focus(): { x: number; z: number } {
    return this.mode === 'walk' ? { x: this.walk.x, z: this.walk.z } : this.architect.focus();
  }

  // ---------------------------------------------------------------- UI

  private toast(title: string, sub = ''): void {
    const el = $('toast');
    el.innerHTML = '';
    el.append(title);
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      el.append(s);
    }
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 3200);
  }

  private start(mode: Mode): void {
    $('intro').hidden = true;
    document.body.classList.remove('intro');
    this.audio.start();
    const first = !this.started;
    this.started = true;
    if (mode === 'walk') {
      this.architect.controls.target.set(0, 0, -70);
      this.setMode('walk');
      return;
    }
    this.setMode('architect');
    if (first && this.folds.live().length === 0) {
      this.pendingPreset = PRESETS[0];
      this.architect.flyTo(new THREE.Vector3(...PRESETS[0].camera.pos), new THREE.Vector3(0, 40, 120), 3.2);
      this.hint('Watch the street ahead…');
    }
  }

  private bindUI(): void {
    $('go-architect').addEventListener('click', () => this.start('architect'));
    $('go-walk').addEventListener('click', () => this.start('walk'));
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) b.addEventListener('click', () => this.setMode(b.dataset.mode as Mode));
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tool-seg button')) b.addEventListener('click', () => this.setTool(b.dataset.tool as Tool));
    $<HTMLInputElement>('snap').addEventListener('change', (e) => (this.snap = (e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('creases').addEventListener('change', (e) => (U.uShowCreases.value = (e.target as HTMLInputElement).checked ? 1 : 0));
    $('undo').addEventListener('click', () => this.undo());
    $('kick').addEventListener('click', () => this.kick());

    const presets = $('presets');
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.textContent = p.name;
      b.title = p.blurb;
      b.addEventListener('click', () => this.applyPreset(p));
      presets.append(b);
    }
    const levels = $('level-seg');
    LEVELS.forEach((l, i) => {
      const b = document.createElement('button');
      b.textContent = i === LEVELS.length - 1 ? 'Limbo' : String(l.id);
      b.dataset.level = String(i);
      b.title = l.name;
      b.addEventListener('click', () => this.setLevel(i));
      levels.append(b);
    });
    this.setLevel(this.levelIndex, this.env.time);

    $<HTMLInputElement>('time').addEventListener('input', (e) => this.env.setTime(Number((e.target as HTMLInputElement).value)));
    const crowd = $<HTMLInputElement>('crowd');
    crowd.value = String(this.crowdCount);
    $('crowd-n').textContent = String(this.crowdCount);
    crowd.addEventListener('input', () => {
      this.crowdCount = Number(crowd.value);
      $('crowd-n').textContent = crowd.value;
      const f = this.focus();
      this.crowd.setCount(this.crowdCount, f.x, f.z);
    });

    $('share').addEventListener('click', () => this.share());
    $('reseed').addEventListener('click', () => {
      this.seed = Math.floor(Math.random() * 1e6);
      this.collapse.stop();
      this.folds.clear(4);
      this.streamer.resetAll(this.seed);
      this.toast('A new city', `Seed ${this.seed}`);
    });
    $<HTMLSelectElement>('quality').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.autoQuality = v === 'auto';
      if (!this.autoQuality) this.applyQuality(v as QualityName);
    });
    $('mute').addEventListener('click', () => {
      this.audio.start();
      this.audio.setMuted(!this.audio.muted);
      $('mute').textContent = this.audio.muted ? 'Sound off' : 'Sound on';
    });
    // Small screens start with the desk tucked away so the dream is visible.
    if (window.matchMedia('(max-width: 720px), (max-height: 500px)').matches) {
      $('panel').classList.add('closed');
      $('panel-toggle').setAttribute('aria-expanded', 'false');
    }
    $('panel-toggle').addEventListener('click', () => {
      const closed = $('panel').classList.toggle('closed');
      $('panel-toggle').setAttribute('aria-expanded', String(!closed));
    });
    $('resume').addEventListener('click', () => {
      $('pause').hidden = true;
      this.walk.lock();
    });
    $('wake').addEventListener('click', () => this.setMode('architect'));
    for (const b of document.querySelectorAll<HTMLButtonElement>('#touch-ui button')) {
      b.addEventListener('click', () => {
        const a = b.dataset.touch;
        if (a === 'jump') this.walk.jump();
        if (a === 'fold') this.walk.foldAhead(true);
        if (a === 'ride') this.walk.ride();
        if (a === 'hall') this.walk.toggleHallway();
        if (a === 'kick') this.kick();
        if (a === 'wake') this.setMode('architect');
      });
    }

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || !this.started) return;
      switch (e.code) {
        case 'Tab':
          e.preventDefault();
          this.setMode(this.mode === 'walk' ? 'architect' : 'walk');
          break;
        case 'KeyK':
          this.kick();
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4':
          this.setLevel(Number(e.code.slice(5)) - 1);
          break;
        case 'KeyM':
          $('mute').click();
          break;
        case 'KeyZ':
          this.undo();
          break;
        case 'KeyF':
          if (this.mode === 'walk') this.walk.foldAhead(true);
          else this.setTool('fold');
          break;
        case 'KeyV':
          if (this.mode === 'walk') this.walk.foldAhead(false);
          break;
        case 'KeyR':
          if (this.mode === 'architect') this.setTool('raise');
          break;
        case 'KeyO':
          if (this.mode === 'architect') this.setTool('orbit');
          break;
        case 'KeyQ':
          if (this.mode === 'walk') this.setMode('architect');
          break;
        case 'KeyE':
          if (this.mode === 'walk') this.walk.ride();
          break;
        case 'KeyH':
          if (this.mode === 'walk') this.walk.toggleHallway();
          else if (this.hallway.open) this.hallway.dismiss();
          else this.applyPreset(PRESETS.find((p) => p.hallway) ?? PRESETS[0]);
          break;
      }
    });
  }

  private undo(): void {
    const live = this.folds.live();
    if (live.length) this.folds.remove(live[live.length - 1]);
  }

  private share(): void {
    const params = new URLSearchParams({
      s: String(this.seed),
      l: String(this.levelIndex + 1),
      t: this.env.time.toFixed(3),
    });
    const f = this.folds.serialize();
    if (f) params.set('f', f);
    // Inside an embed (or a local file) the page's own address can't carry the dream, so link to the public build.
    const embedded = window.self !== window.top || !location.protocol.startsWith('http');
    const base = embedded ? PUBLIC_URL : `${location.origin}${location.pathname}`;
    const url = `${base}#${params.toString()}`;
    try {
      if (!embedded) history.replaceState(null, '', `#${params.toString()}`);
    } catch {
      // some sandboxed frames refuse history changes; the copied link is what matters
    }
    const done = () => this.toast('Dream link copied', 'Anyone who opens it gets this exact city, folded the same way.');
    const failed = () => this.toast('Copy this dream link', url);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, failed);
    else failed();
  }

  private renderFoldList(): void {
    const list = $('fold-list');
    list.innerHTML = '';
    const live = this.folds.live();
    $('fold-count').textContent = `${live.length} / ${MAX_FOLDS}`;
    live.forEach((f: Fold) => {
      const li = document.createElement('li');
      const dir = Math.abs(f.nx) > Math.abs(f.nz) ? (f.nx > 0 ? 'East' : 'West') : f.nz > 0 ? 'North' : 'South';
      const label = document.createElement('span');
      const deg = () => `${dir} ${Math.round((f.target * 180) / Math.PI)}°`;
      label.textContent = deg();
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '-180';
      range.max = '180';
      range.value = String(Math.round((f.target * 180) / Math.PI));
      range.setAttribute('aria-label', `Fold angle, ${dir}`);
      range.addEventListener('input', () => {
        f.target = (Number(range.value) * Math.PI) / 180;
        label.textContent = deg();
      });
      range.addEventListener('change', () => this.foldCommitted(Math.abs(f.target) / Math.PI));
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Unfold';
      x.addEventListener('click', () => this.folds.remove(f));
      li.append(label, range, x);
      list.append(li);
    });
  }

  // ---------------------------------------------------------------- quality

  private applyQuality(name: QualityName): void {
    this.quality = name;
    const q = QUALITY[name];
    const pr = Math.min(window.devicePixelRatio || 1, q.pr);
    this.renderer.setPixelRatio(pr);
    this.post.setSize(window.innerWidth, window.innerHeight, pr);
    this.post.bloom.enabled = q.bloom;
    this.env.mirrorScale = q.mirror;
    this.streamer.limit = q.chunks;
    const sun = this.env.sun;
    sun.castShadow = q.shadow > 0;
    if (q.shadow > 0 && sun.shadow.mapSize.x !== q.shadow) {
      sun.shadow.mapSize.set(q.shadow, q.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    this.lastQualityChange = this.time;
  }

  private adaptQuality(dt: number): void {
    this.frameAvg += (dt - this.frameAvg) * 0.05;
    this.qualityClock += dt;
    if (!this.autoQuality || this.qualityClock < 1 || this.time - this.lastQualityChange < 4) return;
    this.qualityClock = 0;
    const i = ORDER.indexOf(this.quality);
    if (this.frameAvg > 1 / 38 && i > 0) {
      this.lastDowngrade = this.time;
      this.applyQuality(ORDER[i - 1]);
    } else if (this.frameAvg < 1 / 57 && i < ORDER.indexOf('high') && this.time - this.lastDowngrade > 25) {
      this.applyQuality(ORDER[i + 1]);
    }
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- frame

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    // While the dream collapses it runs in slow motion (wdt); the dreamer and the cameras keep real time.
    if (this.collapse.update(dt)) this.kick('Stability hit zero');
    const slow = this.collapse.timeScale;
    const wdt = dt * slow;
    this.time += wdt;
    U.uTime.value = this.time;

    this.folds.update(wdt);
    U.uFoldCount.value = this.folds.count;
    if (this.folds.version !== this.foldsVersion) {
      this.foldsVersion = this.folds.version;
      this.renderFoldList();
    }

    this.hallway.update(dt, this.time, this.folds.active);

    if (!this.started) {
      const a = this.time * 0.05;
      this.camera.position.set(Math.sin(a) * 560, 280 + Math.sin(a * 0.7) * 40, Math.cos(a) * 560);
      this.camera.lookAt(0, 30, 0);
    } else if (this.mode === 'architect') {
      this.architect.update(dt);
      if (this.pendingPreset && !this.architect.flying) {
        this.applyPreset(this.pendingPreset);
        this.pendingPreset = null;
        setTimeout(() => this.hint('Your turn: drag across the city to fold it. Try a dreamscape, or press Tab to walk inside it.'), 3500);
      }
    } else {
      this.walk.update(dt);
      if (this.walk.locked) $('pause').hidden = true;
      if (this.instability > 0.6) {
        const s = (this.instability - 0.6) * 0.12 * slow;
        this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      }
    }

    const level = LEVELS[this.levelIndex];
    const q = QUALITY[this.quality];
    const focus = this.focus();
    const alt = this.mode === 'architect' ? Math.max(0, this.camera.position.y) : 0;
    const weather = level.weather === 'rain' || level.weather === 'snow';
    const view = (q.view + alt * 0.6) * (weather ? 0.8 : 1);
    this.env.fog.near = view * (weather ? 0.12 : 0.45);
    this.env.fog.far = view;
    this.streamer.update(this.camera.position, focus.x, focus.z, this.folds.active, this.folds.folds, view, q.props, this.time);

    // Dream stability.
    const floor = Math.min(0.45, this.folds.load * 0.09) + level.limbo * 0.12;
    this.instability = Math.max(floor, this.instability - wdt * 0.03);
    this.instability = Math.min(1, this.instability + this.folds.strain * wdt * 0.07);
    if (this.started && this.instability >= COLLAPSE_AT && !this.collapse.active) this.blowUp();
    // the dream stays at zero until the kick
    if (this.collapse.blasting) this.instability = 1;

    // inside the hallway the dreamer is out of the projections' reach
    const dreamer = this.mode === 'walk' && !this.hallway.rider ? focus : null;
    this.crowd.update(wdt, focus.x, focus.z, dreamer, this.instability, (x, z, r) => this.streamer.collide(x, z, r));

    const fw = new THREE.Vector3();
    if (this.mode === 'walk') fw.copy(this.camera.position);
    else fw.copy(this.architect.controls.target);
    this.env.update(dt, this.camera, fw, q.extent);
    const turning = this.hallway.rider ? Math.abs(this.hallway.spin) * 0.45 : 0;
    // slow motion drags the drone down with it
    this.audio.update(this.folds.motion + turning, level.drone * (0.6 + 0.4 * slow), this.instability);

    // Finishing.
    this.flash *= Math.exp(-dt * 2.5);
    const g = this.post.u;
    g.uTime.value = this.time;
    g.uAberration.value = Math.min(0.22, this.instability * 0.05 + this.folds.motion * 0.04);
    g.uFlash.value = this.flash;
    g.uTint.value.lerp(new THREE.Vector3(...level.tint), dt * 2);
    g.uSaturation.value += (level.saturation * (0.7 + 0.3 * slow) - g.uSaturation.value) * dt * 2;
    g.uContrast.value += (level.contrast - g.uContrast.value) * dt * 2;
    // At night hundreds of lit windows would wash the frame out, so only the brightest ones bloom.
    this.post.bloom.strength = 0.32 - this.env.night * 0.08;
    this.post.bloom.threshold = 0.9 + this.env.night * 0.5;

    this.realElapsed += dt;
    this.dreamElapsed += wdt * level.dilation;
    this.updateHud(dt);
    this.renderer.info.reset();
    this.post.render(dt);
    this.adaptQuality(dt);
  }

  private updateHud(dt: number): void {
    this.totem.draw(dt, this.instability, '#d9b26f');
    this.fpsFrames++;
    this.fpsTime += dt;
    this.statsClock += dt;
    if (this.statsClock < 0.25) return;
    this.statsClock = 0;
    if (this.fpsTime > 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    $('real-time').textContent = fmtDuration(this.realElapsed);
    $('dream-time').textContent = fmtDuration(this.dreamElapsed);
    const stab = 1 - this.instability;
    const bar = $('stability-bar');
    bar.style.width = `${Math.round(stab * 100)}%`;
    bar.style.background = stab > 0.6 ? 'var(--cold)' : stab > 0.3 ? 'var(--accent)' : 'var(--danger)';
    const w = this.crowd.watching;
    $('watchers').textContent = w > 0 ? `${w} watching you` : '';
    const info = this.renderer.info.render;
    $('stats').textContent =
      `${this.fps} fps · ${this.quality}${this.autoQuality ? ' (auto)' : ''}\n` +
      `${this.streamer.loaded.size} chunks · ${this.streamer.buildingCount.toLocaleString()} buildings\n` +
      `${info.calls} draw calls · ${Math.round(info.triangles / 1000).toLocaleString()}k triangles`;
  }
}
