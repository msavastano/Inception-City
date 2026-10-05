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
  // Heist mode: a music box at the kick, a hum at the sleep machine, a heartbeat when hurt
  private boxGain: GainNode | null = null;
  private boxPan!: StereoPannerNode;
  private boxFilter!: BiquadFilterNode;
  private humGain!: GainNode;
  private humPan!: StereoPannerNode;
  private nextBeat = 0;

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

  /**
   * Heist beacons, every frame: how far (m) and which way (-1 left .. 1 right)
   * the nearest kick and sleep machine are, or null for none. The kick's music
   * carries about four blocks; the machine's hum about two.
   */
  beacons(kick: { dist: number; pan: number } | null, machine: { dist: number; pan: number } | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.boxGain) this.startBeacons(ctx);
    const t = ctx.currentTime;
    const k = kick ? Math.max(0, 1 - kick.dist / 260) ** 2 : 0;
    this.boxGain!.gain.setTargetAtTime(k * 0.34, t, 0.15);
    this.boxFilter.frequency.setTargetAtTime(500 + 7500 * k, t, 0.15);
    if (kick) this.boxPan.pan.setTargetAtTime(kick.pan * 0.8, t, 0.1);
    const m = machine ? Math.max(0, 1 - machine.dist / 130) ** 2 : 0;
    this.humGain.gain.setTargetAtTime(m * 0.16, t, 0.15);
    if (machine) this.humPan.pan.setTargetAtTime(machine.pan * 0.8, t, 0.1);
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
    this.boxPan = ctx.createStereoPanner();
    this.boxGain = ctx.createGain();
    this.boxGain.gain.value = 0;
    src.connect(this.boxFilter).connect(this.boxPan).connect(this.boxGain);
    this.boxGain.connect(this.master);
    this.boxGain.connect(this.reverb);
    src.start();

    this.humPan = ctx.createStereoPanner();
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
