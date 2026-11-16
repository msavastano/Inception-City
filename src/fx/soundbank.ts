import { SOUNDS } from './sounds/manifest';
import { makeLoop, StepSet } from './soundscape';

/**
 * The recorded sounds (src/fx/sounds, built by scripts/pack-sounds.mjs from
 * CC0 recordings: see ASSETS.md). Files are fetched and decoded the first time
 * something asks for them, so a level's rain costs nothing until it rains.
 * Everything here can fail quietly: a browser that cannot decode Opus simply
 * gets no recordings, and audio.ts falls back on what it can make itself.
 */

export type LoopName = keyof typeof SOUNDS.beds;

// the bundler turns each file into a URL (or, in the one-file build, into a data: URL)
const URLS = import.meta.glob('./sounds/*.opus', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

async function bytes(url: string): Promise<ArrayBuffer> {
  // data: URLs are unpacked by hand, so that a page whose rules forbid fetching still has its sounds
  const m = /^data:[^,]*;base64,(.*)$/s.exec(url);
  if (m) {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.arrayBuffer();
}

export class SoundBank {
  private loops = new Map<LoopName, AudioBuffer | null>();
  private asked = new Set<string>();
  /** Every footstep, end to end (see SOUNDS.steps for where each one is). */
  steps: AudioBuffer | null = null;
  /** Set once a file has failed to load or decode: there is no point asking for the rest. */
  broken = false;

  constructor(private ctx: AudioContext) {}

  private async decode(file: string): Promise<AudioBuffer> {
    const url = URLS[`./sounds/${file}`];
    if (!url) throw new Error(`no such sound: ${file}`);
    const data = await bytes(url);
    // the callback form: older Safari has no promise form
    return new Promise((resolve, reject) => void this.ctx.decodeAudioData(data, resolve, reject)?.catch?.(reject));
  }

  private ask(key: string, work: () => Promise<void>): void {
    if (this.asked.has(key) || this.broken) return;
    this.asked.add(key);
    work().catch((err) => {
      this.broken = true;
      console.warn(`Recorded sound is off (${key}): ${err?.message ?? err}`);
    });
  }

  /** Start loading the footsteps. */
  wantSteps(): void {
    this.ask('steps', async () => {
      this.steps = await this.decode(SOUNDS.steps.file);
    });
  }

  /** A bed's seamless loop, or null until it has loaded (asking starts the load). */
  loop(name: LoopName): AudioBuffer | null {
    const have = this.loops.get(name);
    if (have !== undefined) return have;
    this.ask(name, async () => {
      const info = SOUNDS.beds[name];
      const raw = await this.decode(info.file);
      const sr = raw.sampleRate;
      const data = makeLoop(raw.getChannelData(0), Math.round(info.seconds * sr), Math.round(info.tail * sr));
      const buf = this.ctx.createBuffer(1, data.length, sr);
      buf.getChannelData(0).set(data);
      this.loops.set(name, buf);
    });
    return null;
  }

  /** Where one footstep of a set is in `steps`: [start, length] in seconds. */
  step(set: StepSet, index: number): readonly [number, number] {
    const list = SOUNDS.steps.sets[set];
    return list[index % list.length] as readonly [number, number];
  }

  stepCount(set: StepSet): number {
    return SOUNDS.steps.sets[set].length;
  }
}
