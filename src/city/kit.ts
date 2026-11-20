import { STREET } from './street/manifest';

/**
 * The street life kit's models: their ids, what kind of surface each part of them is, and how each is drawn.
 * (No three.js here: the city generator places the kit, src/city/streetLife.ts, and runs without it.)
 * The models themselves are loaded by src/city/streetKit.ts.
 */

/** The models, by id (the order of Kit). */
export const KIT_MODELS = ['terrace', 'parasol', 'bench', 'bollard', 'rack', 'planter', 'menu', 'bin', 'column', 'kiosk', 'metro', 'fountain', 'car_hatch', 'car_saloon', 'car_van'] as const;

export const enum Kit {
  /** Two bistro chairs side by side, backs to a facade, a round marble table in front: a café terrace. */
  Terrace = 0,
  /** A square table and four chairs under a canvas parasol: a terrace out on a square. */
  Parasol = 1,
  /** A bench of green slats on cast-iron ends, seat to +z. */
  Bench = 2,
  /** A cast-iron bollard. */
  Bollard = 3,
  /** A steel hoop along x with a bicycle leaning on its +z side. */
  Rack = 4,
  /** A long planter box with a clipped hedge. */
  Planter = 5,
  /** An A-frame chalkboard. */
  Menu = 6,
  /** A litter bin: a bag in a ring on a post. */
  Bin = 7,
  /** An advertising column. */
  Column = 8,
  /** A news kiosk, its counter to +z. */
  Kiosk = 9,
  /** A metro entrance: balustrade round a stairwell open to +z, lamp stalks and a sign over the mouth. */
  Metro = 10,
  /** A drinking fountain under a little dome held up by four figures. */
  Fountain = 11,
  /** Parked cars, all generic, bonnet to +z. */
  CarHatch = 12,
  CarSaloon = 13,
  CarVan = 14,
}

export const KIT_COUNT = KIT_MODELS.length;
/** The cars' ids run from here to the end. */
export const FIRST_CAR = Kit.CarHatch;
export const isCar = (k: Kit): boolean => k >= FIRST_CAR;

/** Surface kinds, the alpha of a model's colour attribute times 16 (KINDS in build_street.py). */
export const KIT_KIND = {
  matte: 1,
  iron: 2,
  chrome: 3,
  paint: 4,
  cloth: 5,
  glass: 6,
  lamp: 7,
  rubber: 8,
  poster: 9,
  foliage: 10,
  void: 11,
  plastic: 12,
} as const;

/** Which distance ring a model is drawn out to (kitField.ts sets each ring's reach per quality tier). */
export type KitRing = 'small' | 'large' | 'car';

export interface KitSpec {
  ring: KitRing;
  /** It casts a shadow (out to the kit's shadow distance; its far version never does). */
  shadow: boolean;
  /** The café explosion throws it (light furniture). */
  thrown: boolean;
  /**
   * It has a far version (the model named "<name>_far"), drawn instead of it beyond a distance: the cars beyond
   * KitField.carNear, the parasols (whose chairs are left out) beyond the small furniture's reach.
   */
  far: boolean;
}

export const KIT_SPEC: readonly KitSpec[] = [
  { ring: 'small', shadow: true, thrown: true, far: false }, // terrace
  { ring: 'large', shadow: true, thrown: true, far: true }, // parasol
  { ring: 'small', shadow: true, thrown: true, far: false }, // bench
  { ring: 'small', shadow: false, thrown: false, far: false }, // bollard
  { ring: 'small', shadow: true, thrown: true, far: false }, // rack
  { ring: 'small', shadow: true, thrown: true, far: false }, // planter
  { ring: 'small', shadow: false, thrown: true, far: false }, // menu
  { ring: 'small', shadow: false, thrown: true, far: false }, // bin
  { ring: 'large', shadow: true, thrown: false, far: false }, // column
  { ring: 'large', shadow: true, thrown: false, far: false }, // kiosk
  { ring: 'large', shadow: true, thrown: false, far: false }, // metro
  { ring: 'large', shadow: true, thrown: false, far: false }, // fountain
  { ring: 'car', shadow: true, thrown: false, far: true },
  { ring: 'car', shadow: true, thrown: false, far: true },
  { ring: 'car', shadow: true, thrown: false, far: true },
];

/** A model's bounds (metres, before it is turned) and triangles, from the manifest; far: its far version's. */
export function kitModel(k: Kit, far = false): { triangles: number; min: readonly number[]; max: readonly number[] } {
  const models: Record<string, { triangles: number; min: readonly number[]; max: readonly number[] }> = STREET.models;
  return models[far ? `${KIT_MODELS[k]}_far` : KIT_MODELS[k]];
}
