/**
 * Dream levels. Each level down is a deeper dream: time runs faster relative
 * to the waking world, the architecture loses its grip, and the palette drains.
 */

export type Weather = 'none' | 'rain' | 'snow' | 'ash';

export interface Palette {
  skyTop: number;
  skyHorizon: number;
  skyBottom: number;
  fog: number;
  sun: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
}

export interface DreamLevel {
  id: number;
  name: string;
  subtitle: string;
  /** Dream seconds per real second (Inception's ×20 per level). */
  dilation: number;
  day: Palette;
  night: Palette;
  /** Default time of day 0 (noon) .. 1 (midnight). */
  time: number;
  sunAzimuth: number;
  snow: number;
  wet: number;
  limbo: number;
  weather: Weather;
  foliageA: number;
  foliageB: number;
  sea: number;
  /** Display grade: split-tone tint, saturation, contrast. */
  tint: [number, number, number];
  saturation: number;
  contrast: number;
  /** Base pitch of the ambient drone in Hz. */
  drone: number;
}

const NIGHT_COMMON: Palette = {
  skyTop: 0x05070f,
  skyHorizon: 0x1a2236,
  skyBottom: 0x07080c,
  fog: 0x121826,
  sun: 0x8aa2d8,
  sunIntensity: 0.35,
  hemiSky: 0x4a5f92,
  hemiGround: 0x16161c,
  hemiIntensity: 0.75,
};

export const LEVELS: DreamLevel[] = [
  {
    id: 1,
    name: 'Level 1 · The City',
    subtitle: 'A Paris morning that will not stay flat.',
    dilation: 20,
    day: {
      skyTop: 0x5b8fd0,
      skyHorizon: 0xdfe6ea,
      skyBottom: 0xb9b2a4,
      fog: 0xc9d2d8,
      sun: 0xfff1d6,
      sunIntensity: 2.6,
      hemiSky: 0xbcd3f0,
      hemiGround: 0x8a7a66,
      hemiIntensity: 1.1,
    },
    night: NIGHT_COMMON,
    time: 0.18,
    sunAzimuth: 3.6,
    snow: 0,
    wet: 0,
    limbo: 0,
    weather: 'none',
    foliageA: 0x3a5a22,
    foliageB: 0x6b8a34,
    sea: 0x52616b,
    tint: [1.05, 1.0, 0.94],
    saturation: 1.14,
    contrast: 1.08,
    drone: 55,
  },
  {
    id: 2,
    name: 'Level 2 · Rain',
    subtitle: 'Dusk, wet cobbles, the projections are restless.',
    dilation: 400,
    day: {
      skyTop: 0x34465c,
      skyHorizon: 0x8c99a3,
      skyBottom: 0x3c4146,
      fog: 0x707d88,
      sun: 0xffc89a,
      sunIntensity: 0.9,
      hemiSky: 0x8ea3b8,
      hemiGround: 0x3a3a3c,
      hemiIntensity: 0.9,
    },
    night: { ...NIGHT_COMMON, fog: 0x1a2430, hemiIntensity: 0.4 },
    time: 0.58,
    sunAzimuth: 2.4,
    snow: 0,
    wet: 1,
    limbo: 0,
    weather: 'rain',
    foliageA: 0x6a4a1c,
    foliageB: 0xa8642a,
    sea: 0x3c4a52,
    tint: [0.94, 1.0, 1.06],
    saturation: 0.85,
    contrast: 1.1,
    drone: 49,
  },
  {
    id: 3,
    name: 'Level 3 · Snow',
    subtitle: 'White silence. Sound travels strangely here.',
    dilation: 8000,
    day: {
      skyTop: 0x9fb0c2,
      skyHorizon: 0xe8edf2,
      skyBottom: 0xd8dde2,
      fog: 0xdfe5ea,
      sun: 0xf4f6ff,
      sunIntensity: 1.5,
      hemiSky: 0xdfe8f5,
      hemiGround: 0xb8bcc4,
      hemiIntensity: 1.3,
    },
    night: { ...NIGHT_COMMON, fog: 0x2a3344, hemiGround: 0x3a4050 },
    time: 0.3,
    sunAzimuth: 4.1,
    snow: 1,
    wet: 0,
    limbo: 0,
    weather: 'snow',
    foliageA: 0x2e4a3a,
    foliageB: 0x46604c,
    sea: 0x6a7884,
    tint: [0.97, 1.0, 1.05],
    saturation: 0.75,
    contrast: 1.02,
    drone: 41.2,
  },
  {
    id: 4,
    name: 'Limbo',
    subtitle: 'Unconstructed dream space. The city crumbles into the sea.',
    dilation: Infinity,
    day: {
      skyTop: 0x6f7377,
      skyHorizon: 0xc9c2b4,
      skyBottom: 0x6c6a66,
      fog: 0xb0aca3,
      sun: 0xffe2b8,
      sunIntensity: 1.6,
      hemiSky: 0xc4c0b8,
      hemiGround: 0x5a5650,
      hemiIntensity: 0.95,
    },
    night: { ...NIGHT_COMMON, fog: 0x22252a },
    time: 0.42,
    sunAzimuth: 5.4,
    snow: 0,
    wet: 0.3,
    limbo: 1,
    weather: 'ash',
    foliageA: 0x4a4a42,
    foliageB: 0x6a665a,
    sea: 0x4f5a5e,
    tint: [1.02, 1.0, 0.98],
    saturation: 0.45,
    contrast: 1.12,
    drone: 36.7,
  },
];
