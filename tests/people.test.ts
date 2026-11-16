import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PERSON_VERT_HEAD } from '../src/city/shaders';
import { buildBody, CROWD_DETAIL, HERO_DETAIL, MAN, PIECE, pieceBit, wears, WOMAN } from '../src/people/body';
import { boneTexture, boneTextureSize, clipRow, crowdGeometry, guard, pedestrian, TARGET_OUTFIT } from '../src/people/crowd';
import { DREAMER_PIECES, wear } from '../src/people/figure';
import {
  bone,
  BONE_COUNT,
  BONE_PARENT,
  clip,
  CLIPS,
  GAIT_CLIPS,
  gaitWeights,
  newPose,
  restPose,
  samplePose,
  skinMatrices,
  strideAt,
  turnInBody,
  worldMatrices,
} from '../src/people/rig';
import { rng } from '../src/core/rng';
import { Projections } from '../src/world/projections';

/** Where a bone's joint is, in the body's frame. */
function joint(world: Float32Array, b: number): [number, number, number] {
  return [world[b * 12 + 3], world[b * 12 + 7], world[b * 12 + 11]];
}

describe('the shared skeleton', () => {
  it('lists every bone after its parent, from the hips', () => {
    expect(BONE_PARENT[0]).toBe(-1);
    for (let b = 1; b < BONE_COUNT; b++) {
      expect(BONE_PARENT[b]).toBeGreaterThanOrEqual(0);
      expect(BONE_PARENT[b]).toBeLessThan(b);
    }
  });

  it('stands in a T about a person tall, feet on the ground, and skins to itself at rest', () => {
    const world = worldMatrices(restPose(), new Float32Array(BONE_COUNT * 12));
    expect(joint(world, bone('head'))[1]).toBeGreaterThan(1.5);
    expect(joint(world, bone('head'))[1]).toBeLessThan(1.7);
    expect(joint(world, bone('toeL'))[1]).toBeLessThan(0.05);
    // the left arm lies along +x, the right along -x
    expect(joint(world, bone('handL'))[0]).toBeGreaterThan(0.6);
    expect(joint(world, bone('handR'))[0]).toBeLessThan(-0.6);
    const skin = skinMatrices(world, new Float32Array(BONE_COUNT * 12));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    for (let i = 0; i < skin.length; i++) expect(skin[i]).toBeCloseTo(identity[i % 12], 4);
  });

  it('decodes every clip to unit rotations, and loops close without a jump', () => {
    const a = newPose();
    const b = newPose();
    expect(CLIPS.length).toBeGreaterThanOrEqual(11);
    for (const c of CLIPS) {
      for (const u of [0, 0.13, 0.5, 0.77, 0.999]) {
        samplePose(c, u, a);
        for (let n = 0; n < BONE_COUNT; n++) expect(Math.hypot(a.q[n * 4], a.q[n * 4 + 1], a.q[n * 4 + 2], a.q[n * 4 + 3])).toBeCloseTo(1, 5);
      }
      if (!c.loop) continue;
      samplePose(c, 0, a);
      samplePose(c, 0.99999, b);
      for (let n = 0; n < BONE_COUNT; n++) {
        const dot = a.q[n * 4] * b.q[n * 4] + a.q[n * 4 + 1] * b.q[n * 4 + 1] + a.q[n * 4 + 2] * b.q[n * 4 + 2] + a.q[n * 4 + 3] * b.q[n * 4 + 3];
        expect(Math.abs(dot)).toBeGreaterThan(0.9999);
      }
      // a loop's phase wraps: one and a quarter cycles is a quarter of a cycle
      samplePose(c, 0.25, a);
      samplePose(c, 1.25, b);
      expect(Array.from(b.q)).toEqual(Array.from(a.q));
    }
  });

  it('turns a head in the body’s frame whatever the spine is doing', () => {
    const p = samplePose(clip('jog'), 0.3, newPose());
    const world = new Float32Array(BONE_COUNT * 12);
    const head = bone('head');
    const facing = () => {
      worldMatrices(p, world);
      const skin = skinMatrices(world, new Float32Array(BONE_COUNT * 12));
      // where the rest pose's +z ends up
      return new THREE.Vector3(skin[head * 12 + 2], skin[head * 12 + 6], skin[head * 12 + 10]);
    };
    const before = facing();
    const half = 0.35;
    turnInBody(p, head, 0, Math.sin(half), 0, Math.cos(half));
    const after = facing();
    const want = before.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), half * 2);
    expect(after.distanceTo(want)).toBeLessThan(1e-5);
  });
});

describe('walking and running', () => {
  it('mixes the walking clips in shares that add up to one and change smoothly', () => {
    let last = gaitWeights(0);
    for (let v = 0; v <= 14; v += 0.05) {
      const w = gaitWeights(v);
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 9);
      for (let i = 0; i < 3; i++) {
        expect(w[i]).toBeGreaterThanOrEqual(0);
        expect(Math.abs(w[i] - last[i])).toBeLessThan(0.08);
      }
      last = w;
    }
    expect(gaitWeights(0.5)).toEqual([1, 0, 0]);
    expect(gaitWeights(5.9)[1]).toBeGreaterThan(0.95);
    expect(gaitWeights(13)[2]).toBe(1);
  });

  it('lengthens the stride with speed, without a jump', () => {
    let last = strideAt(0);
    for (let v = 0; v <= 14; v += 0.05) {
      const s = strideAt(v);
      expect(s).toBeGreaterThanOrEqual(last - 1e-9);
      expect(s - last).toBeLessThan(0.2);
      last = s;
    }
  });

  it('keeps planted feet still on the ground: a stride of the clip covers its stride of pavement', () => {
    const pose = newPose();
    const world = new Float32Array(BONE_COUNT * 12);
    for (const c of [...GAIT_CLIPS, clip('walk')]) {
      expect(c.stride).toBeGreaterThan(1);
      // while the ball of a foot is down, the body passes over it: it moves back under the hips at the walker's speed
      const at = (u: number, side = 'L') => joint(worldMatrices(samplePose(c, u, pose), world), bone(`toe${side}` as 'toeL'));
      let sum = 0;
      let n = 0;
      for (const side of ['L', 'R']) {
        let low = Infinity;
        for (let f = 0; f < c.frames; f++) low = Math.min(low, at(f / c.frames, side)[1]);
        for (let f = 0; f < c.frames; f++) {
          const a = at(f / c.frames, side);
          const b = at((f + 1) / c.frames, side);
          if (a[1] < low + 0.012 && b[1] < low + 0.012) {
            sum += (a[2] - b[2]) * c.frames;
            n++;
          }
        }
      }
      expect(n).toBeGreaterThanOrEqual(2);
      // metres a cycle while planted = the stride the walkers are moved by
      expect(sum / n / c.stride!).toBeGreaterThan(0.97);
      expect(sum / n / c.stride!).toBeLessThan(1.03);
      // and they all start as the left foot lands, so they can be blended frame for frame
      expect(at(0)[2]).toBeGreaterThan(at(0.5)[2]);
    }
  });
});

describe('bodies built in code', () => {
  it('gives every vertex bones that exist and weights that add up to one', () => {
    for (const detail of [CROWD_DETAIL, HERO_DETAIL]) {
      for (const shape of [MAN, WOMAN]) {
        const m = buildBody(shape, detail);
        const n = m.position.length / 3;
        expect(m.normal.length).toBe(n * 3);
        for (let v = 0; v < n; v++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            expect(m.bones[v * 4 + k]).toBeLessThan(BONE_COUNT);
            expect(m.weights[v * 4 + k]).toBeGreaterThanOrEqual(0);
            sum += m.weights[v * 4 + k];
          }
          expect(sum).toBeCloseTo(1, 5);
          expect(Number.isFinite(m.position[v * 3] + m.position[v * 3 + 1] + m.position[v * 3 + 2])).toBe(true);
          expect(Math.hypot(m.normal[v * 3], m.normal[v * 3 + 1], m.normal[v * 3 + 2])).toBeCloseTo(1, 4);
        }
        for (const i of m.index) expect(i).toBeLessThan(n);
        // a triangle belongs to one piece, so a piece can be taken off whole
        for (let t = 0; t < m.index.length; t += 3) {
          expect(m.piece[m.index[t + 1]]).toBe(m.piece[m.index[t]]);
          expect(m.piece[m.index[t + 2]]).toBe(m.piece[m.index[t]]);
        }
      }
    }
  });

  it('builds the man and the woman from the same vertices, so one morphs into the other', () => {
    for (const detail of [CROWD_DETAIL, HERO_DETAIL]) {
      const m = buildBody(MAN, detail);
      const w = buildBody(WOMAN, detail);
      expect(w.position.length).toBe(m.position.length);
      expect(Array.from(w.index)).toEqual(Array.from(m.index));
      expect(Array.from(w.piece)).toEqual(Array.from(m.piece));
      expect(Array.from(w.bones)).toEqual(Array.from(m.bones));
    }
  });

  it('keeps the crowd’s body light: two bones a vertex, and few triangles', () => {
    const m = buildBody(MAN, CROWD_DETAIL);
    const n = m.position.length / 3;
    for (let v = 0; v < n; v++) expect(m.weights[v * 4 + 2]).toBe(0);
    expect(n).toBeLessThan(800);
    expect(m.index.length / 3).toBeLessThan(1300);
    // the dreamer is seen close up and gets several times as much
    expect(buildBody(MAN, HERO_DETAIL).index.length).toBeGreaterThan(m.index.length * 3);
  });

  it('dresses the dreamer in a suit: no hat, no skirt, no bag', () => {
    const all = buildBody(MAN, HERO_DETAIL);
    const worn = wear(all, DREAMER_PIECES);
    expect(worn.index.length).toBeLessThan(all.index.length);
    const pieces = new Set(Array.from(worn.index, (i) => worn.piece[i]));
    expect([...pieces].sort()).toEqual([PIECE.always, PIECE.shirtFront, PIECE.shortHair]);
    // thighs go under a skirt and nowhere else
    expect(wears(pieceBit(PIECE.skirt), PIECE.thighs)).toBe(false);
    expect(wears(pieceBit(PIECE.coat), PIECE.thighs)).toBe(true);
  });
});

describe('the crowd', () => {
  it('bakes each clip into rows of the bone texture, and finds the row for a phase', () => {
    const { width, height } = boneTextureSize();
    expect(width).toBe(BONE_COUNT * 3);
    const tex = boneTexture();
    expect(tex.image.width).toBe(width);
    expect(tex.image.height).toBe(height);
    const data = tex.image.data as Uint16Array;
    const pose = newPose();
    const world = new Float32Array(BONE_COUNT * 12);
    const skin = new Float32Array(BONE_COUNT * 12);
    for (const name of ['idle', 'walk', 'stroll', 'jog', 'talk'] as const) {
      const c = clip(name);
      const row0 = clipRow(name, 0);
      expect(Number.isInteger(row0)).toBe(true);
      // a loop runs from its first row to one past its last frame, where the first frame is repeated
      expect(clipRow(name, 0.999999)).toBeLessThan(row0 + c.frames);
      expect(clipRow(name, 0.999999)).toBeGreaterThan(row0 + c.frames - 0.01);
      expect(clipRow(name, 2.5)).toBeCloseTo(row0 + c.frames / 2, 9);
      expect(row0 + c.frames).toBeLessThan(height);
      // row 0 holds frame 0's skinning matrices, to half-float precision
      skinMatrices(worldMatrices(samplePose(c, 0, pose), world), skin);
      for (const row of [row0, row0 + c.frames]) {
        for (let i = 0; i < BONE_COUNT * 12; i++) {
          expect(THREE.DataUtils.fromHalfFloat(data[row * width * 4 + i])).toBeCloseTo(skin[i], 2);
        }
      }
    }
    expect(() => clipRow('sprint', 0)).toThrow();
  });

  it('carries the morph to the woman and what each vertex is', () => {
    const g = crowdGeometry();
    const n = g.getAttribute('position').count;
    for (const name of ['normal', 'aMorph', 'aSkin', 'aInfo']) expect(g.getAttribute(name).count).toBe(n);
    const skin = g.getAttribute('aSkin');
    const info = g.getAttribute('aInfo');
    for (let v = 0; v < n; v++) {
      expect(skin.getX(v)).toBeLessThan(BONE_COUNT);
      expect(skin.getY(v)).toBeLessThan(BONE_COUNT);
      expect(skin.getZ(v)).toBeGreaterThanOrEqual(0.5);
      expect(skin.getZ(v)).toBeLessThanOrEqual(1);
      expect(info.getY(v)).toBeLessThanOrEqual(PIECE.thighs);
    }
    // the shader tests pieces by number: the numbers it was written with are the builder's
    expect(PERSON_VERT_HEAD).toContain(`piece == ${PIECE.thighs}`);
    expect(PERSON_VERT_HEAD).not.toMatch(/undefined|NaN/);
  });

  it('dresses pedestrians differently, each in clothes that make sense', () => {
    const r = rng(99);
    const looks = new Set<string>();
    let women = 0;
    for (let i = 0; i < 400; i++) {
      const o = pedestrian(r);
      const has = (p: number) => (o.pieces & pieceBit(p)) !== 0;
      // one head of hair
      expect(has(PIECE.longHair)).not.toBe(has(PIECE.shortHair));
      // a skirt or a long coat, not both
      expect(has(PIECE.skirt) && has(PIECE.coat)).toBe(false);
      expect(o.pieces).toBeLessThan(128);
      expect(o.scale).toBeGreaterThan(0.8);
      expect(o.scale).toBeLessThan(1.05);
      for (const c of [...o.jacket, ...o.lower, ...o.accent, o.skin, o.hair, o.hose, o.build]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      if (o.build > 0.5) women++;
      else expect(has(PIECE.skirt)).toBe(false);
      looks.add(`${o.pieces}|${o.jacket.map((v) => v.toFixed(2)).join()}`);
    }
    expect(women).toBeGreaterThan(120);
    expect(women).toBeLessThan(260);
    expect(looks.size).toBeGreaterThan(60);
    // the guards wear one suit; the target a hat and a long coat
    const g = [guard(r), guard(r), guard(r)];
    expect(new Set(g.map((o) => o.jacket.join())).size).toBe(1);
    expect(TARGET_OUTFIT.pieces & pieceBit(PIECE.hat)).toBeTruthy();
  });

  it('walks without sliding: each pedestrian’s stride advances with the pavement they cover', () => {
    const mat = new THREE.MeshBasicMaterial();
    const crowd = new Projections(mat, mat, 64);
    crowd.setCount(40, 0, 0);
    const agents = (crowd as unknown as { agents: { x: number; z: number; phase: number; walk: 'walk' | 'stroll'; clip: string; rest: number; outfit: object }[] }).agents;
    const collide = (x: number, z: number) => ({ x, z });
    const watched = agents.filter((a) => a.rest <= 0).slice(0, 12);
    expect(watched.length).toBeGreaterThan(6);
    for (const a of watched) {
      let walked = 0;
      const phase0 = a.phase;
      for (let i = 0; i < 20; i++) {
        const [x, z] = [a.x, a.z];
        crowd.update(1 / 60, 0, 0, null, 0, collide);
        if (a.rest > 0 || a.clip !== a.walk) break;
        walked += Math.hypot(a.x - x, a.z - z);
      }
      if (a.rest > 0 || a.clip !== a.walk) continue;
      expect(walked).toBeGreaterThan(0.2);
      // (a corner cuts a step short on the pavement but not in the stride: allow a step's worth)
      expect((a.phase - phase0) * clip(a.walk).stride!).toBeGreaterThan(walked - 1e-6);
      expect((a.phase - phase0) * clip(a.walk).stride!).toBeLessThan(walked + 0.04);
    }
    expect(crowd.people.count).toBe(40);
    // nearest first, and only the near ones cast shadows
    for (let i = 1; i < agents.length; i++) expect((agents[i] as unknown as { away: number }).away).toBeGreaterThanOrEqual((agents[i - 1] as unknown as { away: number }).away - 3);
    expect(crowd.people.shadows).toBeLessThanOrEqual(40);
  });

  it('stops to stare when the dream turns unstable, and runs the dreamer down when it turns worse', () => {
    const mat = new THREE.MeshBasicMaterial();
    const crowd = new Projections(mat, mat, 64, { zeal: 1, near: 400, far: 500 });
    crowd.setCount(30, 0, 0);
    const agents = (crowd as unknown as { agents: { clip: string; look: number; suspicion: number }[] }).agents;
    const collide = (x: number, z: number) => ({ x, z });
    const dreamer = { x: 3, z: 3 };
    for (let i = 0; i < 200; i++) crowd.update(0.05, 0, 0, dreamer, 0.5, collide);
    expect(crowd.watching).toBe(30);
    expect(crowd.hunting).toBe(0);
    for (const a of agents) expect(a.clip).toBe('idle');
    for (let i = 0; i < 60; i++) crowd.update(0.05, 0, 0, dreamer, 1, collide);
    expect(crowd.hunting).toBeGreaterThan(20);
    expect(agents.filter((a) => a.clip === 'jog').length).toBe(crowd.hunting);
    crowd.calm();
    for (let i = 0; i < 40; i++) crowd.update(0.05, 0, 0, dreamer, 0, collide);
    expect(crowd.hunting).toBe(0);
    for (const a of agents) expect(['walk', 'stroll', 'idle', 'talk']).toContain(a.clip);
  });
});
