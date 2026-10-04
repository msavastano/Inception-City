/** Hand-composed fold arrangements, each with a camera that shows it off. */

export interface FoldSpec {
  hx: number;
  hz: number;
  nx: number;
  nz: number;
  angle: number;
  radius: number;
}

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  folds: FoldSpec[];
  camera: { pos: [number, number, number]; target: [number, number, number] };
}

const PI = Math.PI;

export const PRESETS: Preset[] = [
  {
    id: 'paris',
    name: 'The Paris Fold',
    blurb: 'The far half of the city curls up and hangs upside down overhead.',
    folds: [{ hx: 0, hz: 192, nx: 0, nz: 1, angle: PI, radius: 110 }],
    camera: { pos: [0, 22, -150], target: [0, 78, 250] },
  },
  {
    id: 'double',
    name: 'Double Fold',
    blurb: 'North and south both fold inward. Two skies made of streets.',
    folds: [
      { hx: 0, hz: 256, nx: 0, nz: 1, angle: PI, radius: 120 },
      { hx: 0, hz: -256, nx: 0, nz: -1, angle: PI, radius: 165 },
    ],
    camera: { pos: [0, 40, -120], target: [0, 150, 300] },
  },
  {
    id: 'scroll',
    name: 'The Scroll',
    blurb: 'Four nested quarter-folds roll the city up like a carpet.',
    folds: [
      { hx: 0, hz: 128, nx: 0, nz: 1, angle: PI / 2, radius: 60 },
      { hx: 0, hz: 448, nx: 0, nz: 1, angle: PI / 2, radius: 60 },
      { hx: 0, hz: 704, nx: 0, nz: 1, angle: PI / 2, radius: 55 },
      { hx: 0, hz: 896, nx: 0, nz: 1, angle: PI / 2, radius: 50 },
    ],
    camera: { pos: [-430, 330, -330], target: [0, 150, 240] },
  },
  {
    id: 'escher',
    name: 'Escher Steps',
    blurb: 'Alternating folds turn the grid into a staircase of districts.',
    folds: [
      { hx: 0, hz: 64, nx: 0, nz: 1, angle: PI / 2, radius: 30 },
      { hx: 0, hz: 256, nx: 0, nz: 1, angle: -PI / 2, radius: 30 },
      { hx: 0, hz: 448, nx: 0, nz: 1, angle: PI / 2, radius: 30 },
      { hx: 0, hz: 640, nx: 0, nz: 1, angle: -PI / 2, radius: 30 },
    ],
    camera: { pos: [-400, 300, -220], target: [0, 150, 300] },
  },
  {
    id: 'box',
    name: 'City in a Box',
    blurb: 'All four edges stand up into walls, corners cut like a paper box.',
    folds: [
      { hx: 0, hz: 192, nx: 0, nz: 1, angle: PI / 2, radius: 50 },
      { hx: 0, hz: -192, nx: 0, nz: -1, angle: PI / 2, radius: 50 },
      { hx: 192, hz: 0, nx: 1, nz: 0, angle: PI / 2, radius: 50 },
      { hx: -192, hz: 0, nx: -1, nz: 0, angle: PI / 2, radius: 50 },
    ],
    camera: { pos: [-110, 150, -140], target: [70, 110, 170] },
  },
];
