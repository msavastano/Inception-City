import { BLOCK } from '../core/config';
import { FoldShape } from '../core/fold';

/** Radius of the curl that carries a dreamer over. Large enough that the two halves' buildings never meet. */
export const RIDE_RADIUS = 48;
/**
 * How far behind the dreamer the hinge must be. Past the curl (π·R) the page
 * is rigid, so the dreamer rides it like a turning page instead of being
 * wrapped around the bend.
 */
export const RIDE_MIN_BACK = Math.PI * RIDE_RADIUS + 12;

/**
 * The fold that lifts the street a dreamer stands on: the hinge sits on the
 * first street line far enough behind them, and everything from there forward,
 * dreamer included, turns up and over the city behind.
 */
export function rideSpec(x: number, z: number, yaw: number): Omit<FoldShape, 'angle'> & { target: number } {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const alongX = Math.abs(fx) > Math.abs(fz);
  const nx = alongX ? Math.sign(fx) : 0;
  const nz = alongX ? 0 : Math.sign(fz);
  const sign = alongX ? nx : nz;
  const coord = (alongX ? x : z) - sign * RIDE_MIN_BACK;
  const line = sign > 0 ? Math.floor(coord / BLOCK) : Math.ceil(coord / BLOCK);
  return {
    hx: alongX ? line * BLOCK : x,
    hz: alongX ? z : line * BLOCK,
    nx,
    nz,
    target: Math.PI,
    radius: RIDE_RADIUS,
  };
}
