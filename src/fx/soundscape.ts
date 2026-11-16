import type { Ground } from '../city/surface';

/**
 * What the dream should sound like, worked out from where the listener is.
 * Everything here is plain arithmetic with no Web Audio in it, so it can be
 * tested: audio.ts turns the numbers into sound.
 */

/** The looping layers under everything else. 'wind' is made in code; the rest are recordings. */
export type BedName = 'city' | 'birds' | 'rain' | 'cover' | 'sea' | 'room' | 'wind';
export const BED_NAMES: BedName[] = ['city', 'birds', 'rain', 'cover', 'sea', 'room', 'wind'];

/** Sets of recorded footsteps. */
export type StepSet = 'stone' | 'gravel' | 'grass' | 'snow' | 'wet' | 'water' | 'carpet' | 'wood';

export interface Scene {
  /** The level's weather and how far its snow and Limbo have set in (0..1). */
  rain: number;
  snow: number;
  limbo: number;
  /** 0 noon .. 1 night. */
  night: number;
  /** Ears on the street (Dream Walk) or up at the Architect's camera. */
  walking: boolean;
  /** Metres above the street (only matters when not walking). */
  altitude: number;
  /** Inside the rotating hallway. */
  hall: boolean;
  /** 0 under open sky .. 1 against a facade, under its awnings. */
  cover: number;
  /** 0..1 trees in earshot. */
  green: number;
  /** 0..1 how close Limbo's sea is. */
  shore: number;
  /** The world's time scale: 1, or less while the dream collapses in slow motion. */
  slow: number;
  /** 0..1 the picture is faded out between dreams. */
  dim: number;
}

export interface BedMix {
  /** 0 silent .. 1 fully present (audio.ts scales each bed to its own loudness). */
  gain: number;
  /** Low-pass cut-off in Hz: distance, walls and slow motion all take the top off a sound. */
  cutoff: number;
}

const OPEN = 16000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The beds for a scene. Each level has its own: the City a far rumble of
 * traffic and birds by day, the Rain its rain (lower and closer under an
 * awning), the Snow wind and little else, Limbo its sea. The hallway shuts
 * most of that out and has a hum of its own. Up at the Architect's camera the
 * street falls away and the wind takes over.
 */
export function mixBeds(s: Scene): Record<BedName, BedMix> {
  const high = s.walking ? 0 : Math.max(0, s.altitude);
  /** How much of the street reaches the ears. */
  const near = Math.exp(-high / 260);
  const dry = (1 - s.rain) * (1 - s.snow) * (1 - s.limbo);
  const gain: Record<BedName, number> = {
    city: (1 - 0.45 * s.night) * (0.4 + 0.6 * near) * (1 - 0.3 * s.rain) * (1 - 0.65 * s.snow) * (1 - s.limbo),
    birds: dry * (1 - s.night) ** 2 * s.green * Math.exp(-high / 90),
    rain: s.rain * (1 - 0.6 * s.cover) * (0.6 + 0.4 * near),
    cover: s.rain * s.cover * (s.walking ? 1 : 0),
    sea: s.limbo * (s.walking ? 0.3 + 0.7 * s.shore : 0.35 + 0.35 * near),
    room: s.hall ? 1 : 0,
    wind: Math.min(1, 0.12 + 0.5 * s.snow + 0.3 * s.limbo + 0.55 * (1 - near)),
  };
  let cutoff = OPEN * (0.2 + 0.8 * near);
  if (s.hall) cutoff = 900;
  // slow motion drags every sound down with it
  cutoff *= 0.25 + 0.75 * s.slow;
  const fade = 1 - clamp01(s.dim);
  const out = {} as Record<BedName, BedMix>;
  for (const name of BED_NAMES) {
    const outside = name !== 'room';
    out[name] = {
      gain: clamp01(gain[name]) * fade * (s.hall && outside ? 0.3 : 1),
      cutoff: outside ? cutoff : OPEN * (0.25 + 0.75 * s.slow),
    };
  }
  return out;
}

/** How fast the beds play: slow motion lowers them, as it does the drone. */
export function bedRate(slow: number): number {
  return 0.55 + 0.45 * clamp01(slow);
}

export interface Footfall {
  set: StepSet;
  /** Loudness, about 1. */
  gain: number;
  /** A second sound laid under the first (a splash on wet stone, stone under thin snow) and how loud. */
  under?: StepSet;
  mix?: number;
  /** Low-pass in Hz, for a duller surface than the recording's. */
  tone?: number;
}

/**
 * The footstep for a surface in a given dream: dry stone in the City, the
 * same stone with a splash in the Rain, snow over everything in the Snow, and
 * water where Limbo's sea has come in over the streets.
 */
export function footing(ground: Ground, level: { snow: number; wet: number }, sea = 0): Footfall {
  if (sea > 0.5) return { set: 'water', gain: 1 };
  if (level.snow > 0.5) {
    // the roads are ploughed thin; everything else is deep
    if (ground === 'asphalt') return { set: 'snow', gain: 0.8, under: 'stone', mix: 0.4 };
    return { set: 'snow', gain: 1 };
  }
  if (ground === 'water') return { set: 'water', gain: 1 };
  const wet = level.wet > 0.5;
  switch (ground) {
    case 'grass':
      return wet ? { set: 'grass', gain: 1, under: 'wet', mix: 0.3 } : { set: 'grass', gain: 1 };
    case 'gravel':
      return wet ? { set: 'gravel', gain: 1, under: 'wet', mix: 0.45 } : { set: 'gravel', gain: 1 };
    case 'asphalt':
      // tarmac is duller underfoot than flagstones
      return wet ? { set: 'stone', gain: 0.85, tone: 4200, under: 'wet', mix: 0.9 } : { set: 'stone', gain: 0.9, tone: 4200 };
    default:
      return wet ? { set: 'stone', gain: 0.9, under: 'wet', mix: 0.9 } : { set: 'stone', gain: 1 };
  }
}

/** Inside the hallway: carpet on the floor, panelling on the walls and the ceiling. */
export function hallFooting(face: number): Footfall {
  return face === 0 ? { set: 'carpet', gain: 1 } : { set: 'wood', gain: 0.9 };
}

/**
 * A fabric offset from the listener (dx, dz), as the listener hears it: x to
 * the right, z behind (Web Audio's listener looks down -z), for someone
 * facing `yaw` (0 looks along +z, as the walker's yaw does).
 */
export function toEar(dx: number, dz: number, yaw: number, out: { x: number; z: number }): { x: number; z: number } {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  out.x = -dx * c + dz * s;
  out.z = -(dx * s + dz * c);
  return out;
}

export interface CrowdVoice {
  /** Where the voice stands, as a fabric offset from the listener. */
  x: number;
  z: number;
  /** 0 nobody there .. 1 a dense crowd close by. */
  gain: number;
}

/** How many murmuring groups are placed around the listener. */
export const CROWD_VOICES = 3;
const EARSHOT = 90;

/**
 * Boil the people near the listener down to a few murmuring groups, one for
 * each third of the compass (in fabric space, so a group stays put as the
 * listener turns). Each stands at the centre of its people, weighted by how
 * close they are, and is as loud as they are many and near.
 * `people` holds x, z pairs.
 */
export function crowdVoices(people: ArrayLike<number>, count: number, lx: number, lz: number, out: CrowdVoice[]): CrowdVoice[] {
  const sum = [0, 0, 0];
  const sx = [0, 0, 0];
  const sz = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const dx = people[i * 2] - lx;
    const dz = people[i * 2 + 1] - lz;
    const d = Math.hypot(dx, dz);
    if (d > EARSHOT) continue;
    const w = 1 / (1 + (d / 14) ** 2);
    const k = Math.min(CROWD_VOICES - 1, Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * CROWD_VOICES));
    sum[k] += w;
    sx[k] += dx * w;
    sz[k] += dz * w;
  }
  for (let k = 0; k < CROWD_VOICES; k++) {
    const v = (out[k] ??= { x: 0, z: 0, gain: 0 });
    // with nobody there the voice waits in the middle of its sector, silent
    const mid = ((k + 0.5) / CROWD_VOICES) * Math.PI * 2 - Math.PI;
    let x = Math.cos(mid) * 20;
    let z = Math.sin(mid) * 20;
    if (sum[k] > 1e-4) {
      x = sx[k] / sum[k];
      z = sz[k] / sum[k];
      // never right inside the listener's head
      const d = Math.hypot(x, z);
      if (d < 3) {
        const push = 3 / Math.max(d, 1e-3);
        x = d > 1e-3 ? x * push : Math.cos(mid) * 3;
        z = d > 1e-3 ? z * push : Math.sin(mid) * 3;
      }
    }
    v.x = x;
    v.z = z;
    v.gain = 1 - Math.exp(-sum[k] / 2.5);
  }
  return out;
}

/**
 * Close a recording into a seamless loop. `data` holds the loop followed by a
 * tail; the tail is faded back in over the loop's first stretch (equal power,
 * since the two are unrelated noise), so the last sample runs on into the
 * first exactly as it ran on into the tail.
 */
export function makeLoop(data: Float32Array, loop: number, tail: number): Float32Array {
  loop = Math.min(loop, data.length);
  tail = Math.max(0, Math.min(tail, data.length - loop, loop));
  const out = data.slice(0, loop);
  for (let i = 0; i < tail; i++) {
    const t = ((i + 0.5) / tail) * (Math.PI / 2);
    out[i] = data[i] * Math.sin(t) + data[loop + i] * Math.cos(t);
  }
  return out;
}
