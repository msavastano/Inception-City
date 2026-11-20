import * as THREE from 'three';
import { COLLAPSE_RADIUS, MAX_FOLDS } from './core/config';
import { Fold, FoldStack, foldPoint } from './core/fold';
import { totemGeometry } from './city/geometry';
import { loadSurfaceDetail } from './city/detail';
import { U, setSurfaceDetail, setWallRelief } from './city/materials';
import { CityStreamer } from './city/streamer';
import { DreamAudio, Heard } from './fx/audio';
import { CROWD_VOICES, CrowdVoice, crowdVoices, Footfall, footing, Scene, toEar } from './fx/soundscape';
import { greenAt, groundAt, shelterAt } from './city/surface';
import { LampHalos } from './fx/halos';
import { Picker } from './fx/picking';
import { PostFX, targetBytes } from './fx/post';
import { HeistEvent, HeistRun, Item, KickResult, LIMBO, LUCIDITY_WITH_TOTEM, LUCIDITY_WITHOUT, Outcome, SCAPES, SPAWN, Spot, TARGET_DEPTH, levelSeed } from './game/heist';
import { HeistMarks } from './game/marks';
import { ArchitectMode, Tool } from './modes/architect';
import { DreamContext } from './modes/context';
import { DreamWalk } from './modes/dreamwalk';
import { PRESETS, Preset } from './modes/presets';
import { Totem } from './ui/totem';
import { Collapse, planShards } from './world/collapse';
import { Environment } from './world/environment';
import { HALL_LENGTH, Hallway } from './world/hallway';
import { LOOK, TONE_CURVES, readLook } from './world/look';
import { guard } from './people/crowd';
import { Projections } from './world/projections';
import { LEVELS } from './world/themes';

type Mode = 'architect' | 'walk';
type QualityName = 'low' | 'medium' | 'high' | 'ultra';

const PUBLIC_URL = 'https://msavastano.github.io/Inception-City/';

// mirror: resolution of the wet-street reflection as a fraction of the screen (0 = lamp glints only)
// shards: pieces of wall the café explosion throws when stability hits zero
// relief: how far away (metres) the window reveals have faded out (0 = flat walls, as they were before the relief)
// detail: how far away (metres) the scanned surface detail has faded out (0 = none: the surfaces are painted only)
// trees: how far away (metres) a tree has finished turning from its near version (every branch and leaf card) to
//   its far one (trunk, limbs and a few big cards); 0 = far version only
// treeShadows: how far away (metres) trees still cast shadows (beyond, the ground paints their shade)
// kit: how far away (metres) the street life kit is drawn (src/city/kitField.ts): [small furniture (chairs, benches,
//   bollards, bins), the large pieces (kiosks, columns, metro entrances, fountains, parasols), parked cars (out to the
//   lamps), cars drawn in full nearer than this (the rest in their far version), shadows out to this]
const QUALITY: Record<QualityName, { pr: number; shadow: number; extent: number; bloom: boolean; view: number; props: number; chunks: number; crowd: number; mirror: number; shards: number; relief: number; detail: number; trees: number; treeShadows: number; kit: [number, number, number, number, number] }> = {
  ultra: { pr: 2, shadow: 4096, extent: 460, bloom: true, view: 1300, props: 650, chunks: 150, crowd: 900, mirror: 0.5, shards: 7000, relief: 64, detail: 56, trees: 100, treeShadows: 300, kit: [170, 420, 650, 90, 240] },
  high: { pr: 1.5, shadow: 2048, extent: 380, bloom: true, view: 1050, props: 480, chunks: 120, crowd: 600, mirror: 0.5, shards: 5000, relief: 48, detail: 46, trees: 80, treeShadows: 240, kit: [130, 340, 480, 75, 200] },
  medium: { pr: 1, shadow: 2048, extent: 320, bloom: true, view: 820, props: 360, chunks: 90, crowd: 400, mirror: 0.35, shards: 3200, relief: 38, detail: 36, trees: 60, treeShadows: 180, kit: [100, 260, 360, 60, 150] },
  low: { pr: 0.75, shadow: 0, extent: 260, bloom: false, view: 620, props: 240, chunks: 60, crowd: 180, mirror: 0, shards: 1600, relief: 0, detail: 0, trees: 0, treeShadows: 0, kit: [70, 200, 240, 45, 0] },
};
/** Instability at which the dream collapses (the HUD reads 0% stability). */
const COLLAPSE_AT = 0.995;
const ORDER: QualityName[] = ['low', 'medium', 'high', 'ultra'];
const MAX_CHUNKS = 150;
/** Heist mode: the target's guards, each level's share of the crowd, and how wary the crowd is down there. */
const GUARDS = 7;
const CROWD_AT_DEPTH = [0.5, 0.75, 1, 0.4];
const ALERT_AT_DEPTH = [0, 0.1, 0.2, 0.15];
/** Running past projections on Level 2 and below makes them suspicious. */
const RUN_ALERT = 0.35;
const RATE_LABEL = ['Topside runs at full speed', 'Topside runs at half speed', 'Topside runs at a quarter speed', 'Topside is stopped in Limbo'];
const HEIST_HINT = 'Follow the light · WASD walk · Shift run · K kick (once you have found one) · F fold ahead · E ride the fold · C camera · Esc pause';
const HEIST_TOUCH_HINT = 'Follow the light. Left thumb walks, right thumb looks. Kick once you have found one.';
/** Seconds to fade out (and back in) when the job moves between dreams. */
const FADE = 0.6;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** A direction relative to where you face, in words (angle in radians, 0 ahead, positive to the right). */
function bearing(a: number): string {
  const names = ['ahead', 'ahead, to the right', 'to your right', 'behind you, to the right', 'behind you', 'behind you, to the left', 'to your left', 'ahead, to the left'];
  const i = Math.round((((a / (Math.PI * 2)) * 8) % 8) + 8) % 8;
  return names[i];
}

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
  readonly halos: LampHalos;
  readonly architect: ArchitectMode;
  readonly walk: DreamWalk;
  readonly crowd: Projections;
  readonly hallway = new Hallway();
  /** Settles once the surface detail has loaded or failed (at once while no tier has asked for it). */
  detailReady: Promise<boolean> = Promise.resolve(false);
  /** Resolves once the trees' leaves have been drawn (just after the first frame). */
  get treesReady(): Promise<void> {
    return this.streamer.trees.ready;
  }
  readonly collapse = new Collapse(QUALITY.ultra.shards);
  readonly marks: HeistMarks;
  readonly guards: Projections;
  private totem: Totem;
  /** The job in progress (Heist mode), or null. */
  private run: HeistRun | null = null;
  private jobSeed: number;
  private transit: { t: number; hold: number; then: (() => void) | null } | null = null;
  private hurtFlash = 0;
  private lastNeedTotem = -100;
  /** When the current dream of the job appeared (its things grow in from then). */
  private dreamBorn = 0;
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
  // what the crowd sounds like from here (see crowdSound)
  private nearPeople = new Float32Array(160);
  private crowdGroups: CrowdVoice[] = [];
  private crowdHeard: Heard[] = Array.from({ length: CROWD_VOICES }, () => ({ x: 0, y: 0, z: 0, gain: 0 }));
  private ear = { x: 0, z: 0 };

  constructor() {
    const params = new URLSearchParams(location.hash.slice(1));
    this.seed = Number(params.get('s')) || Math.floor(Math.random() * 1e6);
    this.jobSeed = Number(params.get('job')) || Math.floor(Math.random() * 1e6);
    if (params.has('job')) {
      // a shared job: taking it is the main way in
      $('go-job').classList.add('primary');
      $('go-architect').classList.remove('primary');
    }
    const mobile = matchMedia('(pointer: coarse)').matches;
    const forced = params.get('q') as QualityName | null;
    this.quality = forced && forced in QUALITY ? forced : mobile ? 'medium' : 'high';
    if (forced) this.autoQuality = false;
    this.crowdCount = QUALITY[this.quality].crowd;
    if (mobile) document.body.classList.add('touch');

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    readLook(params);
    this.renderer.toneMapping = TONE_CURVES[LOOK.tone].mapping;
    this.renderer.toneMappingExposure = TONE_CURVES[LOOK.tone].exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.env = new Environment(this.scene, this.renderer);
    this.streamer = new CityStreamer(this.seed, MAX_CHUNKS);
    this.scene.add(this.streamer.group);
    this.halos = new LampHalos(this.streamer.lamps);
    this.scene.add(this.halos.mesh);
    this.picker = new Picker(this.renderer, this.streamer.pickGroup);

    // The folds' uniform arrays are shared with every folded material.
    U.uFoldA.value = this.folds.uA;
    U.uFoldB.value = this.folds.uB;

    this.scene.add(this.makeTotem());
    this.crowd = new Projections(this.streamer.personMaterial, this.streamer.personDepth, QUALITY.ultra.crowd);
    this.crowd.setCount(this.crowdCount, 0, 0);
    this.crowd.onCaught = (x, z) => {
      if (this.run) this.struck(x, z);
      else if (this.mode === 'walk') {
        this.kick('The projections found you');
        setTimeout(() => this.setMode('architect'), 700);
      }
    };
    this.scene.add(this.crowd.mesh);
    // the target's bodyguards: few, in navy, and they go for anyone who comes close
    this.guards = new Projections(this.streamer.personMaterial, this.streamer.personDepth, GUARDS, {
      spread: 5,
      leash: 110,
      respawnMin: 0,
      near: 14,
      far: 50,
      zeal: 1,
      outfit: guard,
    });
    this.guards.onCaught = (x, z) => this.struck(x, z);
    this.scene.add(this.guards.mesh);
    this.marks = new HeistMarks(this.streamer.propMaterial, this.streamer.propDepth, this.streamer.personMaterial, this.streamer.personDepth);
    this.scene.add(this.marks.group);
    this.scene.add(this.hallway.mesh);
    this.scene.add(this.collapse.mesh);

    this.post = new PostFX(this.renderer, this.scene, this.camera, mobile || this.quality === 'low' ? 0 : 4);
    this.architect = new ArchitectMode(this);
    this.walk = new DreamWalk(this);
    this.scene.add(this.walk.body.group);
    document.body.classList.toggle('third', this.walk.view === 'third');
    this.walk.onPause = () => {
      if (this.mode === 'walk' && !this.run?.outcome) $('pause').hidden = false;
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

  footing(x: number, z: number): Footfall {
    const level = LEVELS[this.levelIndex];
    // Limbo's sea has come in over the outer streets
    const sea = level.limbo * THREE.MathUtils.smoothstep(Math.hypot(x, z), 600, 680);
    return footing(groundAt(x, z, this.streamer.seed), level, sea);
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
    // in a job the blast hurts; the kick that follows is free (see heistCrash)
    if (this.run && !this.run.outcome) {
      this.run.blast();
      this.hurtFlash = 1;
    }
  }

  // ---------------------------------------------------------------- modes

  setMode(mode: Mode): void {
    // a job is walked from start to finish: leaving it goes through leaveJob()
    if (this.run && mode === 'architect') return;
    // `mode` starts out as 'architect' before either mode has been entered, so check the mode is actually live
    const entered = mode === 'walk' ? this.walk.active : this.architect.active;
    if (mode === this.mode && entered) return;
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

  /**
   * Test hook: take over the frame loop and advance the dream by hand in fixed steps (scripts/bench.mjs).
   * Only the last frame is drawn, so a software renderer can run hundreds of steps of streaming and physics.
   */
  step(frames = 1, dt = 0.05, draw = true): void {
    this.renderer.setAnimationLoop(null);
    for (let i = 0; i < frames; i++) this.frame(dt, draw && i === frames - 1);
  }

  /** Test hook: what the last drawn frame cost. Texture memory is an estimate from the render targets' sizes. */
  stats(): { quality: string; calls: number; triangles: number; textures: number; geometries: number; programs: number; targetMB: number } {
    const info = this.renderer.info;
    const targets = [...this.post.targets(), ...this.env.targets()];
    return {
      quality: this.quality,
      calls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
      targetMB: Math.round((targets.reduce((sum, t) => sum + targetBytes(t), 0) / 1048576) * 10) / 10,
    };
  }

  focus(): { x: number; z: number } {
    return this.mode === 'walk' ? { x: this.walk.x, z: this.walk.z } : this.architect.focus();
  }

  // ---------------------------------------------------------------- heist

  /** Take a job: Level 1 of a city made from its seed, already folded. Called from a click (pointer lock). */
  private startJob(seed: number): void {
    for (const id of ['intro', 'job-brief', 'job-end', 'pause']) $(id).hidden = true;
    document.body.classList.remove('intro', 'has-totem');
    document.body.classList.add('heist');
    this.audio.start();
    this.started = true;
    this.pendingPreset = null;
    this.jobSeed = seed;
    this.run = new HeistRun(seed);
    this.transit = null;
    this.post.u.uDim.value = 0;
    const first = this.mode !== 'walk';
    this.setMode('walk');
    // entering walk mode asks for the pointer itself; a second job from the end card has to ask again
    if (!first) this.walk.lock();
    // the first time in, swoop down from wherever the camera was
    this.loadDream(0, SPAWN, first);
    $('wake').textContent = 'Abandon the job';
    this.hint(document.body.classList.contains('touch') ? HEIST_TOUCH_HINT : HEIST_HINT);
    this.toast('The job', 'Find your totem, then a sleep machine. Follow the light.');
  }

  /** Build one level of the job around the dreamer: its own city, its dreamscape, its things, its crowd. */
  private loadDream(depth: number, at: Spot, swoop = false): void {
    const run = this.run!;
    this.collapse.stop();
    if (this.hallway.open) this.walk.collapseHallway();
    this.folds.reset();
    this.streamer.resetAll(levelSeed(run.seed, depth));
    this.setLevel(depth);
    this.env.applyInstant();
    const scape = PRESETS.find((p) => p.id === SCAPES[depth]);
    for (const f of scape?.folds ?? []) {
      // already folded when you arrive: no animation, so no strain on the dream
      const fold = this.folds.add(f.hx, f.hz, f.nx, f.nz, f.angle, f.radius, 2.4);
      fold.angle = fold.target;
    }
    this.folds.update(0);
    this.instability = 0;
    run.place(depth, (x, z) => {
      // (clear of the street life kit too, whether or not its models have loaded yet, so a job is laid out the same every time)
      const c = this.streamer.collide(x, z, 1, true);
      return Math.hypot(c.x - x, c.z - z) < 1e-3;
    });
    this.dreamBorn = this.time;
    this.marks.show(run.here, run.planted, this.dreamBorn);
    this.crowd.setCount(Math.round(this.crowdCount * CROWD_AT_DEPTH[depth]), at.x, at.z);
    this.crowd.scatter(at.x, at.z, 40);
    const target = depth === TARGET_DEPTH ? run.target : undefined;
    this.guards.setCount(target ? GUARDS : 0, target?.x ?? 0, target?.z ?? 0);
    if (target) this.guards.scatter(target.x, target.z, 8);
    this.walk.teleport(at.x, at.z, at.yaw, swoop);
  }

  /** Fade to black, change dreams in the dark, fade back in. */
  private fadeThrough(then: () => void, hold = 0.5): void {
    this.transit = { t: 0, hold, then };
  }

  /** K (or the touch Kick button): the city's kick, or in a job, this level's kick if you carry it. */
  private pressKick(): void {
    const run = this.run;
    if (!run) {
      this.kick();
      return;
    }
    if (run.outcome || this.transit) return;
    // K during the café explosion brings its kick forward, as it does outside a job
    if (this.collapse.blasting) this.heistCrash();
    else this.applyKick(run.kick());
  }

  /** The kick at the end of the café explosion: free, unless the blast killed you. */
  private heistCrash(): void {
    if (!this.run || this.transit) return;
    if (this.run.outcome) this.collapse.release();
    else this.applyKick(this.run.crash());
  }

  private applyKick(r: KickResult): void {
    const run = this.run!;
    switch (r.type) {
      case 'none':
        if (!run.outcome) this.toast('No kick', run.depth === LIMBO ? 'Find the way out first.' : "You haven't found this level's kick. Listen for the music.");
        break;
      case 'confirm':
        this.toast('Wake up now?', 'The idea is not planted. Press K again to wake up and give up the job.');
        break;
      case 'up':
        this.kickFx();
        this.fadeThrough(() => {
          this.loadDream(r.depth, r.at);
          this.toast(LEVELS[r.depth].name, r.fromLimbo ? 'Back from Limbo, badly hurt. Heal before you push on.' : 'You wake beside the machine you went under at.');
        });
        break;
      case 'limbo':
        this.kickFx();
        this.fadeThrough(() => this.enterLimbo(r.at), 1.2);
        break;
      case 'wake':
        this.kickFx();
        this.fadeThrough(() => this.endJob(r.outcome), 0.6);
        break;
    }
  }

  private kickFx(): void {
    this.collapse.release();
    this.audio.kick();
    const f = this.focus();
    U.uRipple.value.set(f.x, f.z, this.time, 7);
    this.flash = 0.85;
    this.crowd.calm();
    this.guards.calm();
  }

  private enterLimbo(at: Spot): void {
    const run = this.run!;
    this.loadDream(LIMBO, at);
    this.toast(
      'Limbo',
      run.hasTotem ? 'You died in the dream. Find the way out. Your totem will keep you lucid for a while.' : 'You died in the dream. Without your totem you will not stay lucid for long.',
    );
  }

  /** A projection reached the dreamer. */
  private struck(x: number, z: number): void {
    const run = this.run;
    if (!run || run.outcome || this.transit || this.mode !== 'walk') return;
    const r = run.hit();
    if (r === 'none') return;
    this.audio.hurt();
    this.walk.shove(x, z);
    this.walk.body.play('hit');
    this.hurtFlash = 1;
    if (r === 'dead') {
      this.flash = 0.6;
      this.fadeThrough(() => this.enterLimbo(run.fall()), 1.2);
    }
  }

  private onHeistEvent(e: HeistEvent): void {
    const run = this.run!;
    switch (e.type) {
      case 'pickup': {
        this.audio.chime();
        this.walk.body.play('pick');
        this.marks.show(run.here, run.planted, this.dreamBorn);
        if (e.item.kind === 'totem') {
          document.body.classList.add('has-totem');
          this.toast('Your totem', 'Now you can tell how stable the dream is, and you can go deeper than Level 2.');
        } else if (run.depth === LIMBO) {
          this.toast('The way out', `Press K to wake into ${LEVELS[run.fellFrom].name}.`);
        } else {
          this.toast('A kick', `It will wake you from ${LEVELS[run.depth].name} whenever you press K here.`);
        }
        break;
      }
      case 'under':
        this.audio.under();
        this.flash = Math.max(this.flash, 0.2);
        this.fadeThrough(() => {
          const at = run.goUnder();
          this.loadDream(run.depth, at);
          this.toast(LEVELS[run.depth].name, run.depth === TARGET_DEPTH ? 'Topside runs at a quarter speed. The target is here.' : 'Topside runs at half speed here.');
        }, 0.9);
        break;
      case 'needTotem':
        if (this.time - this.lastNeedTotem > 4) {
          this.lastNeedTotem = this.time;
          this.toast('Not without your totem', 'Never go this deep without it. It is up on Level 1.');
        }
        break;
      case 'planted':
        this.audio.braam(1);
        this.flash = Math.max(this.flash, 0.35);
        this.guards.calm();
        this.marks.show(run.here, run.planted, this.dreamBorn);
        this.toast('Inception', 'The idea has taken root. Now ride the kicks home.');
        break;
      case 'over':
        this.endJob(e.outcome);
        break;
    }
  }

  /** The end card. */
  private endJob(outcome: Outcome): void {
    const run = this.run!;
    if (document.pointerLockElement) document.exitPointerLock();
    $('pause').hidden = true;
    $('toast').classList.remove('show');
    const card: Record<Outcome, [string, string, string]> = {
      won: ['Job done', 'Inception', `You planted the idea and woke up with ${fmtDuration(run.topside)} of topside time to spare.`],
      time: ['Job failed', 'The plane landed', 'The topside clock ran out while you were still under.'],
      woke: ['Job failed', 'You woke too soon', 'The idea was never planted.'],
      lost: ['Job failed', 'Lost in Limbo', 'You forgot you were dreaming.'],
      abandoned: ['Job abandoned', 'You walked away', ''],
    };
    const [kicker, title, sub] = card[outcome];
    $('job-end-kicker').textContent = kicker;
    $('job-end-title').textContent = title;
    $('job-end-sub').textContent = sub;
    const stats: [string, string][] = [
      ['Topside left', fmtDuration(run.topside)],
      ['Time under', fmtDuration(run.played)],
      ['Idea', run.planted ? 'Planted' : 'Not planted'],
    ];
    if (outcome === 'won') {
      const key = `inception-job-${run.seed}`;
      let best = 0;
      try {
        best = Number(localStorage.getItem(key)) || 0;
        if (run.topside > best) localStorage.setItem(key, String(run.topside));
      } catch {
        // no storage (private window): no record kept
      }
      stats.push(['Best for this job', fmtDuration(Math.max(best, run.topside)) + (run.topside > best ? ' (new)' : '')]);
    }
    const dl = $('job-stats');
    dl.innerHTML = '';
    for (const [k, v] of stats) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    $('job-end').hidden = false;
  }

  /** Leave the job (from the end card or the pause menu) and go back to the architect's city. */
  private leaveJob(): void {
    this.run?.abandon();
    this.run = null;
    this.transit = null;
    for (const id of ['job-end', 'pause']) $(id).hidden = true;
    document.body.classList.remove('heist', 'has-totem');
    $('wake').textContent = 'Wake up (Q)';
    $('objective').textContent = '';
    this.post.u.uDim.value = 0;
    this.post.u.uHurt.value = 0;
    this.hurtFlash = 0;
    this.walk.canSprint = true;
    this.audio.beacons(null, null);
    this.marks.clear();
    this.guards.setCount(0, 0, 0);
    this.collapse.stop();
    if (this.hallway.open) this.walk.collapseHallway();
    this.folds.reset();
    this.streamer.resetAll(this.seed);
    this.setLevel(0);
    this.env.applyInstant();
    this.instability = 0;
    this.crowd.setCount(this.crowdCount, this.walk.x, this.walk.z);
    this.crowd.scatter(this.walk.x, this.walk.z, 40);
    this.setMode('architect');
  }

  private shareJob(): void {
    const seed = this.run?.seed ?? this.jobSeed;
    this.copyLink(new URLSearchParams({ job: String(seed) }), 'Job link copied', 'Anyone who opens it can run this exact job.', 'Copy this job link');
  }

  /** Every frame of a job: the run's clock and events, the beacons' sound, the hurt picture. */
  private updateHeist(dt: number): void {
    const run = this.run;
    if (!run) return;
    if (!this.heistPaused && !this.transit) {
      const hunted = this.crowd.hunting + this.guards.hunting > 0;
      for (const e of run.update(dt, this.walk.x, this.walk.z, hunted)) this.onHeistEvent(e);
    }
    this.walk.canSprint = !run.limping;

    // where the kick and the machine are, as sound
    const beacon = (kind: 'kick' | 'machine') => {
      const it = run.here.find((i) => i.kind === kind && !i.taken);
      if (!it || run.outcome) return null;
      const dx = it.x - this.walk.x;
      const dz = it.z - this.walk.z;
      const e = toEar(dx, dz, this.walk.yaw, this.ear);
      return { dist: Math.hypot(dx, dz), x: e.x, z: e.z };
    };
    this.audio.beacons(beacon('kick'), beacon('machine'));

    let hurt: number;
    if (run.depth === LIMBO) hurt = 1 - Math.min(1, run.lucidity / 30);
    else hurt = 1 - Math.min(1, run.health / 0.5);
    if (run.outcome) hurt = 0;
    this.audio.heartbeat(hurt);
    this.hurtFlash *= Math.exp(-dt * 2.2);
    this.post.u.uHurt.value = Math.max(this.hurtFlash * 0.9, hurt * 0.55);
  }

  /** While a job holds still: paused, or over. (Changing dreams only stops its clock.) */
  private get heistPaused(): boolean {
    const run = this.run;
    return !!run && (!!run.outcome || !$('pause').hidden);
  }

  private updateJobHud(): void {
    const run = this.run!;
    $('job-topside').textContent = fmtDuration(run.topside);
    $('job-topside').parentElement!.classList.toggle('low', run.topside < 60);
    $('job-rate').textContent = RATE_LABEL[run.depth];
    Array.from($('job-depth').children).forEach((el, i) => el.classList.toggle('on', i === run.depth));
    const limbo = run.depth === LIMBO;
    $('job-meter-k').textContent = limbo ? 'Lucidity' : 'Health';
    const v = limbo ? run.lucidity / (run.hasTotem ? LUCIDITY_WITH_TOTEM : LUCIDITY_WITHOUT) : run.health;
    const bar = $('job-meter');
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
    bar.style.background = v > 0.6 ? 'var(--cold)' : v > 0.3 ? 'var(--accent)' : 'var(--danger)';
    for (const el of $('job-carry').querySelectorAll<HTMLElement>('span')) {
      const c = el.dataset.c!;
      const have = c === 'totem' ? run.hasTotem : c === 'idea' ? run.planted : run.kicks.has(Number(c.slice(1)));
      el.classList.toggle('have', have);
      if (c === 'k3') el.hidden = !limbo;
    }
    // the main thing you're after gets a distance and a direction (kicks you find by ear)
    const want = this.objectiveItem();
    let where = '';
    if (want) {
      const dx = want.x - this.walk.x;
      const dz = want.z - this.walk.z;
      const ahead = dx * Math.sin(this.walk.yaw) + dz * Math.cos(this.walk.yaw);
      const right = -dx * Math.cos(this.walk.yaw) + dz * Math.sin(this.walk.yaw);
      where = ` · ${Math.round(Math.hypot(dx, dz) / 10) * 10} m ${bearing(Math.atan2(right, ahead))}`;
    }
    $('objective').textContent = run.objective() + where;
  }

  /** What the objective line is pointing you at, if it's something to walk to (not a kick: those you listen for). */
  private objectiveItem(): Item | undefined {
    const run = this.run!;
    if (run.outcome || run.planted) return undefined;
    const find = (kind: Item['kind']) => run.here.find((i) => i.kind === kind && !i.taken);
    if (run.depth === LIMBO) return undefined;
    if (run.depth === TARGET_DEPTH) return find('target');
    if (run.depth === 0 && !run.hasTotem) return find('totem');
    if (run.depth === 1 && !run.hasTotem) return undefined;
    return find('machine');
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
    $('go-job').addEventListener('click', () => {
      $('intro').hidden = true;
      $('job-brief').hidden = false;
    });
    // the desk can take a job too, once you're already in the city
    $('panel-job').addEventListener('click', () => ($('job-brief').hidden = false));
    $('job-back').addEventListener('click', () => {
      $('job-brief').hidden = true;
      if (!this.started) $('intro').hidden = false;
    });
    $('job-go').addEventListener('click', () => this.startJob(this.jobSeed));
    $('job-again').addEventListener('click', () => this.startJob(this.run?.seed ?? this.jobSeed));
    $('job-new').addEventListener('click', () => this.startJob(Math.floor(Math.random() * 1e6)));
    $('job-share').addEventListener('click', () => this.shareJob());
    $('job-leave').addEventListener('click', () => this.leaveJob());
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
    $('wake').addEventListener('click', () => (this.run ? this.leaveJob() : this.setMode('architect')));
    for (const b of document.querySelectorAll<HTMLButtonElement>('#touch-ui button')) {
      b.addEventListener('click', () => {
        const a = b.dataset.touch;
        if (a === 'jump') this.walk.jump();
        if (a === 'fold') this.walk.foldAhead(true);
        if (a === 'ride') this.walk.ride();
        if (a === 'hall') this.walk.toggleHallway();
        if (a === 'kick') this.pressKick();
        if (a === 'view') this.toggleView();
        if (a === 'wake') this.setMode('architect');
      });
    }

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || !this.started) return;
      switch (e.code) {
        case 'Tab':
          e.preventDefault();
          if (!this.run) this.setMode(this.mode === 'walk' ? 'architect' : 'walk');
          break;
        case 'KeyK':
          this.pressKick();
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4':
          if (!this.run) this.setLevel(Number(e.code.slice(5)) - 1);
          break;
        case 'KeyM':
          $('mute').click();
          break;
        case 'KeyZ':
          // in a job the dreamscape's folds are part of the level, not yours to undo
          if (!this.run) this.undo();
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
        case 'KeyC':
          if (this.mode === 'walk') this.toggleView();
          break;
        case 'KeyH':
          if (this.mode === 'walk') this.walk.toggleHallway();
          else if (this.hallway.open) this.hallway.dismiss();
          else this.applyPreset(PRESETS.find((p) => p.hallway) ?? PRESETS[0]);
          break;
      }
    });
  }

  /** C (or the touch View button): first person, or the camera behind the dreamer. */
  private toggleView(): void {
    const third = this.walk.toggleView() === 'third';
    document.body.classList.toggle('third', third);
    const how = document.body.classList.contains('touch') ? 'Tap View' : 'Press C';
    this.toast(third ? 'Behind the dreamer' : 'First person', `${how} to switch back.`);
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
    this.copyLink(params, 'Dream link copied', 'Anyone who opens it gets this exact city, folded the same way.', 'Copy this dream link');
  }

  /** Put a link to this page with the given hash on the clipboard (or show it, if that fails). */
  private copyLink(params: URLSearchParams, done: string, doneSub: string, failed: string): void {
    // Inside an embed (or a local file) the page's own address can't carry the dream, so link to the public build.
    const embedded = window.self !== window.top || !location.protocol.startsWith('http');
    const base = embedded ? PUBLIC_URL : `${location.origin}${location.pathname}`;
    const url = `${base}#${params.toString()}`;
    try {
      if (!embedded) history.replaceState(null, '', `#${params.toString()}`);
    } catch {
      // some sandboxed frames refuse history changes; the copied link is what matters
    }
    const ok = () => this.toast(done, doneSub);
    const no = () => this.toast(failed, url);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok, no);
    else no();
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
    // Low (and #relief=0) compile the relief out of the building shader altogether
    setWallRelief(q.relief > 0 && LOOK.relief > 0);
    U.uRelief.value.set(Math.min(LOOK.relief, 2), Math.min(LOOK.relief, 1.5), q.relief * 0.7, q.relief);
    // the scanned grain of the surfaces close to: off on Low (and with #detail=0), fetched the first time a tier wants it
    const detail = q.detail > 0 && LOOK.detail > 0;
    setSurfaceDetail(detail);
    U.uDetail.value.set(Math.min(LOOK.detail, 2.5), Math.min(LOOK.detail, 1.5), q.detail * 0.6, q.detail);
    if (detail) this.detailReady = loadSurfaceDetail(Math.min(4, this.renderer.capabilities.getMaxAnisotropy()));
    this.streamer.limit = q.chunks;
    this.streamer.trees.nearDist = q.trees * LOOK.trees;
    this.streamer.trees.shadowDist = q.treeShadows;
    const kit = this.streamer.kit;
    [kit.reach.small, kit.reach.large, kit.reach.car, kit.carNear, kit.shadowDist] = q.kit.map((d, i) => (i < 3 ? d * LOOK.kit : d));
    kit.changed();
    // the modelled hallway on every tier but Low, which keeps the painted box (and its cost)
    this.hallway.useModel(name !== 'low' && LOOK.hall > 0);
    this.audio.setSpatial(name !== 'low');
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

  private frame(step?: number, draw = true): void {
    this.timer.update();
    const dt = step ?? Math.min(this.timer.getDelta(), 0.05);
    this.renderer.info.reset();
    // While the dream collapses it runs in slow motion (wdt); the dreamer and the cameras keep real time.
    if (this.collapse.update(dt)) {
      if (this.run) this.heistCrash();
      else this.kick('Stability hit zero');
    }
    if (this.transit) {
      const tr = this.transit;
      tr.t += dt;
      if (tr.then && tr.t >= FADE) {
        const then = tr.then;
        tr.then = null;
        then();
      }
      this.post.u.uDim.value = tr.t < FADE ? tr.t / FADE : Math.max(0, 1 - (tr.t - FADE - tr.hold) / FADE);
      if (tr.t >= FADE * 2 + tr.hold) {
        this.transit = null;
        this.post.u.uDim.value = 0;
      }
    }
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
    this.hallway.outdoor.copy(this.env.hemi.color).multiplyScalar(this.env.hemi.intensity);

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
    // the haze thickens with distance on its own; this is only the last stretch, where the streamed city's edge dissolves
    this.env.fog.near = view * 0.66;
    this.env.fog.far = view * 0.97;
    this.streamer.update(this.camera.position, focus.x, focus.z, this.folds.active, this.folds.folds, view, q.props, this.time);
    this.streamer.updateTrees(this.camera.position, this.folds.active);
    this.halos.update(this.env.night * LOOK.glow, (level.haze + level.mist) * LOOK.haze, this.env.fog.near, this.env.fog.far);

    // Dream stability.
    const floor = Math.min(0.45, this.folds.load * 0.09) + level.limbo * 0.12;
    this.instability = Math.max(floor, this.instability - wdt * 0.03);
    this.instability = Math.min(1, this.instability + this.folds.strain * wdt * 0.07);
    if (this.started && this.instability >= COLLAPSE_AT && !this.collapse.active) this.blowUp();
    // the dream stays at zero until the kick
    if (this.collapse.blasting) this.instability = 1;

    // inside the hallway the dreamer is out of the projections' reach
    const dreamer = this.mode === 'walk' && !this.hallway.rider ? focus : null;
    const collide = (x: number, z: number, r: number) => this.streamer.collide(x, z, r);
    const run = this.run;
    if (!run) {
      this.crowd.update(wdt, focus.x, focus.z, dreamer, this.instability, collide);
    } else if (!this.heistPaused) {
      // deeper dreams are warier, and from Level 2 down running past people gets you noticed
      const running = run.depth >= 1 && Math.hypot(this.walk.vx, this.walk.vz) > 8;
      this.crowd.update(wdt, focus.x, focus.z, dreamer, this.instability, collide, ALERT_AT_DEPTH[run.depth] + (running ? RUN_ALERT : 0));
      const target = run.depth === TARGET_DEPTH ? run.target : undefined;
      if (target) this.guards.update(wdt, target.x, target.z, dreamer, this.instability, collide, run.planted ? 0 : 1);
      this.marks.update(this.time);
    }
    this.updateHeist(dt);
    this.crowdSound();

    const fw = new THREE.Vector3();
    if (this.mode === 'walk') fw.copy(this.camera.position);
    else fw.copy(this.architect.controls.target);
    this.env.update(dt, this.camera, fw, q.extent, draw);
    const turning = this.hallway.rider ? Math.abs(this.hallway.spin) * 0.45 : 0;
    // slow motion drags the drone down with it
    this.audio.update(this.folds.motion + turning, level.drone * (0.6 + 0.4 * slow), this.instability, this.soundScene(slow), dt);

    // Finishing.
    this.flash *= Math.exp(-dt * 2.5);
    const g = this.post.u;
    g.uTime.value = this.time;
    g.uAberration.value = Math.min(0.22, this.instability * 0.05 + this.folds.motion * 0.04);
    g.uFlash.value = this.flash;
    const tone = TONE_CURVES[LOOK.tone];
    this.renderer.toneMappingExposure = tone.exposure * this.env.exposure * LOOK.exposure;
    g.uTint.value.lerp(new THREE.Vector3(...level.tint), dt * 2);
    g.uSaturation.value += (level.saturation * tone.saturation * LOOK.saturation * (0.7 + 0.3 * slow) - g.uSaturation.value) * dt * 2;
    g.uContrast.value += (level.contrast * tone.contrast * LOOK.contrast - g.uContrast.value) * dt * 2;
    // At night hundreds of lit windows would wash the frame out, so only the brightest ones bloom.
    this.post.bloom.strength = 0.32 - this.env.night * 0.08;
    this.post.bloom.threshold = 0.9 + this.env.night * 0.5;

    this.realElapsed += dt;
    this.dreamElapsed += wdt * level.dilation;
    this.updateHud(dt);
    if (draw) this.post.render(dt);
    if (step === undefined) this.adaptQuality(dt);
  }

  /** Where the listener is, for the sound beds: on the street as the dreamer, or up at the Architect's camera. */
  private soundScene(slow: number): Scene {
    const level = LEVELS[this.levelIndex];
    const walking = this.mode === 'walk';
    const f = this.focus();
    const seed = this.streamer.seed;
    const rider = walking && !!this.hallway.rider;
    return {
      rain: level.weather === 'rain' ? 1 : 0,
      snow: level.snow,
      limbo: level.limbo,
      night: this.env.night,
      walking,
      altitude: Math.max(0, this.camera.position.y),
      hall: rider,
      cover: walking && !rider ? shelterAt(f.x, f.z, seed) : 0,
      green: greenAt(f.x, f.z, seed),
      shore: THREE.MathUtils.smoothstep(Math.hypot(f.x, f.z), 240, 640),
      slow,
      // nothing but the drone before the dream has been entered
      dim: this.started ? this.post.u.uDim.value : 1,
    };
  }

  /**
   * The crowd as sound: its murmur, gathered into a few groups placed around the listener,
   * and the footsteps of whoever walks close by. The murmur dies as people stop to stare,
   * and comes back as an uproar when they give chase.
   */
  private crowdSound(): void {
    const walking = this.mode === 'walk';
    const f = this.focus();
    const rider = walking && !!this.hallway.rider;
    // the listener: the dreamer, or the Architect's camera looking down on the crowd around the focus
    const cam = this.camera.position;
    const lx = walking ? f.x : cam.x;
    const lz = walking ? f.z : cam.z;
    const up = walking ? 0 : Math.max(0, cam.y);
    let yaw = this.walk.yaw;
    if (!walking) {
      const d = this.camera.getWorldDirection(new THREE.Vector3());
      yaw = Math.atan2(d.x, d.z);
    }
    const n = this.crowd.nearest(this.nearPeople);
    crowdVoices(this.nearPeople, n, f.x, f.z, this.crowdGroups);
    for (let k = 0; k < CROWD_VOICES; k++) {
      const g = this.crowdGroups[k];
      const e = toEar(g.x + f.x - lx, g.z + f.z - lz, yaw, this.ear);
      const h = this.crowdHeard[k];
      h.x = e.x;
      h.y = -up;
      h.z = e.z;
      h.gain = g.gain;
    }
    const level = LEVELS[this.levelIndex];
    const far = Math.hypot(f.x - lx, f.z - lz, up);
    let reach = Math.exp(-far / 140) * (1 - 0.5 * level.limbo) * (1 - 0.3 * level.snow);
    if (!this.started || this.heistPaused) reach = 0;
    reach *= 1 - this.post.u.uDim.value;
    const hush = walking ? Math.min(1, this.crowd.watching / 10) : 0;
    const uproar = Math.min(1, (this.crowd.hunting + this.guards.hunting) / 4);
    this.audio.crowd(this.crowdHeard, reach, hush * (1 - uproar), uproar, rider);

    for (const crowd of [this.crowd, this.guards]) {
      const steps = crowd.footfalls;
      if (walking && !rider && reach > 0) {
        for (let i = 0; i < steps.length; i += 2) {
          const e = toEar(steps[i] - lx, steps[i + 1] - lz, yaw, this.ear);
          // their feet are a head's height below the ears
          this.audio.crowdStep(e.x, -1.6, e.z, this.footing(steps[i], steps[i + 1]));
        }
      }
      steps.length = 0;
    }
  }

  private updateHud(dt: number): void {
    this.totem.draw(dt, this.instability, '#d9b26f');
    this.fpsFrames++;
    this.fpsTime += dt;
    this.statsClock += dt;
    if (this.statsClock < 0.25) return;
    this.statsClock = 0;
    if (this.run) this.updateJobHud();
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
