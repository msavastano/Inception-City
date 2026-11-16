import { SoundBank } from './soundbank';
import { BED_NAMES, BedMix, BedName, bedRate, CROWD_VOICES, Footfall, mixBeds, Scene, StepSet } from './soundscape';

/**
 * Sound. Two kinds, layered:
 *  - made here from oscillators and noise: the drone tuned per dream level, the
 *    stone-on-stone rumble while the city folds, the brass "BRAAAM" when a fold
 *    lands, the kick, the wind;
 *  - recorded (CC0, see ASSETS.md): a bed for each level and for the hallway,
 *    footsteps for each surface, the crowd's murmur.
 * What should be heard where is decided in soundscape.ts; this file plays it.
 * The crowd, the heist's kick and its sleep machine are placed around the
 * listener's head (HRTF), so they can be found by ear.
 */

/** How loud each bed is when fully present (the recordings all sit at about the same level). */
const BED_LEVEL: Record<BedName, number> = { city: 1.45, birds: 0.6, rain: 0.8, cover: 0.75, sea: 0.85, room: 0.55, wind: 0.7 };
/** Footsteps, by set: how loud, and how much goes to the reverb (snow and carpet swallow sound). */
const STEP_LEVEL: Record<StepSet, number> = { stone: 0.5, gravel: 0.42, grass: 0.5, snow: 0.5, wet: 0.36, water: 0.42, carpet: 0.6, wood: 0.5 };
const STEP_ECHO: Record<StepSet, number> = { stone: 0.22, gravel: 0.12, grass: 0.06, snow: 0.03, wet: 0.2, water: 0.18, carpet: 0.02, wood: 0.1 };
/** With no recordings, a footstep is a burst of noise around this pitch (Hz). */
const STEP_HZ: Record<StepSet, number> = { stone: 750, gravel: 1700, grass: 420, snow: 520, wet: 1500, water: 2200, carpet: 260, wood: 330 };
const MURMUR_LEVEL = 0.9;
/** Each murmuring group plays the loop at its own speed, so no two sound alike. */
const MURMUR_RATES = [0.93, 1.0, 1.08];
/** Panners that carry other people's footsteps. */
const STEP_PANNERS = 3;
const PLAIN_STEP: Footfall = { set: 'stone', gain: 1 };

/** A sound somewhere around the listener: x to the right, y up, z behind (metres). */
export interface Heard {
  x: number;
  y: number;
  z: number;
  gain: number;
}

/** One looping layer: two copies of a mono recording half a loop apart, left and right, so it fills the room. */
class Bed {
  private filter: BiquadFilterNode;
  private out: GainNode;
  private sources: AudioBufferSourceNode[] = [];
  /** Seconds it has been silent while still playing. */
  quiet = 0;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    private level: number,
  ) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 16000;
    this.filter.Q.value = 0.4;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.filter.connect(this.out).connect(dest);
  }

  /** Where sources plug in. */
  get input(): AudioNode {
    return this.filter;
  }

  get playing(): boolean {
    return this.sources.length > 0;
  }

  play(buffer: AudioBuffer, rate: number): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(0, t);
    for (const side of [-1, 1]) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = rate;
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = side * 0.75;
      src.connect(pan).connect(this.filter);
      src.start(t, side > 0 ? buffer.duration / 2 : 0);
      this.sources.push(src);
    }
  }

  stop(): void {
    for (const s of this.sources) {
      s.stop();
      s.disconnect();
    }
    this.sources.length = 0;
    this.quiet = 0;
  }

  set(mix: BedMix, rate: number): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(mix.gain * this.level, t, 0.5);
    this.filter.frequency.setTargetAtTime(Math.min(mix.cutoff, this.ctx.sampleRate * 0.45), t, 0.25);
    for (const s of this.sources) s.playbackRate.setTargetAtTime(rate, t, 0.25);
  }
}

export class DreamAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private comp!: DynamicsCompressorNode;
  private reverb!: ConvolverNode;
  private wet!: GainNode;
  private droneOsc: OscillatorNode[] = [];
  private droneFilter!: BiquadFilterNode;
  private droneGain!: GainNode;
  private rumbleGain!: GainNode;
  private rumbleFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  muted = false;
  private lastBraam = 0;
  // Heist mode: a music box at the kick, a hum at the sleep machine, a heartbeat when hurt
  private boxGain: GainNode | null = null;
  private boxPan!: PannerNode;
  private boxFilter!: BiquadFilterNode;
  private humGain!: GainNode;
  private humPan!: PannerNode;
  private nextBeat = 0;
  // recordings: beds, footsteps, the crowd
  private bank: SoundBank | null = null;
  private beds = new Map<BedName, Bed>();
  private lastStep: Partial<Record<StepSet, number>> = {};
  private foot = 0;
  private footPans: StereoPannerNode[] = [];
  private murmurs: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; pan: PannerNode }[] | null = null;
  private stepPans: PannerNode[] = [];
  private nextPan = 0;
  private rate = 1;
  /** Place sounds with head-related filters (true) or plain left-right panning (cheaper). */
  private hrtf = true;

  get ready(): boolean {
    return !!this.ctx;
  }

  /** The context and the last node before the speakers, for recording what the game sounds like (scripts/listen.mjs). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  get output(): AudioNode | null {
    return this.ctx ? this.comp : null;
  }

  /** True once the footsteps have loaded: the recordings can be decoded here. */
  get recorded(): boolean {
    return !!this.bank?.steps;
  }

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.comp = comp;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.45;
    this.reverb.connect(this.wet).connect(this.master);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // drone
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 240;
    this.droneFilter.Q.value = 3;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneGain.gain.linearRampToValueAtTime(0.09, ctx.currentTime + 4);
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.master);
    this.droneGain.connect(this.reverb);
    for (const [type, mul, det] of [
      ['sawtooth', 1, -6],
      ['sawtooth', 1, 7],
      ['triangle', 2, 0],
      ['sine', 0.5, 0],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 55 * mul;
      o.detune.value = det;
      o.connect(this.droneFilter);
      o.start();
      this.droneOsc.push(o);
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(this.droneFilter.frequency);
    lfo.start();

    // fold rumble: filtered noise whose level follows fold speed
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 140;
    this.rumbleFilter.Q.value = 6;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    src.connect(this.rumbleFilter).connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);
    this.rumbleGain.connect(this.reverb);
    src.start();

    this.bank = new SoundBank(ctx);
    this.bank.wantSteps();
    this.startWind(ctx);
  }

  /**
   * Wind: noise through two narrow filters that wander, one in each ear, with slow gusts.
   * It is the bed of the snow level and of the Architect's height, and is always running.
   */
  private startWind(ctx: AudioContext): void {
    const bed = new Bed(ctx, this.master, BED_LEVEL.wind);
    this.beds.set('wind', bed);
    for (const side of [-1, 1]) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.playbackRate.value = side > 0 ? 0.83 : 1;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = side > 0 ? 420 : 330;
      band.Q.value = 1.1;
      const wander = ctx.createOscillator();
      wander.frequency.value = side > 0 ? 0.083 : 0.061;
      const wanderBy = ctx.createGain();
      wanderBy.gain.value = 170;
      wander.connect(wanderBy).connect(band.frequency);
      const gust = ctx.createGain();
      gust.gain.value = 0.62;
      const gustLfo = ctx.createOscillator();
      gustLfo.frequency.value = side > 0 ? 0.137 : 0.097;
      const gustBy = ctx.createGain();
      gustBy.gain.value = 0.38;
      gustLfo.connect(gustBy).connect(gust.gain);
      const pan = ctx.createStereoPanner();
      pan.pan.value = side * 0.7;
      src.connect(band).connect(gust).connect(pan).connect(bed.input);
      src.start(0, side > 0 ? 0.9 : 0);
      wander.start();
      gustLfo.start();
    }
  }

  /** Head-related placement costs a convolution per sound; plain panning is for slow machines. */
  setSpatial(hrtf: boolean): void {
    this.hrtf = hrtf;
    const model = hrtf ? 'HRTF' : 'equalpower';
    for (const p of [...this.stepPans, ...(this.murmurs ?? []).map((m) => m.pan), ...(this.boxGain ? [this.boxPan, this.humPan] : [])]) p.panningModel = model;
  }

  /** A panner that only gives direction: loudness over distance is worked out by whoever places the sound. */
  private panner(): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    return p;
  }

  /** Point a panner at a place around the listener (only the direction is used). */
  private place(p: PannerNode, x: number, y: number, z: number, glide = 0.08): void {
    const d = Math.hypot(x, y, z);
    const k = d > 1e-3 ? 2 / d : 0;
    const t = this.ctx!.currentTime;
    const to = [x * k, y * k, d > 1e-3 ? z * k : -2];
    if (p.positionX) {
      [p.positionX, p.positionY, p.positionZ].forEach((param, i) => (glide > 0 ? param.setTargetAtTime(to[i], t, glide) : param.setValueAtTime(to[i], t)));
    } else {
      p.setPosition(to[0], to[1], to[2]);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.1);
  }

  /** Called every frame. `scene` is where the listener is, for the beds; dt is the frame's length. */
  update(foldMotion: number, droneHz: number, instability: number, scene?: Scene, dt = 1 / 60): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const m = Math.min(1, foldMotion * 0.6);
    this.rumbleGain.gain.setTargetAtTime(m * 0.55, t, 0.08);
    this.rumbleFilter.frequency.setTargetAtTime(90 + m * 260, t, 0.1);
    const mul = [1, 1, 2, 0.5];
    this.droneOsc.forEach((o, i) => o.frequency.setTargetAtTime(droneHz * mul[i] * (1 - instability * 0.04), t, 1.5));
    if (scene) this.ambience(ctx, scene, dt);
  }

  /** Bring each bed to where the scene wants it. A recording is loaded when first needed and stops once it has been silent a while. */
  private ambience(ctx: AudioContext, scene: Scene, dt: number): void {
    const mix = mixBeds(scene);
    this.rate = bedRate(scene.slow);
    for (const name of BED_NAMES) {
      const want = mix[name];
      let bed = this.beds.get(name);
      if (name !== 'wind') {
        const audible = want.gain > 0.004;
        if (!bed) {
          if (!audible) continue;
          bed = new Bed(ctx, this.master, BED_LEVEL[name]);
          this.beds.set(name, bed);
        }
        if (audible) {
          bed.quiet = 0;
          if (!bed.playing) {
            const buffer = this.bank?.loop(name) ?? null;
            if (buffer) bed.play(buffer, this.rate);
          }
        } else if (bed.playing && (bed.quiet += dt) > 4) bed.stop();
      }
      bed!.set(want, name === 'wind' ? 1 : this.rate);
    }
  }

  /** Which beds can be heard right now, and how loud each is asked to be (for tests and the curious). */
  get playing(): string[] {
    return [...this.beds].filter(([name, bed]) => name === 'wind' || bed.playing).map(([name]) => name);
  }

  /**
   * The crowd's murmur: a few groups around the listener (see crowdVoices). `level` is how much of
   * it reaches the ears at all; the crowd falls silent as it notices the dreamer (`hush`), and
   * finds its voice again, louder and sharper, when it turns on them (`uproar`).
   */
  crowd(voices: readonly Heard[], level: number, hush: number, uproar: number, muffled = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.murmurs) {
      if (level < 0.01 || !voices.some((v) => v.gain > 0.01)) return;
      const buffer = this.bank?.loop('murmur') ?? null;
      if (!buffer) return;
      this.murmurs = [];
      for (let k = 0; k < CROWD_VOICES; k++) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.playbackRate.value = MURMUR_RATES[k];
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1500;
        filter.Q.value = 0.5;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const pan = this.panner();
        const echo = ctx.createGain();
        echo.gain.value = 0.25;
        src.connect(filter).connect(gain).connect(pan).connect(this.master);
        gain.connect(echo).connect(this.reverb);
        src.start(0, (k / CROWD_VOICES) * buffer.duration);
        this.murmurs.push({ src, filter, gain, pan });
      }
    }
    const t = ctx.currentTime;
    this.murmurs.forEach((m, k) => {
      const v = voices[k];
      const g = v ? v.gain * level * (1 - 0.88 * hush) * (1 + 0.9 * uproar) : 0;
      m.gain.gain.setTargetAtTime(g * MURMUR_LEVEL, t, 0.4);
      m.filter.frequency.setTargetAtTime((1500 + 2500 * uproar) * (muffled ? 0.45 : 1), t, 0.4);
      m.src.playbackRate.setTargetAtTime(MURMUR_RATES[k] * (1 + 0.12 * uproar) * this.rate, t, 0.4);
      if (v) this.place(m.pan, v.x, v.y, v.z, 0.25);
    });
  }

  /** Somebody else's footstep, heard from where they are. */
  crowdStep(x: number, y: number, z: number, f: Footfall = PLAIN_STEP): void {
    const ctx = this.ctx;
    if (!ctx || !this.bank?.steps) return;
    if (this.stepPans.length === 0) {
      for (let i = 0; i < STEP_PANNERS; i++) {
        const p = this.panner();
        p.connect(this.master);
        this.stepPans.push(p);
      }
    }
    const d = Math.hypot(x, y, z);
    const p = this.stepPans[this.nextPan++ % STEP_PANNERS];
    this.place(p, x, y, z, 0);
    // quieter and duller with distance
    this.sample(f.set, (f.gain * 0.75) / (1 + (d / 5) ** 2), Math.min(f.tone ?? 20000, 9000 / (1 + d / 7)), p, 0.3);
  }

  /** Play one recorded footstep of a set into `out`. */
  private sample(set: StepSet, gain: number, tone: number | undefined, out: AudioNode, echo: number): void {
    const ctx = this.ctx!;
    const bank = this.bank!;
    const n = bank.stepCount(set);
    let i = Math.floor(Math.random() * n);
    // never the same recording twice running
    if (i === this.lastStep[set]) i = (i + 1) % n;
    this.lastStep[set] = i;
    const [start, length] = bank.step(set, i);
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = bank.steps;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = ctx.createGain();
    g.gain.value = STEP_LEVEL[set] * gain * (0.8 + 0.4 * Math.random());
    let head: AudioNode = src;
    if (tone && tone < 16000) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = tone;
      head = src.connect(f);
    }
    head.connect(g).connect(out);
    if (echo > 0) {
      const send = ctx.createGain();
      send.gain.value = echo;
      g.connect(send).connect(this.reverb);
    }
    src.start(t, start, length);
  }

  /** The horn. */
  braam(strength = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.currentTime - this.lastBraam < 1.2) return;
    this.lastBraam = ctx.currentTime;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.32 * strength, t + 0.09);
    out.gain.setValueAtTime(0.32 * strength, t + 1.1);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2.5;
    filter.frequency.setValueAtTime(140, t);
    filter.frequency.exponentialRampToValueAtTime(1500, t + 0.35);
    filter.frequency.exponentialRampToValueAtTime(380, t + 3);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / curve.length) * 2 - 1;
      curve[i] = Math.tanh(x * 2.6);
    }
    shaper.curve = curve;
    filter.connect(shaper).connect(out);
    out.connect(this.master);
    out.connect(this.reverb);
    for (const [f, d] of [
      [41.2, -8],
      [41.2, 9],
      [55, 0],
      [82.4, -5],
      [82.4, 6],
      [110, 3],
      [65.4, 0],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(filter);
      o.start(t);
      o.stop(t + 4.4);
    }
  }

  /** The kick: a sub drop and a rising wash. */
  kick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 2);

    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(200, t);
    f.frequency.exponentialRampToValueAtTime(5000, t + 1.6);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.35, t + 1.2);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    n.connect(f).connect(ng);
    ng.connect(this.master);
    ng.connect(this.reverb);
    n.start(t);
    n.stop(t + 2.4);
    this.lastBraam = 0;
    this.braam(0.8);
  }

  /** The café explosion: a deep blast, then stone and glass breaking in slow motion, thinning out. */
  shatter(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(22, t + 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 3.1);

    const burst = ctx.createBufferSource();
    burst.buffer = this.noise;
    const bf = ctx.createBiquadFilter();
    bf.type = 'lowpass';
    bf.frequency.setValueAtTime(1100, t);
    bf.frequency.exponentialRampToValueAtTime(110, t + 2.5);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    burst.connect(bf).connect(bg);
    bg.connect(this.master);
    bg.connect(this.reverb);
    burst.start(t);
    burst.stop(t + 3.1);

    // debris: grains of noise played slowly, so they sound stretched in time
    for (let i = 0; i < 70; i++) {
      const at = t + 0.05 + Math.pow(Math.random(), 1.8) * 3.4;
      const glass = Math.random() < 0.45;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.25 + Math.random() * 0.35;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = glass ? 2500 + Math.random() * 3500 : 300 + Math.random() * 700;
      f.Q.value = glass ? 6 : 1.5;
      const gg = ctx.createGain();
      const len = glass ? 0.25 : 0.4;
      gg.gain.setValueAtTime(0.0001, at);
      gg.gain.exponentialRampToValueAtTime((glass ? 0.12 : 0.18) * (1 - (at - t) / 4), at + 0.01);
      gg.gain.exponentialRampToValueAtTime(0.0001, at + len);
      src.connect(f).connect(gg);
      gg.connect(this.master);
      gg.connect(this.reverb);
      src.start(at, Math.random() * 1.5);
      src.stop(at + len + 0.05);
    }
  }

  /**
   * Heist beacons, every frame: how far (m) and which way (x to the right, z
   * behind, as the listener hears it) the nearest kick and sleep machine are,
   * or null for none. The kick's music carries about four blocks; the
   * machine's hum about two. Both are placed around the head, so "behind you"
   * sounds different from "ahead".
   */
  beacons(kick: { dist: number; x: number; z: number } | null, machine: { dist: number; x: number; z: number } | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.boxGain) this.startBeacons(ctx);
    const t = ctx.currentTime;
    const k = kick ? Math.max(0, 1 - kick.dist / 260) ** 2 : 0;
    this.boxGain!.gain.setTargetAtTime(k * 0.34, t, 0.15);
    this.boxFilter.frequency.setTargetAtTime(500 + 7500 * k, t, 0.15);
    if (kick) this.place(this.boxPan, kick.x, 0, kick.z);
    const m = machine ? Math.max(0, 1 - machine.dist / 130) ** 2 : 0;
    this.humGain.gain.setTargetAtTime(m * 0.16, t, 0.15);
    if (machine) this.place(this.humPan, machine.x, 0, machine.z);
  }

  /** A heartbeat that quickens as hurt (0..1) rises. Call every frame; 0 is silent. */
  heartbeat(hurt: number): void {
    const ctx = this.ctx;
    if (!ctx || hurt <= 0) return;
    const t = ctx.currentTime;
    if (t < this.nextBeat) return;
    this.nextBeat = t + 1.15 - 0.45 * hurt;
    for (const [at, f, v] of [
      [0, 62, 0.5],
      [0.2, 52, 0.36],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t + at);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, t + at + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(v * (0.4 + 0.6 * hurt), t + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.22);
      o.connect(g).connect(this.master);
      o.start(t + at);
      o.stop(t + at + 0.25);
    }
  }

  /** Something picked up: a rising bell. */
  chime(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    [659.3, 830.6, 987.8, 1318.5].forEach((f, i) => this.bell(f, t + i * 0.09, 0.16, 1.6));
  }

  /** A projection's blow. */
  hurt(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(f).connect(ng).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.2);
  }

  /** Going under: the sedative takes hold and everything sinks. */
  under(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [f0, det] of [
      [220, 0],
      [221.5, 0],
      [110, 4],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.detune.value = det;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 / 4, t + 2.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      o.connect(g);
      g.connect(this.master);
      g.connect(this.reverb);
      o.start(t);
      o.stop(t + 2.7);
    }
  }

  /** One music-box tine. */
  private bell(f: number, at: number, v: number, decay: number, out: AudioNode = this.master): void {
    const ctx = this.ctx!;
    for (const [mul, amp] of [
      [1, 1],
      [2.76, 0.32],
      [5.4, 0.12],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v * amp, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay / mul);
      o.connect(g);
      g.connect(out);
      g.connect(this.reverb);
      o.start(at);
      o.stop(at + decay / mul + 0.05);
    }
  }

  /** The kick's music box (an original little waltz, looped) and the sleep machine's hum. */
  private startBeacons(ctx: AudioContext): void {
    const beat = 0.4;
    // A minor waltz: MIDI note per beat, 0 holds
    const tune = [57, 60, 64, 69, 67, 64, 65, 64, 62, 64, 0, 0, 62, 65, 69, 67, 65, 62, 64, 62, 60, 59, 0, 0];
    const sr = ctx.sampleRate;
    const len = Math.round(tune.length * beat * sr);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    tune.forEach((note, i) => {
      if (!note) return;
      const f = 440 * 2 ** ((note + 12 - 69) / 12);
      const start = Math.round(i * beat * sr);
      // tines ring past the end of the loop, so wrap them round to the start
      for (let j = 0; j < sr * 1.6; j++) {
        const tt = j / sr;
        const v =
          Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 2.4) +
          0.3 * Math.sin(2 * Math.PI * f * 2.76 * tt) * Math.exp(-tt * 7) +
          0.1 * Math.sin(2 * Math.PI * f * 5.4 * tt) * Math.exp(-tt * 14);
        d[(start + j) % len] += v * 0.3 * Math.min(1, tt * 400);
      }
    });
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.boxFilter = ctx.createBiquadFilter();
    this.boxFilter.type = 'lowpass';
    this.boxFilter.frequency.value = 600;
    this.boxPan = this.panner();
    this.boxGain = ctx.createGain();
    this.boxGain.gain.value = 0;
    src.connect(this.boxFilter).connect(this.boxPan).connect(this.boxGain);
    this.boxGain.connect(this.master);
    this.boxGain.connect(this.reverb);
    src.start();

    this.humPan = this.panner();
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const tremolo = ctx.createGain();
    tremolo.gain.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 3.1;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.3;
    lfo.connect(lfoAmt).connect(tremolo.gain);
    lfo.start();
    for (const [f, type] of [
      [98, 'sine'],
      [196.4, 'triangle'],
      [293.7, 'sine'],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(tremolo);
      o.start();
    }
    tremolo.connect(this.humPan).connect(this.humGain).connect(this.master);
  }

  /**
   * The dreamer's own footstep: a recording for the surface (two, where one lies under
   * another), or a burst of noise at about the right pitch until the recordings have loaded.
   */
  step(f: Footfall = PLAIN_STEP, force = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.bank?.steps) {
      // left foot, right foot
      this.foot = 1 - this.foot;
      if (this.footPans.length === 0) {
        for (const side of [-1, 1]) {
          const p = ctx.createStereoPanner();
          p.pan.value = side * 0.14;
          p.connect(this.master);
          this.footPans.push(p);
        }
      }
      const pan = this.footPans[this.foot];
      this.sample(f.set, f.gain * force, f.tone, pan, STEP_ECHO[f.set]);
      if (f.under) this.sample(f.under, f.gain * force * (f.mix ?? 0.5), undefined, pan, STEP_ECHO[f.under]);
      return;
    }
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.playbackRate.value = 0.6 + Math.random() * 0.3;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = STEP_HZ[f.set] * (0.85 + Math.random() * 0.4);
    band.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.09 * f.gain * force, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(band).connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    n.start(t, Math.random());
    n.stop(t + 0.15);
  }

  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    return buf;
  }
}
