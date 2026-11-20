import * as THREE from 'three';

/**
 * The dials for the lighting and atmosphere pass, in one place.
 *
 * These are the global ones. Each dream level also has its own haze, exposure and grade
 * in src/world/themes.ts. Every dial can be overridden from the link for a quick
 * side-by-side, for example  #tone=aces&ao=0&haze=0&glow=0  is the look before this pass:
 *
 *   tone         neutral | agx | aces     the tone curve
 *   ao           0 .. 1.5                 ambient occlusion (contact shadows)
 *   haze         0 .. 3                   multiplies every level's haze
 *   glow         0 .. 2                   lamp halos and the lamps' wash on the facades at night
 *   relief       0 .. 2                   depth of the window reveals and of the walls' joints, ledges and cornices
 *   hall         0 | 1                    the rotating hallway as the modelled corridor (1) or the painted box it replaced (0)
 *   detail       0 .. 2.5                 the scanned grain of the surfaces close to: asphalt, paving, setts, stone (0 none)
 *   trees        0 .. 2                   how far out the trees keep their near version, every branch and leaf (0: far version only)
 *   kit          0 .. 2                   how far out the street life kit is drawn: parked cars, café terraces, kiosks (0: none)
 *   exposure, contrast, saturation        multiply every level's own
 */
export type ToneCurve = 'neutral' | 'agx' | 'aces';

/** Each curve's trim keeps the levels' grades (written for the default curve) roughly in step when the curve is swapped. */
export const TONE_CURVES: Record<ToneCurve, { mapping: THREE.ToneMapping; exposure: number; contrast: number; saturation: number }> = {
  // Khronos PBR Neutral: colours stay as they were painted until they are nearly white, so it
  // favours neither a film look nor a stylised one. The levels' grades are written for it.
  neutral: { mapping: THREE.NeutralToneMapping, exposure: 1, contrast: 1, saturation: 1 },
  // AgX rolls highlights off gently, the way film does, and comes out much softer, so the
  // grade gives contrast and colour back.
  agx: { mapping: THREE.AgXToneMapping, exposure: 1.1, contrast: 1.3, saturation: 1.3 },
  // The curve the game shipped with: punchy, and it pulls bright colours towards yellow and white.
  aces: { mapping: THREE.ACESFilmicToneMapping, exposure: 1, contrast: 0.98, saturation: 0.98 },
};

export const LOOK = {
  tone: 'neutral' as ToneCurve,
  /** How much of the computed ambient occlusion is applied (0 none, 1 as designed). */
  ao: 1,
  /** Multiplies every level's haze and mist. */
  haze: 1,
  /** Lamp halos and the lamps' light on the facades at night. */
  glow: 1,
  /** The walls' relief: window reveals, joints and the shadows under ledges (0 flat, 1 as designed). Low quality has none. */
  relief: 1,
  /** The rotating hallway: the corridor modelled and baked in Blender (1), or the painted box before it (0). Low quality always has the box. */
  hall: 1,
  /** The scanned grain of the surfaces close to (0 none, 1 as designed: relief, roughness and cavities). Low quality has none. */
  detail: 1,
  /** Multiplies how far out the trees keep their near version (0: the far one everywhere, as on Low). */
  trees: 1,
  /** Multiplies how far out the street life kit is drawn (0: none of it). */
  kit: 1,
  /** Multiply every level's exposure and grade. */
  exposure: 1,
  contrast: 1,
  saturation: 1,
};

/** Read overrides from the link's hash parameters. */
export function readLook(params: URLSearchParams): void {
  const tone = params.get('tone');
  if (tone && tone in TONE_CURVES) LOOK.tone = tone as ToneCurve;
  for (const key of ['ao', 'haze', 'glow', 'relief', 'hall', 'detail', 'trees', 'kit', 'exposure', 'contrast', 'saturation'] as const) {
    const v = params.get(key);
    if (v !== null && v !== '' && Number.isFinite(Number(v))) LOOK[key] = Math.max(0, Number(v));
  }
}
