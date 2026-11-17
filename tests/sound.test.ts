import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { groundAt, greenAt, shelterAt } from '../src/city/surface';
import { BlockKind, blockKind } from '../src/city/generator';
import { BLOCK, GUTTER, SIDEWALK, streetHalfWidth } from '../src/core/config';
import { SOUNDS } from '../src/fx/sounds/manifest';
import { BED_NAMES, BedName, bedRate, CROWD_VOICES, crowdVoices, CrowdVoice, footing, hallFooting, makeLoop, mixBeds, Scene, toEar } from '../src/fx/soundscape';
import { Projections } from '../src/world/projections';
import assets from '../ASSETS.md?raw';
import packScript from '../scripts/pack-sounds.mjs?raw';

/** Every recording in the build, as the bytes the browser will be sent. */
const inlined = import.meta.glob('../src/fx/sounds/*.opus', { eager: true, query: '?inline', import: 'default' }) as Record<string, string>;
const recordings = Object.entries(inlined).map(([path, url]) => {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  return { file: path.slice(path.lastIndexOf('/') + 1), bytes: bin.length, head: bin.slice(0, 4) };
});

const SEED = 4242;

/** The first block of a kind, looking outwards from the middle. */
function findBlock(kind: BlockKind): [number, number] {
  for (let r = 1; r < 40; r++) {
    for (let bz = -r; bz <= r; bz++) {
      for (let bx = -r; bx <= r; bx++) {
        if (Math.max(Math.abs(bx), Math.abs(bz)) === r && blockKind(bx, bz, SEED) === kind) return [bx, bz];
      }
    }
  }
  throw new Error('no such block');
}

/** Standing in a Level 1 street at noon. */
function scene(over: Partial<Scene> = {}): Scene {
  return { rain: 0, snow: 0, limbo: 0, night: 0, walking: true, altitude: 0, hall: false, cover: 0, green: 0.5, shore: 0, slow: 1, dim: 0, ...over };
}

/** The beds that can be heard, loudest first. */
function heard(s: Scene): BedName[] {
  const mix = mixBeds(s);
  return BED_NAMES.filter((n) => mix[n].gain > 0.05).sort((a, b) => mix[b].gain - mix[a].gain);
}

describe('what is underfoot', () => {
  it('reads the Circus as the ground shader paints it: hub, lawn, roadway, pavement', () => {
    expect(groundAt(5, 0, SEED)).toBe('paving');
    expect(groundAt(0, 19, SEED)).toBe('grass');
    expect(groundAt(-32, 0, SEED)).toBe('asphalt');
    expect(groundAt(30, 30, SEED)).toBe('paving');
  });

  it('tells the roadway from the sidewalk, on streets and on boulevards', () => {
    for (const line of [2, 4]) {
      const hw = streetHalfWidth(line);
      const z = 6.5 * BLOCK;
      expect(groundAt(line * BLOCK, z, SEED)).toBe('asphalt');
      expect(groundAt(line * BLOCK + hw - SIDEWALK - GUTTER - 0.2, z, SEED)).toBe('asphalt');
      // the gutter of setts along the kerb is stone underfoot
      expect(groundAt(line * BLOCK + hw - SIDEWALK - 0.2, z, SEED)).toBe('paving');
      expect(groundAt(line * BLOCK + hw - SIDEWALK + 0.2, z, SEED)).toBe('paving');
      expect(groundAt(line * BLOCK - hw + 0.2, z, SEED)).toBe('paving');
    }
  });

  it('finds the lawn, the gravel paths and the pond of a park', () => {
    const [bx, bz] = findBlock(BlockKind.Park);
    const cx = (bx + 0.5) * BLOCK;
    const cz = (bz + 0.5) * BLOCK;
    expect(groundAt(cx + 2, cz, SEED)).toBe('water');
    expect(groundAt(cx + 6.5, cz, SEED)).toBe('paving');
    expect(groundAt(cx + 11, cz, SEED)).toBe('gravel');
    expect(groundAt(cx + 15, cz + 15, SEED)).toBe('gravel');
    expect(groundAt(cx + 18, cz + 4, SEED)).toBe('grass');
    expect(greenAt(cx + 18, cz + 4, SEED)).toBe(1);
  });

  it('gives shelter against a facade and none in the road', () => {
    const [bx, bz] = findBlock(BlockKind.Perimeter);
    const hw = streetHalfWidth(bx);
    const z = (bz + 0.5) * BLOCK;
    const kerb = bx * BLOCK + hw;
    expect(shelterAt(kerb - 0.3, z, SEED)).toBeGreaterThan(0.95);
    expect(shelterAt(kerb - 1.8, z, SEED)).toBeGreaterThan(0.2);
    expect(shelterAt(kerb - 1.8, z, SEED)).toBeLessThan(0.8);
    expect(shelterAt(kerb - SIDEWALK + 0.1, z, SEED)).toBe(0);
    expect(shelterAt(bx * BLOCK, z, SEED)).toBe(0);
    // a park has no awnings
    const [px, pz] = findBlock(BlockKind.Park);
    expect(shelterAt(px * BLOCK + streetHalfWidth(px) - 0.3, (pz + 0.5) * BLOCK, SEED)).toBe(0);
  });

  it('hears more green near a park than deep among buildings', () => {
    expect(greenAt(0, 0, SEED)).toBe(0.8);
    for (let i = 0; i < 200; i++) {
      const g = greenAt(i * 37.3 - 3000, i * 53.9 - 4000, SEED);
      expect(g).toBeGreaterThanOrEqual(0.15);
      expect(g).toBeLessThanOrEqual(1);
    }
  });
});

describe('the beds', () => {
  it('gives each level and the hallway a bed of its own', () => {
    const city = heard(scene());
    const rain = heard(scene({ rain: 1 }));
    const snow = heard(scene({ snow: 1 }));
    const limbo = heard(scene({ limbo: 1, shore: 1 }));
    const hall = heard(scene({ hall: true }));
    expect(city[0]).toBe('city');
    expect(city).toContain('birds');
    expect(rain[0]).toBe('rain');
    expect(rain).not.toContain('birds');
    expect(snow[0]).toBe('wind');
    expect(snow).not.toContain('birds');
    expect(limbo[0]).toBe('sea');
    expect(limbo).not.toContain('city');
    expect(hall[0]).toBe('room');
    // no two alike
    const loudest = [city, rain, snow, limbo, hall].map((h) => h[0]);
    expect(new Set(loudest).size).toBe(5);
    // and only the hallway hums
    for (const s of [scene(), scene({ rain: 1 }), scene({ snow: 1 }), scene({ limbo: 1 })]) expect(mixBeds(s).room.gain).toBe(0);
  });

  it('moves the rain onto the awnings as the walker steps under them', () => {
    const open = mixBeds(scene({ rain: 1 }));
    const under = mixBeds(scene({ rain: 1, cover: 1 }));
    expect(open.cover.gain).toBe(0);
    expect(under.cover.gain).toBeGreaterThan(0.9);
    expect(under.rain.gain).toBeLessThan(open.rain.gain * 0.5);
    // the Architect is never under an awning
    expect(mixBeds(scene({ rain: 1, cover: 1, walking: false, altitude: 200 })).cover.gain).toBe(0);
  });

  it('sends the birds to bed at night and keeps them out of the weather', () => {
    expect(mixBeds(scene({ green: 1 })).birds.gain).toBe(1);
    expect(mixBeds(scene({ green: 1, night: 1 })).birds.gain).toBe(0);
    expect(mixBeds(scene({ green: 1, rain: 1 })).birds.gain).toBe(0);
    expect(mixBeds(scene({ green: 0.15 })).birds.gain).toBeLessThan(0.2);
    expect(mixBeds(scene({ night: 1 })).city.gain).toBeLessThan(mixBeds(scene()).city.gain);
  });

  it('lets the street fall away and the wind take over as the Architect climbs', () => {
    const low = mixBeds(scene({ walking: false, altitude: 20 }));
    const high = mixBeds(scene({ walking: false, altitude: 600 }));
    expect(high.city.gain).toBeLessThan(low.city.gain);
    expect(high.wind.gain).toBeGreaterThan(low.wind.gain + 0.3);
    expect(high.birds.gain).toBeLessThan(0.01);
    expect(high.city.cutoff).toBeLessThan(low.city.cutoff * 0.5);
  });

  it('shuts the outside out of the hallway, drags everything down in slow motion, and fades with the picture', () => {
    const out = mixBeds(scene());
    const hall = mixBeds(scene({ hall: true }));
    expect(hall.city.gain).toBeLessThan(out.city.gain * 0.5);
    expect(hall.city.cutoff).toBeLessThan(1000);
    expect(hall.room.cutoff).toBeGreaterThan(8000);
    const slow = mixBeds(scene({ slow: 0.15 }));
    expect(slow.city.cutoff).toBeLessThan(out.city.cutoff * 0.5);
    expect(bedRate(1)).toBe(1);
    expect(bedRate(0.15)).toBeLessThan(0.7);
    expect(bedRate(-1)).toBe(0.55);
    for (const name of BED_NAMES) {
      expect(mixBeds(scene({ rain: 1, hall: true, dim: 1 }))[name].gain).toBe(0);
      const g = mixBeds(scene({ rain: 1, snow: 1, limbo: 1, cover: 1, green: 1, shore: 1 }))[name].gain;
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });
});

describe('footsteps', () => {
  const dry = { snow: 0, wet: 0 };
  const wet = { snow: 0, wet: 1 };
  const snow = { snow: 1, wet: 0 };

  it('follow the surface', () => {
    expect(footing('paving', dry).set).toBe('stone');
    expect(footing('asphalt', dry).set).toBe('stone');
    expect(footing('asphalt', dry).tone).toBeLessThan(8000);
    expect(footing('grass', dry).set).toBe('grass');
    expect(footing('gravel', dry).set).toBe('gravel');
    expect(footing('water', dry).set).toBe('water');
  });

  it('follow the dream: a splash in the Rain, snow in the Snow, water where the sea has come in', () => {
    expect(footing('paving', dry).under).toBeUndefined();
    expect(footing('paving', wet)).toMatchObject({ set: 'stone', under: 'wet' });
    expect(footing('grass', wet)).toMatchObject({ set: 'grass', under: 'wet' });
    expect(footing('paving', snow).set).toBe('snow');
    expect(footing('grass', snow).set).toBe('snow');
    // the road is ploughed thin: stone can be heard through it
    expect(footing('asphalt', snow)).toMatchObject({ set: 'snow', under: 'stone' });
    expect(footing('paving', dry, 1).set).toBe('water');
    expect(footing('paving', snow, 1).set).toBe('water');
    expect(footing('paving', dry, 0.2).set).toBe('stone');
  });

  it('are carpet on the hallway floor and wood on its walls and ceiling', () => {
    expect(hallFooting(0).set).toBe('carpet');
    for (const face of [1, 2, 3]) expect(hallFooting(face).set).toBe('wood');
  });

  it('have a few takes of every surface in the recording, none overlapping', () => {
    const sets = SOUNDS.steps.sets;
    const spans: number[][] = [];
    for (const s of [footing('paving', dry), footing('grass', dry), footing('gravel', dry), footing('water', dry), footing('paving', wet), footing('paving', snow), hallFooting(0), hallFooting(1)]) {
      expect(sets[s.set].length).toBeGreaterThanOrEqual(3);
      if (s.under) expect(sets[s.under].length).toBeGreaterThanOrEqual(3);
    }
    for (const list of Object.values(sets)) for (const [start, length] of list) spans.push([start, start + length]);
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < spans.length; i++) {
      expect(spans[i][1] - spans[i][0]).toBeGreaterThan(0.04);
      expect(spans[i][1] - spans[i][0]).toBeLessThanOrEqual(0.6);
      if (i) expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1]);
    }
    expect(spans[spans.length - 1][1]).toBeLessThanOrEqual(SOUNDS.steps.seconds);
  });
});

describe('placing sounds around the head', () => {
  it('puts what is ahead ahead and what is to the right to the right, whichever way the listener faces', () => {
    const ear = { x: 0, z: 0 };
    // yaw 0 looks along +z; Web Audio's listener looks down -z with +x to its right
    toEar(0, 10, 0, ear);
    expect(ear.x).toBeCloseTo(0);
    expect(ear.z).toBeCloseTo(-10);
    // looking along +z, the walker's right hand is towards -x
    toEar(-10, 0, 0, ear);
    expect(ear.x).toBeCloseTo(10);
    expect(ear.z).toBeCloseTo(0);
    // turned to look along +x: +x is now ahead, +z to the right
    toEar(10, 0, Math.PI / 2, ear);
    expect(ear.x).toBeCloseTo(0);
    expect(ear.z).toBeCloseTo(-10);
    toEar(0, 10, Math.PI / 2, ear);
    expect(ear.x).toBeCloseTo(10);
    expect(ear.z).toBeCloseTo(0);
    // distance is kept
    toEar(3, -4, 1.234, ear);
    expect(Math.hypot(ear.x, ear.z)).toBeCloseTo(5);
  });

  it('boils a crowd down to a few voices that stand where the people are', () => {
    const voices: CrowdVoice[] = [];
    // nobody: silence
    crowdVoices(new Float32Array(0), 0, 0, 0, voices);
    expect(voices.length).toBe(CROWD_VOICES);
    for (const v of voices) expect(v.gain).toBe(0);
    // a knot of people to the east of a listener at (100, 50)
    const knot = new Float32Array(24);
    for (let i = 0; i < 12; i++) {
      knot[i * 2] = 100 + 8 + (i % 4);
      knot[i * 2 + 1] = 50 - 1 + (i % 3);
    }
    crowdVoices(knot, 12, 100, 50, voices);
    const loud = voices.filter((v) => v.gain > 0.5);
    expect(loud.length).toBeGreaterThanOrEqual(1);
    for (const v of loud) {
      expect(v.x).toBeGreaterThan(6);
      expect(v.x).toBeLessThan(13);
      expect(Math.abs(v.z)).toBeLessThan(3);
    }
    // the same knot far off is quieter, and out of earshot it is gone
    const total = () => voices.reduce((n, v) => n + v.gain, 0);
    const near = total();
    crowdVoices(knot, 12, 60, 50, voices);
    expect(total()).toBeLessThan(near * 0.6);
    expect(total()).toBeGreaterThan(0);
    crowdVoices(knot, 12, -100, 50, voices);
    expect(total()).toBe(0);
    // more people are louder, but never past 1
    const many = new Float32Array(400);
    for (let i = 0; i < 200; i++) {
      many[i * 2] = Math.cos(i) * (2 + (i % 9));
      many[i * 2 + 1] = Math.sin(i) * (2 + (i % 9));
    }
    crowdVoices(many, 200, 0, 0, voices);
    for (const v of voices) {
      expect(v.gain).toBeGreaterThan(0.9);
      expect(v.gain).toBeLessThanOrEqual(1);
      // and never inside the listener's head
      expect(Math.hypot(v.x, v.z)).toBeGreaterThanOrEqual(3 - 1e-6);
    }
  });
});

describe('loops', () => {
  it('close without a seam: the end runs on into the start as it ran on into the tail', () => {
    const loop = 4000;
    const tail = 500;
    // a slow tone that does not fit the loop, so a plain cut would jump
    const data = new Float32Array(loop + tail);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.0137 + 0.4);
    const out = makeLoop(data, loop, tail);
    expect(out.length).toBe(loop);
    const step = Math.abs(data[1] - data[0]) * 3 + 0.01;
    // across the seam (last sample to first) the jump is no bigger than between any two neighbours
    expect(Math.abs(out[0] - out[loop - 1])).toBeLessThan(step);
    expect(Math.abs(data[0] - data[loop - 1])).toBeGreaterThan(step * 3);
    for (let i = 1; i < loop; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(step);
    // past the crossfade the recording is untouched
    for (let i = tail; i < loop; i += 97) expect(out[i]).toBe(data[i]);
  });

  it('cope with a recording that came back short', () => {
    const data = new Float32Array(100).fill(0.5);
    expect(makeLoop(data, 400, 50).length).toBe(100);
    expect(makeLoop(data, 90, 50).length).toBe(90);
    expect(Array.from(makeLoop(data, 100, 0))).toEqual(Array.from(data));
  });
});

describe('the recordings', () => {
  const files = recordings.map((r) => r.file);

  it('come to less than 1.5 MB of Opus', () => {
    const total = recordings.reduce((n, r) => n + r.bytes, 0);
    expect(total).toBeGreaterThan(200 * 1024);
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
    for (const r of recordings) expect(r.head).toBe('OggS');
  });

  it('are the ones the manifest lists, no more and no fewer', () => {
    const listed = [...Object.values(SOUNDS.beds).map((b) => b.file), SOUNDS.steps.file];
    expect([...listed].sort()).toEqual([...files].sort());
    for (const [name, bed] of Object.entries(SOUNDS.beds)) {
      expect(bed.file).toBe(`${name}.opus`);
      expect(bed.seconds).toBeGreaterThan(4);
      expect(bed.tail).toBeGreaterThan(1);
      expect(bed.tail).toBeLessThan(bed.seconds);
    }
    // every recorded bed the mixer can ask for is there (the wind is made in code)
    for (const name of BED_NAMES) if (name !== 'wind') expect(SOUNDS.beds[name]).toBeDefined();
  });

  it('are all credited in ASSETS.md', () => {
    for (const file of files) expect(assets).toContain(file);
    for (const author of ['Ylmir', 'IgnasD', 'Thimras', 'RandomMind', 'LEGIT Audio', 'StarNinjas', 'Fantozzi', 'Corsica_S', 'rubberduck', 'HaelDB', 'OwlishMedia']) expect(assets).toContain(author);
    // and every download the pack script makes is on the list
    const urls = [...packScript.matchAll(/url: '([^']+)'/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(8);
    for (const url of new Set(urls)) expect(assets).toContain(url);
  });
});

describe('the crowd, heard', () => {
  it('reports the footfalls of people walking close to the dreamer, and nobody else’s', () => {
    const mat = new THREE.MeshBasicMaterial();
    const crowd = new Projections(mat, mat, 64);
    crowd.setCount(60, 0, 0);
    const collide = (x: number, z: number) => ({ x, z });
    const agents = (crowd as unknown as { agents: { x: number; z: number }[] }).agents;
    // with no dreamer there is nobody to hear them
    for (let i = 0; i < 120; i++) crowd.update(1 / 30, 0, 0, null, 0, collide);
    expect(crowd.footfalls.length).toBe(0);
    // stand the dreamer beside someone who is walking
    let steps = 0;
    for (let i = 0; i < 600; i++) {
      const dreamer = { x: agents[0].x + 2, z: agents[0].z };
      crowd.update(1 / 30, dreamer.x, dreamer.z, dreamer, 0, collide);
      expect(crowd.footfalls.length % 2).toBe(0);
      expect(crowd.footfalls.length).toBeLessThanOrEqual(16);
      for (let k = 0; k < crowd.footfalls.length; k += 2) {
        expect(Math.hypot(crowd.footfalls[k] - dreamer.x, crowd.footfalls[k + 1] - dreamer.z)).toBeLessThan(16.5);
        steps++;
      }
      crowd.footfalls.length = 0;
    }
    // twenty seconds beside a pedestrian: a good many steps, but not one a frame
    expect(steps).toBeGreaterThan(10);
    expect(steps).toBeLessThan(600);
  });

  it('says where the nearest people are', () => {
    const mat = new THREE.MeshBasicMaterial();
    const crowd = new Projections(mat, mat, 64);
    crowd.setCount(40, 0, 0);
    crowd.update(1 / 30, 0, 0, null, 0, (x, z) => ({ x, z }));
    const out = new Float32Array(20);
    expect(crowd.nearest(out)).toBe(10);
    const agents = (crowd as unknown as { agents: { x: number; z: number }[] }).agents;
    expect(out[0]).toBeCloseTo(agents[0].x, 4);
    expect(out[1]).toBeCloseTo(agents[0].z, 4);
    expect(crowd.nearest(new Float32Array(400))).toBe(40);
  });
});
