# Inception City: the plan

> "You create the world of the dream. You bring the subject into that dream, and they fill it with their subconscious."

This document is the world bible and the engineering plan in one place. The first half describes the city as a place: its districts, the rules of the dream and the two ways to be in it. The second half explains how it is built so that it can keep growing without slowing down.

---

## 1. The idea in one paragraph

Inception City is a Paris-like city printed on a sheet of fabric. Every street is a potential hinge. An architect can grab the city and fold it, rolling whole districts up into the sky until they hang upside down overhead, and a dreamer can walk through the result on foot, up the curl and onto the ceiling, because gravity in a dream follows the street, not the planet. Push the dream too far and its projections notice you. Go deeper and time stretches, the weather turns, and eventually the city crumbles into the sea of Limbo.

---

## 2. The city

### 2.1 Layout

The city is an endless Manhattan-style grid laid out in fabric space (the flat sheet before any folding).

| Element | Size | Notes |
| --- | --- | --- |
| Block | 64 m | Street centrelines every 64 m in both directions |
| Street | 14 m kerb to kerb | 3 m sidewalks either side |
| Boulevard | 24 m | Every fourth line, tree-lined on both sides |
| Chunk | 256 m (4 × 4 blocks) | The unit of generation, streaming and memory |

Because hinges snap to street lines, a fold always lands in the open, never through a building. That one constraint is what makes folds read as architecture rather than as damage.

### 2.2 Districts

Districts are not hand-placed. Two low-frequency noise fields ("downtown" and "old town") paint the grid, so every seed produces a different but coherent city.

- **The Circus.** The four blocks around the origin form a round plaza with the city's monument at its centre: a 30 m spinning top, balanced on its point. It is the dream's anchor. Every fold is ordered relative to it, and the HUD totem mirrors it: steady when the dream is stable, wobbling when it is not.
- **Haussmann core.** Six-storey limestone perimeter blocks with shopfronts and coloured awnings, continuous wrought-iron balconies on the second and fifth floors, zinc mansard roofs with dormers, and forests of chimney pots. This is the Paris of the film.
- **Old town brick.** Narrower lots, red pitched roofs, white window trim, one chimney each. Patches of it break up the stone.
- **Downtown.** Glass curtain walls and modernist concrete towers with setback crowns, away from the centre. When the city folds, these are the stalactites hanging from the sky.
- **Parks and plazas.** Green blocks follow their own noise field, so they cluster into something like a Tuileries rather than scattering as single squares.
- **The Limbo shore.** On the deepest level the edges of the city sink. Beyond about 260 m from the Circus, towers lean and slide into a grey sea, and past 820 m there is only water and ruins.

### 2.3 Street furniture

Boulevards carry plane trees. Every street has lamps on both sides at a fixed rhythm (every 32 m), which at night lay pools of warm light on the pavement. Zebra crossings mark every intersection, and they double as the projections' crossing points.

---

## 3. The rules of the dream

1. **Streets are hinges.** Any street can become a fold line. A fold has a hinge, a direction, an angle and a radius. Up to eight folds can be alive at once.
2. **Gravity follows the fabric.** Anything standing on the city (a dreamer, a projection, a tree) is attached to the sheet. Walk towards a fold and the road simply rises ahead of you into a wall and then a ceiling, and you keep walking. The one exception is the rotating hallway (4.3): inside it, gravity points down at the real ground, and the corridor turns around you.
3. **Paper physics.** Parallel folds nest: a fold further from the Circus is carried along by a nearer one, like rolling up a carpet. Crossing folds cut the sheet the way you cut the corners out of paper before folding it into a box, so nothing has to stretch.
4. **The dream pushes back.** Every fold costs stability. Fast, violent folding costs more. The totem wobbles, the picture shakes and splits into colour fringes, and the projections start to stare.
5. **Projections defend the dreamer's mind.** Calm projections walk the sidewalks. As stability falls they stop and turn to look at you. When it collapses they hunt. If they reach you, you are kicked out.
6. **The kick.** A kick (the K key, or being caught) collapses every fold at once with a ripple through the ground and a BRAAAM. In first person, a kick also wakes you up one level. Afterwards the dream is calm: stability is back to full while the city unwinds, and the projections forget you.
7. **Time dilates with depth.** Each level runs faster than the one above. The HUD shows real time next to dream time.

### 3.1 Dream levels

| Level | Name | Dream seconds per real second | Mood |
| --- | --- | --- | --- |
| 1 | The City | 20 | Clear Paris morning, warm stone, saturated grade |
| 2 | Rain | 400 | Dusk, wet reflective streets, cold grade, autumn trees, restless crowd |
| 3 | Snow | 8,000 | White silence, snow on every roof and pavement, a lower drone |
| 4 | Limbo | ∞ | Washed-out colour, falling ash, a city crumbling into the sea |

Each level has its own palette for day and night, weather, colour grade and ambient drone pitch. The time-of-day slider runs from noon to midnight on every level, and at night roughly a third of the windows light up.

---

## 4. Two ways to be in the city

### 4.1 Architect (third person)

The architect looks down on the city like a model on a table.

- **Fold:** press on a street and drag. The hinge forms under your cursor, perpendicular to the direction you drag. The further you drag, the further it bends, up to 180°. With *Snap creases to streets* on, the hinge locks to the nearest street and the direction locks to the grid. Hold Shift to fold downwards into the ground.
- **Raise:** paint over blocks to grow or shrink buildings. Edits stick to the block even when it streams out and back in.
- **Orbit:** a plain camera, for looking without touching anything.
- **Dreamscapes:** six presets that each make a point about the fold algebra, or break it.
  - *The Paris Fold:* the film's shot. Half the city hangs overhead.
  - *Double Fold:* two opposite curls, two skies made of streets.
  - *The Scroll:* four nested quarter-folds roll the city up like a carpet.
  - *Escher Steps:* alternating up and down folds turn districts into a staircase.
  - *City in a Box:* four walls stand up, and the crossing-fold cut keeps the corners clean.
  - *The Hallway:* a hotel corridor turning like a barrel on the boulevard. Walk in at either end.
- **Fold list:** every fold is listed with its direction and a live angle slider, so you can sculpt after the fact. Undo removes the newest fold.
- **Share:** the whole dream (seed, level, time, folds and quality) fits in the URL hash, so a link reproduces exactly what you see.

### 4.2 Dream Walk (first person)

The dreamer is dropped onto a sidewalk at street level.

- WASD or arrows to walk, Shift to run, Space to jump. Mouse look with pointer lock, or drag to look where pointer lock is not available.
- **F** folds the street ahead of you upwards, so you can watch the road rise into a wall and then walk up it.
- **V** drops the street ahead away into a downward fold.
- **E** rides the fold: the street you are standing on folds up and over the city and carries you with it, until you hang upside down 96 m above the districts behind you. **E** again lowers you back down.
- **H** raises the rotating hallway around you on the nearest street. Press it again, or kick, to let it go.
- **K** is the kick. **Q** wakes you up into architect mode. **Esc** pauses.
- On touch screens, a left-thumb stick walks, dragging anywhere else looks, and on-screen buttons jump, fold, ride, raise the hallway, kick and wake.
- Buildings, trees, lamps and the monument are solid. Footsteps follow your pace.

Switching between the two (Tab) is a camera flight, not a cut: the architect's view swoops down to the dreamer's eye, and back up again.

### 4.3 The rotating hallway

The hotel corridor from the film: 7 m square, 64 m long, red carpet, doors every 8 m. It rises out of the street, hangs with its axis just high enough that its corners clear the ground, and turns like a barrel. The spin is not steady. It follows a few incommensurate sine waves, so it surges and slackens like a van swerving on the level above.

It is the one place where gravity does not follow the fabric. The dreamer inside is simulated in the corridor's own frame with real gravity pointing at the ground:

- **Three frames.** Fabric (where the corridor sits on the sheet), the corridor frame carried through any folds at the corridor's centre (so a hallway on a folded street hangs at the fold's angle), and spin space, the corridor frame turned by the current angle, in which the walls never move.
- **Walls carry you.** A wall you stand on moves you with it exactly, so a slow turn walks you up the floor. Static friction holds until the floor tilts past about 31°, then you slide into the corner and onto the next wall, which becomes the floor.
- **The camera follows the wall.** The view's up eases toward the wall you are standing on, so the corridor stays steady and the world outside the open ends turns instead. In the air it swings back toward the real sky.
- **Ends are open.** Walk out of either end and you drop back onto the street, carrying your speed. Walk into an open end and the corridor takes you in.

The physics is pinned by `tests/hallway.test.ts`: standing still, a minute of tumbling that never leaves the walls and visits all four, the grip-then-slide angle, and walking out.

### 4.4 Riding the fold

**E** turns the fold algebra into a lift. The hinge goes on the first street at least π·48 + 12 m behind you, with the page facing forward and a 48 m radius. That distance matters: everything closer than π·R to the hinge is wrapped around the curl, everything beyond it is the rigid page. So you never ride the bend itself; you stand on a flat street that swings up and over like a turning page, and at 180° you are upside down at exactly 2R = 96 m, looking up at the city below. The fold uses a slower spring than F, the field of view widens while it moves, and gravity following the fabric means you can walk around up there.

---

## 5. How it is built

The stack is TypeScript, Three.js (WebGL 2) and Vite, with Vitest for the maths. There are no textures and no models to download. Every brick, window, awning, cobble, cloud and sound is generated in code from the seed.

### 5.1 The key idea: fabric space and world space

Everything is simulated on the flat sheet (fabric space): generation, collision, the crowd, the dreamer's footsteps and the streaming decisions. Folding is a pure presentation transform, applied in the vertex shader on the GPU, with an exact CPU mirror for the few things that need world positions (the camera, picking, and deciding what is close enough to load).

This separation is what makes the whole thing tractable. The crowd does not know the city is folded. The dreamer's physics is the physics of walking on a flat street. Folding a district costs nothing on the CPU, because nothing on the CPU moves.

### 5.2 The fold algebra

A fold has a hinge point **h**, a unit normal **n** (pointing at the side that moves), an angle θ and a radius R. For a fabric point at distance d = (p − h)·n past the hinge, the fold is a rigid transform:

```
M(d) = T(C) · Rot_n(a) · T(−C) · T(−min(d, L)·n)

a = sign(θ) · min(d / R, |θ|)      the bend so far
L = R · |θ|                          the length of the curl
C = h + sign(θ) · R · up             the centre of the curl cylinder
```

Points before the hinge do not move. Points inside the curl wrap around a cylinder of radius R. Points past the curl continue as a rigid flat sheet at angle θ. Three properties follow:

- **Continuity.** M is continuous in d, so the sheet never tears.
- **Isometry.** The street surface is mapped without stretching. A 100 m walk on the flat is a 100 m walk on the folded city, which is why the dreamer can walk up a curl without any special-case code.
- **Composability.** Folds are sorted by their distance from the Circus and applied in that order, so a nearer fold carries a further one along rigidly, like paper. Nested folds compose as plain matrix products.

Folds whose normals differ by more than about 25° are treated as crossing. The first fold to move a point claims it, and a later crossing fold leaves that point alone, which cuts the sheet along the diagonal exactly like the corners of a paper box.

`src/core/fold.ts` is the CPU implementation and `src/city/shaders.ts` holds the GLSL twin. `tests/fold.test.ts` pins identity, continuity, isometry, nesting, the crossing cut, the spring and serialisation.

### 5.3 Frame anatomy

```mermaid
flowchart LR
  subgraph CPU["CPU (fabric space)"]
    Input[Pointer, keys, touch] --> Modes[Architect / Dream Walk]
    Modes --> Folds[FoldStack<br/>spring-animated folds]
    Modes --> Walker[Dreamer physics]
    Folds --> Stream[Chunk streamer]
    Gen[Deterministic chunk generator] --> Stream
    Stream --> Slabs[Slab allocator<br/>instanced attributes]
    Crowd[Projections crowd] --> Slabs
  end
  subgraph GPU["GPU (world space)"]
    Slabs --> VS[Vertex shaders<br/>fold + ripple + limbo]
    Folds -->|8 folds as uniforms| VS
    VS --> FS[Procedural shading<br/>facades, ground, creases]
    FS --> Post[Bloom, grade, grain]
  end
  Walker -->|folded eye position| Camera
  Camera --> VS
  Pick[GPU picking<br/>fabric coords] --> Modes
```

### 5.4 Picking a folded city

Ray casting against a folded city on the CPU would mean folding every vertex twice. Instead the scene is re-rendered into a 1 × 1 float render target under the cursor with pick materials that output the fabric coordinates of whatever is visible. The result is exact on curls, ceilings and walls, and costs one tiny draw per click. If float render targets are not available the picker falls back to the ground plane.

---

## 6. Scaling

The goal is a city that is effectively infinite, foldable in real time, and still smooth on a phone. Each of the decisions below exists to keep one cost constant as the city grows.

### 6.1 Deterministic generation

Every chunk is a pure function of (chunk x, chunk z, seed). Nothing is stored. A chunk can be thrown away and regenerated identically, which means memory is bounded by what is visible rather than by what has been visited. The only persistent per-block state is the architect's raise-brush edits, held in a small sparse map.

### 6.2 Streaming after folding

Candidate chunks are enumerated in fabric space around the camera's fabric focus. The decision to load is made on each chunk's **world** distance after folding. This matters: under the Paris fold, chunks that are 800 m away on the sheet are hanging 200 m above your head, so they must be loaded even though a flat distance check would drop them. Chunks are loaded nearest-first under a per-frame budget so a big fold never causes a hitch, and new chunks rise out of the ground rather than popping in.

### 6.3 Constant draw calls

Each kind of object (buildings, roofs and chimneys, fine ground, coarse ground, trees, lamps, the crowd, the monument) is a single instanced mesh. Each loaded chunk owns one fixed-size slab of instances in each mesh (224 buildings, 288 roof pieces, 128 trees, 128 lamps). Loading a chunk writes its slab and uploads just that range. Unloading zeroes it. Empty slots collapse to a point in the vertex shader before any fold maths runs.

The result is about eleven draw calls for the whole city, whether it has two thousand buildings or twenty thousand.

### 6.4 Level of detail

- **Ground tiles** come in two tessellations. Only chunks crossed by a curl get the fine 40 × 40 grid needed to bend smoothly. Everywhere else a 2 × 2 tile is enough.
- **Props** (trees and lamps) are only written for chunks inside a smaller ring around the viewer, with their own budget per frame.
- **Facades** fade their window pattern to its average colour once a window is only a few pixels wide, which removes moiré without textures or mipmaps.
- **The crowd** is a single instanced mesh. Its size follows the quality tier, from 180 to 900 people.

### 6.5 No textures

All surface detail comes from procedural shading: limestone courses, shopfronts and awnings, balconies, cornices, brick bonding, curtain-wall mullions, mansard zinc, snow cover, wet sheen, crosswalks, park paths, lamp pools, glowing crease lines and the glowing lattice on the underside of a fold. The build ships no image assets at all. The whole app, including the 3D engine, is about 680 kB of JavaScript (about 180 kB gzipped).

### 6.6 Bounded fold cost

Fold state is two arrays of eight vec4 uniforms. Every vertex pays for at most eight folds, and the loop exits early for points before a hinge. Shadows use depth materials with the same fold, so shadows bend with the city at no extra CPU cost.

### 6.7 Adaptive quality

Four tiers (low, medium, high, ultra) set pixel ratio, shadow map size and extent, bloom, view distance, prop distance, chunk cap and crowd size. The app starts from a guess based on the device and then watches the frame rate, stepping down a tier when it drops below about 38 fps and back up (as far as High) when it holds above 57 fps. Ultra is opt-in from the panel, and `#q=` in the URL pins any tier.

| Tier | Pixel ratio | Shadows | Bloom | View distance | Chunk cap | Crowd |
| --- | --- | --- | --- | --- | --- | --- |
| Ultra | 2 | 4096 | yes | 1300 m | 150 | 900 |
| High | 1.5 | 2048 | yes | 1050 m | 120 | 600 |
| Medium | 1 | 2048 | yes | 820 m | 90 | 400 |
| Low | 0.75 | off | no | 620 m | 60 | 180 |

### 6.8 State that fits in a link

A whole dream is a seed, a level, a time of day and at most eight folds of six numbers each. That fits in a URL hash with room to spare, so every view is shareable and reproducible. It is also the foundation for multiplayer (below): because the world is deterministic, peers only ever need to exchange the fold log, never geometry.

---

## 7. Where it goes next

### Milestone 1: the playable dream (done)
- Endless procedural Paris with five districts and the Circus monument
- Architect mode with folds, raise brush, five dreamscapes and shareable links
- Dream Walk with fabric-space physics, walking up curls and the kick
- Four dream levels with weather, day and night, and time dilation
- The projections crowd and the stability system
- Procedural audio, bloom and grade, adaptive quality, touch controls

### Milestone 1.1: the hallway and the ride (this release)
- The rotating hallway, with its own physics and a dreamscape
- Riding the fold: the street you stand on carries you over the city
- Solid plates behind all HUD text so it reads over any sky or street

### Milestone 2: a shared dream
- Multiplayer through an ordered fold log over WebRTC or a small relay. Each fold is a six-number event with a timestamp, so late joiners replay the log and arrive in the same city.
- See other dreamers as projections that do not turn on you.
- The architect and the dreamer as two different people: one folds the city while the other walks it.

### Milestone 3: deeper physics
- Mirror bridges: a fold of exactly 180° with zero radius that copies the street onto itself as a reflective arch.
- Projection crowds that react to each other as well as to you.

### Milestone 4: new targets
- WebGPU renderer with compute-driven culling, which moves the remaining per-frame CPU work (crowd, culling) onto the GPU and raises the building budget by an order of magnitude.
- WebXR: walk the folded city in VR, where the curl rising ahead is at its most unsettling.
- Recordable flights: export a fold sequence and camera path as a short film.

---

## 8. Code map

| Path | What lives there |
| --- | --- |
| `src/core/fold.ts` | Fold algebra (CPU), fold ordering, the spring-animated FoldStack |
| `src/core/config.ts` | Grid constants, slab sizes, street widths |
| `src/core/rng.ts` | Seeded hashing, value noise and fBm |
| `src/city/generator.ts` | Deterministic chunk generation: blocks, lots, towers, roofs, props |
| `src/city/shaders.ts` | GLSL: fold transform, facade painter, ground painter, props, picking |
| `src/city/materials.ts` | Shared uniforms and patched Three.js materials, depth and pick variants |
| `src/city/pool.ts` | The slab allocator for instanced attributes |
| `src/city/streamer.ts` | World-space streaming, LOD, collision and raise-brush edits |
| `src/world/` | Sky, sun and weather, dream levels, the projections crowd |
| `src/world/hallway.ts` | The rotating hallway: geometry, shader painter and the rider's physics |
| `src/modes/` | Architect controls, Dream Walk controls, presets, the ride fold (`ride.ts`) |
| `src/fx/` | GPU picking, procedural audio, post-processing |
| `src/ui/` | Styles and the HUD totem |
| `tests/` | Fold algebra, generator, hallway and ride tests |
