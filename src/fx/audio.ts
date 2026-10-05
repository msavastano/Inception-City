/**
 * Procedural sound: no audio files. A low drone tuned per dream level, a
 * stone-on-stone rumble while the city folds, the brass "BRAAAM" when a fold
 * lands, footsteps, and the kick.
 */
export class DreamAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
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

  get ready(): boolean {
    return !!this.ctx;
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
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.1);
  }

  /** Called every frame. */
  update(foldMotion: number, droneHz: number, instability: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const m = Math.min(1, foldMotion * 0.6);
    this.rumbleGain.gain.setTargetAtTime(m * 0.55, t, 0.08);
    this.rumbleFilter.frequency.setTargetAtTime(90 + m * 260, t, 0.1);
    const mul = [1, 1, 2, 0.5];
    this.droneOsc.forEach((o, i) => o.frequency.setTargetAtTime(droneHz * mul[i] * (1 - instability * 0.04), t, 1.5));
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

  step(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.playbackRate.value = 0.6 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 600 + Math.random() * 300;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.09, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(f).connect(g);
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
