import { Vec3Like } from '../core/fold';

/**
 * The third-person camera ("behind the first person"): it looks the way the
 * dreamer looks, from over their right shoulder. Offsets are in metres, in
 * the view's own frame (right, up, back), measured from the middle of the head.
 */
export const CHASE = {
  /** Height of the middle of the head above the feet. */
  head: 1.62,
  side: 0.6,
  rise: 0.35,
  back: 3.8,
  /** The view tips down by this much (radians) from where the dreamer looks, so their feet stay in the picture. */
  tilt: 0.1,
  /** How close the camera may come to a wall (its near plane needs some room). */
  skin: 0.3,
  /** Lowest the camera goes above the street (looking up, it slides along the ground towards the dreamer's feet). */
  floor: 0.35,
  /** Nearer than this to the head, the body is hidden: the view is as good as first person. */
  hideWithin: 0.7,
};

/**
 * How far along the segment from `from` to `to` (0 to 1) a camera can go
 * before `blocked` says it is in something. Samples the segment, then
 * narrows the first hit down by bisection. `from` is taken to be clear.
 */
export function clearance(from: Vec3Like, to: Vec3Like, blocked: (x: number, y: number, z: number) => boolean, steps = 16): number {
  const at = (t: number) => blocked(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
  let lo = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!at(t)) {
      lo = t;
      continue;
    }
    let hi = t;
    for (let k = 0; k < 5; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid)) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  return 1;
}

/** Pull in at once, let out gently, so the camera doesn't pump in and out as you walk past corners. */
export function boomFollow(current: number, free: number, dt: number, rate = 2.5): number {
  if (free <= current) return free;
  return current + (free - current) * (1 - Math.exp(-rate * dt));
}
