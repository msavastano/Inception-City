import * as THREE from 'three';
import { foldedDepthMaterial, foldedMaterial, U } from './city/materials';
import { rng } from './core/rng';
import { guard, pedestrian, People, TARGET_OUTFIT } from './people/crowd';
import { Figure } from './people/figure';
import { ClipName, CLIPS, clip, newPose, samplePose } from './people/rig';

/**
 * The people lab: a dev-only page (npm run dev, then /lab.html) for looking at
 * the bodies and the clips on their own, out of the city. Not part of the build.
 *
 *   /lab.html#clip=jog            one clip, playing
 *   /lab.html#clip=jog&u=0.25     frozen at a phase (for screenshots)
 *   /lab.html#yaw=140&zoom=1.6    camera
 *   /lab.html#sheet               the figure from four sides in the rest pose
 *   /lab.html#cast                a line-up of the crowd, drawn the way the city draws it
 *   /lab.html#cast&seed=7&look=0.8&sus=0.9    other people, heads turned, suspicious
 */
const params = new URLSearchParams(location.hash.slice(1));
const canvas = document.getElementById('lab') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8f959c);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
scene.add(sun, new THREE.HemisphereLight(0xcfe0ff, 0x5a544c, 1.5));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a9c9e, roughness: 0.95 }));
floor.receiveShadow = true;
scene.add(floor);

const sheet = params.has('sheet');
const which = (params.get('clip') ?? 'idle') as ClipName;
const frozen = params.has('u') ? Number(params.get('u')) : null;
const figures: { f: Figure; clip: ClipName | null; offset: number }[] = [];
if (sheet) {
  [0, 90, 180, 270].forEach((deg, i) => {
    const f = new Figure();
    f.mesh.position.x = (i - 1.5) * 2.1;
    f.mesh.rotation.y = (deg * Math.PI) / 180;
    figures.push({ f, clip: params.has('clip') ? which : null, offset: 0 });
  });
} else if (params.has('all')) {
  CLIPS.forEach((c, i) => {
    const f = new Figure();
    f.mesh.position.x = (i - (CLIPS.length - 1) / 2) * 1.2;
    figures.push({ f, clip: c.name as ClipName, offset: 0 });
  });
} else {
  figures.push({ f: new Figure(), clip: which, offset: 0 });
}
for (const { f } of figures) scene.add(f.mesh);

// the crowd, through its own material: two rows of pedestrians, then the guards and the target
const cast = params.has('cast');
let people: People | null = null;
const castClips: ClipName[] = ['stroll', 'walk', 'idle', 'talk', 'jog'];
const CAST = 20;
if (cast) {
  for (const { f } of figures) scene.remove(f.mesh);
  figures.length = 0;
  people = new People(foldedMaterial('person'), foldedDepthMaterial('person'), CAST);
  people.count = CAST;
  const r = rng(Number(params.get('seed') ?? 1));
  for (let i = 0; i < CAST; i++) people.dress(i, i === CAST - 1 ? TARGET_OUTFIT : i >= CAST - 3 ? guard(r) : pedestrian(r));
  scene.add(people.mesh);
}

const yaw = (Number(params.get('yaw') ?? 25) * Math.PI) / 180;
const zoom = Number(params.get('zoom') ?? 1);
const span = sheet ? 9.4 : params.has('all') ? 15 : cast ? 13.5 : 5.4;
const height = Number(params.get('h') ?? 0.95);
camera.position.set(Math.sin(yaw) * span * zoom, height + 0.35 * zoom, Math.cos(yaw) * span * zoom);
camera.lookAt(0, height, 0);

const pose = newPose();
const clock = new THREE.Clock();
function frame(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const t = clock.getElapsedTime();
  for (const fig of figures) {
    if (!fig.clip) continue;
    const c = clip(fig.clip);
    fig.f.pose(samplePose(c, frozen ?? (c.loop ? t / c.duration : (t % (c.duration + 0.6)) / c.duration), pose));
  }
  if (people) {
    U.uTime.value = t;
    for (let i = 0; i < CAST; i++) {
      const name = params.has('clip') ? which : castClips[i % castClips.length];
      const c = clip(name);
      people.stand(i, {
        x: ((i % 10) - 4.5) * 1.05,
        y: 0,
        z: i < 10 ? 0.9 : -0.9,
        yaw: Number(params.get('turn') ?? 0),
        clip: name,
        phase: frozen ?? t / c.duration + i * 0.37,
        look: Number(params.get('look') ?? 0),
        suspicion: Number(params.get('sus') ?? 0),
      });
    }
    people.commit();
  }
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);
document.getElementById('help')!.textContent = `clips: ${CLIPS.map((c) => c.name).join(', ')} · #clip=, #u=, #yaw=, #zoom=, #h=, #sheet, #all, #cast (&seed=, &look=, &sus=, &turn=)`;
(window as unknown as { labReady: boolean }).labReady = true;
