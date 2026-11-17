"""
The rotating hallway's hotel corridor: built, lit and baked in Blender, exported as glTF.

    blender -b -P art/hallway/build_hallway.py -- [--size 1024] [--samples 512] [--out art/hallway/out] [--reuse]
    python art/hallway/build_hallway.py [same options]        (with the bpy module, pip install bpy==5.3.0)

Usually run through  node scripts/pack-hallway.mjs , which also compresses the result into
src/world/hallway/hallway.glb.

Everything is made here from numbers: no downloaded models or textures. The corridor is the
game's hallway exactly (src/world/hallway.ts): 7 x 7 m inside, 64 m long, open at both ends.
Its four walls are walked on, so nothing may stand into that 7 m box by more than a few
centimetres: doors, coffers and lamps are set back into the walls, and mouldings stand out
two to eight centimetres at most.

Coordinates are the game's corridor frame throughout: x across (+x is wall 1), y up, z along
the axis. g() turns them into Blender's (Z up), and the glTF exporter turns them back.

The corridor is symmetric across x = 0 and z = 0, so only a quarter of it is exported (x >= 0,
z >= 0, about 5,000 triangles) and the game mirrors it into four. The light is baked on that
quarter with its three mirror images standing beside it, so the light of every lamp in the
corridor is in it, and the lightmap spends all its texels on a quarter of the surface.

Each corner carries a colour attribute: rgb is the surface's base colour (linear), alpha is its
kind (KINDS below, as kind / 16), which the game's shader uses to paint carpet, wallpaper and
wood grain, to light lamps, and to tell the baked inside from the sunlit stone outside.
"""

import json
import math
import os
import sys

import bpy  # first: with the bpy module, bmesh only exists once bpy is loaded
import bmesh
from mathutils import Vector

# ----------------------------------------------------------------------------- options

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]


def opt(name, default):
    if f"--{name}" in argv:
        return type(default)(argv[argv.index(f"--{name}") + 1])
    return default


HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(opt("out", os.path.join(HERE, "out")))
SIZE = opt("size", 1024)
SAMPLES = opt("samples", 512)
REUSE = "--reuse" in argv  # encode and export the last bake's lightmap.exr again instead of baking
os.makedirs(OUT, exist_ok=True)

# ----------------------------------------------------------------------------- dimensions

H = 3.5  # half the inside (the walked-on planes are at +-H)
L = 32.0  # half the length
T = 0.30  # wall thickness: the stone outside is at H + T
HO = H + T
CH = 0.30  # chamfer of the outside corners
BAND = 0.10  # the portal bands at the ends stand this much proud of the stone
BAND_LEN = 0.8

DOORS = [-28.0, -20.0, -12.0, -4.0, 4.0, 12.0, 20.0, 28.0]  # door centres along z
LAMPS = [-24.0, -16.0, -8.0, 0.0, 8.0, 16.0, 24.0]  # sconces and ceiling lights
DOOR_W = 0.70  # half the door's width
DOOR_H = 3.0
RECESS = 0.12  # how far the doors are set back
ARCH_W = 0.16  # width of the architrave round each door
DADO = 1.13  # top of the wood panelling (the chair rail sits on it)
PICTURE = 6.35  # the picture rail
SCONCE_T = 2.75  # height of a sconce's shade (centre)
COFFER = 0.14  # coffer depth
END = 31.1  # last ceiling beam; flush ceiling beyond it

# ----------------------------------------------------------------------------- kinds and colours

# kind id -> (name, linear base colour). The ids are shared with the game (KIND in src/world/hallwayModel.ts).
KINDS = {
    1: ("carpet", (0.20, 0.035, 0.03)),
    2: ("wallpaper", (0.50, 0.40, 0.31)),
    3: ("wood", (0.085, 0.042, 0.022)),
    4: ("door", (0.13, 0.055, 0.028)),
    5: ("trim", (0.70, 0.65, 0.57)),
    6: ("plaster", (0.72, 0.69, 0.63)),
    7: ("brass", (0.50, 0.34, 0.12)),
    8: ("shade", (0.95, 0.80, 0.58)),
    9: ("glass", (0.95, 0.88, 0.72)),
    10: ("stone", (0.40, 0.37, 0.33)),
    11: ("section", (0.28, 0.26, 0.24)),
    12: ("band", (0.33, 0.31, 0.28)),
}
K = {name: kid for kid, (name, _) in KINDS.items()}
LAMP_KINDS = {K["shade"], K["glass"]}
OUTSIDE_KINDS = {K["stone"], K["section"], K["band"]}
# Tungsten, about 2700 K, white-balanced the way a film camera would be for it: warm, not orange.
# (The shades and glass themselves glow warmer in the game: LAMP in hallwayModel.ts.)
LIGHT = (1.0, 0.87, 0.72)
SHADE_GLOW = 9.0
GLASS_GLOW = 6.0


def g(p):
    """Game corridor frame (x across, y up, z along) to Blender (Z up)."""
    return Vector((p[0], -p[2], p[1]))


# ----------------------------------------------------------------------------- mesh builder


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.verts = {}
        self.tint = self.bm.loops.layers.float_color.new("Tint")
        self.faces = 0

    def v(self, p):
        b = g(p)
        key = (round(b.x * 2000), round(b.y * 2000), round(b.z * 2000))
        vt = self.verts.get(key)
        if vt is None:
            vt = self.bm.verts.new(b)
            self.verts[key] = vt
        return vt

    def face(self, pts, kind, n=None):
        """A planar polygon (game coords). n, if given, is the side it is seen from."""
        vs = []
        for p in pts:
            vt = self.v(p)
            if not vs or vs[-1] is not vt:
                vs.append(vt)
        if len(vs) > 2 and vs[0] is vs[-1]:
            vs.pop()
        if len(vs) < 3:
            return None
        if n is not None:
            # Newell's normal, in game coords
            nx = ny = nz = 0.0
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                nx += (a[1] - b[1]) * (a[2] + b[2])
                ny += (a[2] - b[2]) * (a[0] + b[0])
                nz += (a[0] - b[0]) * (a[1] + b[1])
            if nx * n[0] + ny * n[1] + nz * n[2] < 0:
                vs.reverse()
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None  # the same face twice
        col = KINDS[kind][1]
        for loop in f.loops:
            loop[self.tint] = (col[0], col[1], col[2], kind / 16.0)
        f.material_index = kind - 1
        self.faces += 1
        return f


class Frame:
    """A surface of the corridor: p = o + s*S + t*T + d*D, with D pointing into the corridor."""

    def __init__(self, o, S, T, D):
        self.o, self.S, self.T, self.D = (Vector(x) for x in (o, S, T, D))

    def p(self, s, t, d=0.0):
        return tuple(self.o + self.S * s + self.T * t + self.D * d)

    def dirn(self, s, t, d):
        return tuple(self.S * s + self.T * t + self.D * d)


WALL = Frame((H, -H, 0), (0, 0, 1), (0, 1, 0), (-1, 0, 0))  # wall 1: s = z, t = height above the floor
FLOOR = Frame((0, -H, 0), (0, 0, 1), (1, 0, 0), (0, 1, 0))  # s = z, t = x
CEIL = Frame((0, H, 0), (0, 0, 1), (1, 0, 0), (0, -1, 0))  # s = z, t = x

B = Builder()


def quad(fr, s0, s1, t0, t1, kind, d=0.0, n=(0, 0, 1)):
    """A rectangle on a frame at depth d, seen from n (in frame terms: s, t, d)."""
    B.face([fr.p(s0, t0, d), fr.p(s1, t0, d), fr.p(s1, t1, d), fr.p(s0, t1, d)], kind, fr.dirn(*n))


def raised(fr, s0, s1, t0, t1, h, bev, kind, d=0.0, top_kind=None):
    """A raised panel: a flat top h proud of depth d, with bevelled sides."""
    a = [fr.p(s0, t0, d), fr.p(s1, t0, d), fr.p(s1, t1, d), fr.p(s0, t1, d)]
    b = [fr.p(s0 + bev, t0 + bev, d + h), fr.p(s1 - bev, t0 + bev, d + h), fr.p(s1 - bev, t1 - bev, d + h), fr.p(s0 + bev, t1 - bev, d + h)]
    B.face(b, top_kind or kind, fr.dirn(0, 0, 1))
    outs = [(0, -1, 0.5), (1, 0, 0.5), (0, 1, 0.5), (-1, 0, 0.5)]
    for i in range(4):
        j = (i + 1) % 4
        B.face([a[i], a[j], b[j], b[i]], kind, fr.dirn(*outs[i]))


def recess(fr, s0, s1, t0, t1, depth, kinds, bev=0.0):
    """A rectangular hole into the wall, open towards the corridor. kinds: (sides, back)."""
    side, back = kinds
    if bev > 0:
        # a 45 degree chamfer round the opening
        a = [fr.p(s0, t0), fr.p(s1, t0), fr.p(s1, t1), fr.p(s0, t1)]
        s0, s1, t0, t1 = s0 + bev, s1 - bev, t0 + bev, t1 - bev
        b = [fr.p(s0, t0, -bev), fr.p(s1, t0, -bev), fr.p(s1, t1, -bev), fr.p(s0, t1, -bev)]
        ins = [(0, 1, 1), (-1, 0, 1), (0, -1, 1), (1, 0, 1)]
        for i in range(4):
            j = (i + 1) % 4
            B.face([a[i], a[j], b[j], b[i]], side, fr.dirn(*ins[i]))
        top = -bev
    else:
        top = 0.0
    c = [(s0, t0), (s1, t0), (s1, t1), (s0, t1)]
    ins = [(0, 1, 0), (-1, 0, 0), (0, -1, 0), (1, 0, 0)]
    for i in range(4):
        j = (i + 1) % 4
        B.face([fr.p(*c[i], top), fr.p(*c[j], top), fr.p(*c[j], -depth), fr.p(*c[i], -depth)], side, fr.dirn(*ins[i]))
    quad(fr, s0, s1, t0, t1, back, -depth)


def sweep(fr, path, mitres, profile, kind, closed=False, caps=False, ref=None):
    """
    Sweep a moulding profile along a path on a frame. path: (s, t) points; mitres: the offset
    direction at each point (unit normal on a straight run, n1 + n2 at a square corner);
    profile: (w, d) points, w along the mitre and d out of the wall. ref is the profile's w
    centre, used to tell which side of each face is seen.
    """
    n = len(path)
    ref = ref if ref is not None else sum(w for w, _ in profile) / len(profile)
    rings = []
    for (s, t), (ms, mt) in zip(path, mitres):
        rings.append([fr.p(s + ms * w, t + mt * w, d) for w, d in profile])
    segs = n if closed else n - 1
    for i in range(segs):
        j = (i + 1) % n
        (s0, t0), (s1, t1) = path[i], path[j]
        ls = math.hypot(s1 - s0, t1 - t0)
        dir_s, dir_t = (s1 - s0) / ls, (t1 - t0) / ls
        # the segment's own normal, from the mitres
        ms, mt = mitres[i][0] + mitres[j][0], mitres[i][1] + mitres[j][1]
        dot = ms * dir_s + mt * dir_t
        ms, mt = ms - dir_s * dot, mt - dir_t * dot
        lm = math.hypot(ms, mt) or 1.0
        ms, mt = ms / lm, mt / lm
        cs, ct = (s0 + s1) / 2 + ms * ref, (t0 + t1) / 2 + mt * ref
        rp = Vector(fr.p(cs, ct, -0.01))
        for k in range(len(profile) - 1):
            pts = [rings[i][k], rings[j][k], rings[j][k + 1], rings[i][k + 1]]
            ctr = sum((Vector(p) for p in pts), Vector()) / 4
            B.face(pts, kind, tuple(ctr - rp))
    if caps and not closed:
        for i, sign in ((0, -1), (n - 1, 1)):
            (s, t) = path[i]
            (s2, t2) = path[1] if i == 0 else path[n - 2]
            ds, dt = (s - s2), (t - t2)
            lm = math.hypot(ds, dt)
            B.face(rings[i] + [fr.p(path[i][0] + mitres[i][0] * profile[-1][0], path[i][1] + mitres[i][1] * profile[-1][0], 0)], kind, fr.dirn(ds / lm, dt / lm, 0))


def bays_between(s0, s1):
    """s0, every multiple of 8 m strictly between, s1: where long runs are cut so the lightmap packs well."""
    return [s0] + [8.0 * k for k in range(math.floor(s0 / 8) + 1, math.ceil(s1 / 8)) if s0 < 8.0 * k < s1] + [s1]


def run_along(fr, s0, s1, t, profile, kind, caps=True):
    """A straight moulding along s at height t; profile w is height above t."""
    pts = bays_between(s0, s1)
    sweep(fr, [(s, t) for s in pts], [(0, 1)] * len(pts), profile, kind, caps=caps)


# ----------------------------------------------------------------------------- the inside

# Break lines shared by the floor, the walls and the ceiling, so their edges meet vertex to
# vertex (no T-junctions to sparkle along the corners).
zs = {-L, L, -24.0, -16.0, -8.0, 0.0, 8.0, 16.0, 24.0}
for c in DOORS:
    for e in (c - DOOR_W, c + DOOR_W):
        zs.add(e)
beams = []
z = -L + 1.0 - 0.1
k = -15
while 2 * k + 1 <= 31:
    zc = 2 * k + 1
    beams.append(zc)
    zs.update((zc - 0.1, zc + 0.1))
    k += 1
ZS = sorted(zs)

# the floor: one carpet, broken only where the walls break
for x0, x1 in ((-H, 0.0), (0.0, H)):
    for a, b in zip(ZS, ZS[1:]):
        quad(FLOOR, a, b, x0, x1, K["carpet"])

# wall 1 (the game's face 1, at x = +H); the other wall is its mirror image
TS = [0.0, DADO, DOOR_H, PICTURE, 2 * H]
WALL_KIND = [K["wood"], K["wallpaper"], K["wallpaper"], K["trim"]]


def in_door(s0, s1, t1):
    return t1 <= DOOR_H + 1e-6 and any(s0 >= c - DOOR_W - 1e-6 and s1 <= c + DOOR_W + 1e-6 for c in DOORS)


for a, b in zip(ZS, ZS[1:]):
    for i, (t0, t1) in enumerate(zip(TS, TS[1:])):
        if not in_door(a, b, t1):
            quad(WALL, a, b, t0, t1, WALL_KIND[i])

# the ceiling: beams flush with the plane, coffers set back into it
XS = [-H, -3.3, -1.7, -1.5, 0.0, 1.5, 1.7, 3.3, H]
COFFER_X = [(-3.3, -1.7), (-1.5, 0.0), (0.0, 1.5), (1.7, 3.3)]
coffers = [(zc - 0.9, zc + 0.9) for zc in range(-30, 31, 2)]
for a, b in zip(ZS, ZS[1:]):
    for x0, x1 in zip(XS, XS[1:]):
        inside = any(a >= c0 - 1e-6 and b <= c1 + 1e-6 for c0, c1 in coffers) and (x0, x1) in COFFER_X
        if not inside:
            quad(CEIL, a, b, x0, x1, K["plaster"])
for c0, c1 in coffers:
    for x0, x1 in ((-3.3, -1.7), (-1.5, 1.5), (1.7, 3.3)):
        recess(CEIL, c0, c1, x0, x1, COFFER, (K["trim"], K["plaster"]), bev=0.03)
    zc = (c0 + c1) / 2
    if zc in LAMPS:
        # a frosted glass light in the middle coffer, a centimetre in front of its back
        quad(CEIL, zc - 0.6, zc + 0.6, -0.85, 0.85, K["glass"], -COFFER + 0.01)
        # its brass frame
        for (s0, s1, t0, t1) in (
            (zc - 0.66, zc + 0.66, -0.91, -0.85),
            (zc - 0.66, zc + 0.66, 0.85, 0.91),
            (zc - 0.66, zc - 0.6, -0.85, 0.85),
            (zc + 0.6, zc + 0.66, -0.85, 0.85),
        ):
            quad(CEIL, s0, s1, t0, t1, K["brass"], -COFFER + 0.012)

# doors: set back into the wall, with a reveal, a panelled leaf, a knob and a number plate
for c in DOORS:
    s0, s1 = c - DOOR_W, c + DOOR_W
    B.face([WALL.p(s0, 0, 0), WALL.p(s0, DOOR_H, 0), WALL.p(s0, DOOR_H, -RECESS), WALL.p(s0, 0, -RECESS)], K["trim"], WALL.dirn(1, 0, 0))
    B.face([WALL.p(s1, 0, 0), WALL.p(s1, DOOR_H, 0), WALL.p(s1, DOOR_H, -RECESS), WALL.p(s1, 0, -RECESS)], K["trim"], WALL.dirn(-1, 0, 0))
    B.face([WALL.p(s0, DOOR_H, 0), WALL.p(s1, DOOR_H, 0), WALL.p(s1, DOOR_H, -RECESS), WALL.p(s0, DOOR_H, -RECESS)], K["trim"], WALL.dirn(0, -1, 0))
    B.face([WALL.p(s0, 0, 0), WALL.p(s1, 0, 0), WALL.p(s1, 0, -RECESS), WALL.p(s0, 0, -RECESS)], K["brass"], WALL.dirn(0, 1, 0))
    leaf = -RECESS
    quad(WALL, s0, s1, 0.0, DOOR_H, K["door"], leaf, n=(0, 0, 1))
    # six raised panels
    for (a, b) in ((s0 + 0.15, c - 0.06), (c + 0.06, s1 - 0.15)):
        for (t0, t1) in ((0.34, 1.16), (1.32, 2.34), (2.48, 2.84)):
            raised(WALL, a, b, t0, t1, 0.016, 0.04, K["door"], leaf)
    # brass kick plate, knob with its plate, and the room number
    raised(WALL, s0 + 0.06, s1 - 0.06, 0.04, 0.26, 0.004, 0.004, K["brass"], leaf)
    side = 1 if c > 0 else -1  # the knob is on the side away from the middle of the corridor
    kx = c + side * (DOOR_W - 0.16)
    raised(WALL, kx - 0.035, kx + 0.035, 0.92, 1.22, 0.006, 0.004, K["brass"], leaf)
    raised(WALL, kx - 0.03, kx + 0.03, 1.02, 1.08, 0.06, 0.012, K["brass"], leaf + 0.006)
    raised(WALL, c - 0.13, c + 0.13, 1.66, 1.80, 0.008, 0.006, K["brass"], leaf)

# architrave round each door, and a little cornice over it
ARCH = [(0.0, 0.0), (0.0, 0.03), (0.018, 0.036), (0.05, 0.032), (0.11, 0.026), (0.13, 0.034), (0.15, 0.03), (ARCH_W, 0.018), (ARCH_W, 0.0)]
OVER = [(0.0, 0.0), (0.0, 0.042), (0.17, 0.042), (0.19, 0.055), (0.22, 0.07), (0.26, 0.072), (0.27, 0.06), (0.27, 0.0)]
for c in DOORS:
    s0, s1 = c - DOOR_W, c + DOOR_W
    sweep(WALL, [(s0, 0.0), (s0, DOOR_H), (s1, DOOR_H), (s1, 0.0)], [(-1, 0), (-1, 1), (1, 1), (1, 0)], ARCH, K["trim"], ref=ARCH_W / 2)
    run_along(WALL, s0 - ARCH_W - 0.08, s1 + ARCH_W + 0.08, DOOR_H + ARCH_W, OVER, K["trim"])

# the bays of wall between the doors
bays = []
edges = [-L] + [e for c in DOORS for e in (c - DOOR_W - ARCH_W, c + DOOR_W + ARCH_W)] + [L]
for a, b in zip(edges[0::2], edges[1::2]):
    bays.append((a, b))

SKIRT = [(0.0, 0.0), (0.0, 0.022), (0.16, 0.022), (0.18, 0.016), (0.2, 0.01), (0.22, 0.004), (0.22, 0.0)]
RAIL = [(0.0, 0.0), (0.0, 0.012), (0.02, 0.026), (0.045, 0.036), (0.075, 0.04), (0.1, 0.032), (0.12, 0.016), (0.12, 0.0)]
FRAME = [(0.0, 0.0), (0.0, 0.01), (0.012, 0.018), (0.03, 0.016), (0.045, 0.008), (0.05, 0.0)]
PRAIL = [(0.0, 0.0), (0.0, 0.016), (0.02, 0.026), (0.04, 0.022), (0.05, 0.01), (0.05, 0.0)]

for a, b in bays:
    end_a, end_b = a <= -L + 1e-6, b >= L - 1e-6
    run_along(WALL, a, b, 0.0, SKIRT, K["wood"], caps=True)
    run_along(WALL, a, b, DADO, RAIL, K["wood"], caps=True)
    # wood panels below the rail, laid out symmetrically in the bay
    pa = a + (0.4 if end_a else 0.12)
    pb = b - (0.4 if end_b else 0.12)
    n = max(1, round((pb - pa) / 1.7))
    if not (end_a or end_b) and n % 2:
        n += 1  # an even count puts a stile, not a panel, on the bay's middle (z = 0 is a mirror)
    w = (pb - pa - 0.12 * (n - 1)) / n
    for i in range(n):
        s0 = pa + i * (w + 0.12)
        raised(WALL, s0, s0 + w, 0.36, 1.0, 0.014, 0.035, K["wood"])
    # picture frames of moulding above it, either side of the sconce
    mid = (a + b) / 2
    lamp = any(abs(mid - z) < 1e-6 for z in LAMPS)
    fa = a + (0.6 if end_a else 0.3)
    fb = b - (0.6 if end_b else 0.3)
    rects = [(fa, mid - 0.42), (mid + 0.42, fb)] if lamp else [(fa, fb)]
    for r0, r1 in rects:
        sweep(
            WALL,
            [(r0, 1.62), (r1, 1.62), (r1, 5.95), (r0, 5.95)],
            [(-1, -1), (1, -1), (1, 1), (-1, 1)],
            FRAME,
            K["trim"],
            closed=True,
            ref=0.025,
        )

# a frame above each door
for c in DOORS:
    sweep(
        WALL,
        [(c - DOOR_W, 3.85), (c + DOOR_W, 3.85), (c + DOOR_W, 5.95), (c - DOOR_W, 3.85 + 2.1)],
        [(-1, -1), (1, -1), (1, 1), (-1, 1)],
        FRAME,
        K["trim"],
        closed=True,
        ref=0.025,
    )

# the picture rail and the cornice run the whole length
run_along(WALL, -L, L, PICTURE, PRAIL, K["trim"], caps=True)
# cornice: a cove across the corner of the wall and the ceiling, at most 13 cm from either
cove = [(0.0, 0.17), (0.022, 0.17), (0.022, 0.15)]
for i in range(1, 8):
    a = (i / 8) * (math.pi / 2)
    cove.append((0.15 - 0.128 * math.cos(a), 0.15 - 0.128 * math.sin(a)))
cove += [(0.15, 0.022), (0.17, 0.022), (0.17, 0.0)]
corner = Vector((H + 0.01, H + 0.01, 0))
cut = bays_between(-L, L)
for z0, z1 in zip(cut, cut[1:]):
    r0 = [(H - a, H - b, z0) for a, b in cove]
    r1 = [(H - a, H - b, z1) for a, b in cove]
    for k in range(len(cove) - 1):
        pts = [r0[k], r1[k], r1[k + 1], r0[k + 1]]
        ctr = sum((Vector(p) for p in pts), Vector()) / 4
        B.face(pts, K["trim"], tuple(ctr - Vector((corner.x, corner.y, ctr.z))))
for zz, sign in ((-L, -1), (L, 1)):
    B.face([(H - a, H - b, zz) for a, b in cove] + [(H, H, zz)], K["section"], (0, 0, sign))

# sconces: a brass plate and a half-drum shade, 7 cm deep in all
for zc in LAMPS:
    raised(WALL, zc - 0.09, zc + 0.09, SCONCE_T - 0.3, SCONCE_T + 0.16, 0.01, 0.008, K["brass"])
    segs = 10
    for lvl, (tb, tt) in enumerate(((SCONCE_T - 0.2, SCONCE_T + 0.18),)):
        bot = [(zc + 0.17 * math.cos(math.pi * i / segs), 0.06 * math.sin(math.pi * i / segs)) for i in range(segs + 1)]
        top = [(zc + 0.13 * math.cos(math.pi * i / segs), 0.048 * math.sin(math.pi * i / segs)) for i in range(segs + 1)]
        for i in range(segs):
            pts = [WALL.p(bot[i][0], tb, 0.011 + bot[i][1]), WALL.p(bot[i + 1][0], tb, 0.011 + bot[i + 1][1]), WALL.p(top[i + 1][0], tt, 0.011 + top[i + 1][1]), WALL.p(top[i][0], tt, 0.011 + top[i][1])]
            mid_s = (bot[i][0] + bot[i + 1][0]) / 2 - zc
            B.face(pts, K["shade"], WALL.dirn(mid_s, 0.0, (bot[i][1] + bot[i + 1][1]) / 2))
        B.face([WALL.p(s, tb, 0.011 + d) for s, d in bot], K["shade"], WALL.dirn(0, -1, 0))
        B.face([WALL.p(s, tt, 0.011 + d) for s, d in top], K["shade"], WALL.dirn(0, 1, 0))

# ----------------------------------------------------------------------------- the outside


def octagon(r, c):
    """The outside's corners in (x, y), anticlockwise from the +x side, for half-size r and chamfer c."""
    return [(r, -(r - c)), (r, r - c), (r - c, r), (-(r - c), r), (-r, r - c), (-r, -(r - c)), (-(r - c), -r), (r - c, -r)]


def prism(poly, z0, z1, kind):
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        nx, ny = (b[1] - a[1]), -(b[0] - a[0])
        B.face([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], kind, (nx, ny, 0))


body = octagon(HO, CH)
band = octagon(HO + BAND, CH + BAND * 0.5)
prism(body, -(L - BAND_LEN), L - BAND_LEN, K["stone"])
for sign in (-1, 1):
    z0, z1 = sorted((sign * (L - BAND_LEN), sign * L))
    prism(band, z0, z1, K["band"])
    # the step from the stone out to the band
    zz = sign * (L - BAND_LEN)
    for i in range(8):
        a, b = body[i], body[(i + 1) % 8]
        c, d = band[(i + 1) % 8], band[i]
        B.face([(a[0], a[1], zz), (b[0], b[1], zz), (c[0], c[1], zz), (d[0], d[1], zz)], K["band"], (0, 0, -sign))
    # the cut end of the walls, round the opening
    zz = sign * L
    inner_x = [-H] + [t - H for t in TS[1:-1]] + [H]  # the wall's own breaks, so the edges meet
    for side in range(4):
        # rotate the +x side's points by side * 90 degrees
        cs, sn = [(1, 0), (0, 1), (-1, 0), (0, -1)][side]
        rot = lambda p: (p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs)
        if side in (0, 2):
            inner = [rot((H, y)) for y in (inner_x if side == 0 else [-y for y in inner_x][::-1])]
        else:
            # the ceiling's breaks across, or the floor's
            breaks = sorted({-H, H, *XS}) if side == 1 else [-H, 0.0, H]
            inner = [rot((H, y)) for y in breaks]
        o0, o1 = band[2 * side], band[2 * side + 1]
        pts = inner + [o1, o0]
        B.face([(p[0], p[1], zz) for p in pts], K["section"], (0, 0, sign))
        # the corner piece to the next side
        nxt = band[(2 * side + 2) % 8]
        cin = rot((H, H))
        B.face([(cin[0], cin[1], zz), (o1[0], o1[1], zz), (nxt[0], nxt[1], zz)], K["section"], (0, 0, sign))

print(f"built {B.faces} faces")

# ----------------------------------------------------------------------------- into Blender

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
scene = bpy.context.scene

mesh = bpy.data.meshes.new("Corridor")
bm = B.bm
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
# keep the quarter at x >= 0 (Blender X) and z >= 0 (Blender Y <= 0)
geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
r = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, 0), plane_no=(1, 0, 0), clear_inner=True)
geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
r = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, 0), plane_no=(0, -1, 0), clear_inner=True)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
# smooth shading across shallow angles only (the mouldings' curves), sharp elsewhere
for f in bm.faces:
    f.smooth = True
for e in bm.edges:
    if len(e.link_faces) == 2:
        a, b = e.link_faces
        e.smooth = a.normal.angle(b.normal, 0.0) < math.radians(40) and a.material_index == b.material_index
    else:
        e.smooth = False
bm.to_mesh(mesh)
bm.free()

# a material per kind (for the bake: base colour, emission for the lamps)
for kid in sorted(KINDS):
    name, col = KINDS[kid]
    m = bpy.data.materials.new(f"hall_{name}")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*col, 1)
    bsdf.inputs["Roughness"].default_value = 0.35 if name == "brass" else 0.8
    if kid in LAMP_KINDS:
        bsdf.inputs["Emission Color"].default_value = (*LIGHT, 1)
        bsdf.inputs["Emission Strength"].default_value = SHADE_GLOW if name == "shade" else GLASS_GLOW
    mesh.materials.append(m)

quarter = bpy.data.objects.new("Corridor", mesh)
scene.collection.objects.link(quarter)

tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
print(f"quarter: {len(mesh.vertices)} vertices, {tris} triangles")

# ----------------------------------------------------------------------------- lightmap UVs

bpy.context.view_layer.objects.active = quarter
quarter.select_set(True)
uv = mesh.uv_layers.new(name="Lightmap")
mesh.uv_layers.active = uv
bpy.ops.object.mode_set(mode="EDIT")
ebm = bmesh.from_edit_mesh(mesh)
for f in ebm.faces:
    f.select = (f.material_index + 1) not in LAMP_KINDS | OUTSIDE_KINDS
# Cut the surface into islands along its creases, where one kind meets another, and every 8 m
# (one bay) along the corridor, so the long walls pack well; then unfold each island flat.
for e in ebm.edges:
    lf = e.link_faces
    if len(lf) != 2:
        e.seam = True
        continue
    a, b = lf
    za, zb = -e.verts[0].co.y, -e.verts[1].co.y
    bay = abs(za - zb) < 1e-4 and abs(za / 8 - round(za / 8)) < 1e-4 and 0 < round(za) < L
    e.seam = bay or a.material_index != b.material_index or a.normal.angle(b.normal, 0.0) > math.radians(60)
bmesh.update_edit_mesh(mesh)
bpy.ops.uv.unwrap(method="CONFORMAL", margin=0.0)
bpy.ops.uv.average_islands_scale()  # (on the selected faces: the ones that are baked)
# Pack the islands in shelves, tallest first, at the largest scale that fits. (Blender's own
# packer left half the square empty around the long wall pieces.) Margins are in texels.
from bpy_extras import bmesh_utils

ebm = bmesh.from_edit_mesh(mesh)
ebm.faces.ensure_lookup_table()
uvl = ebm.loops.layers.uv.active
islands = []
for faces in bmesh_utils.bmesh_linked_uv_islands(ebm, uvl):
    fs = [f for f in (ebm.faces[i] if isinstance(i, int) else i for i in faces) if (f.material_index + 1) not in LAMP_KINDS | OUTSIDE_KINDS]
    if not fs:
        continue
    us = [lp[uvl].uv.copy() for f in fs for lp in f.loops]
    x0, y0 = min(u.x for u in us), min(u.y for u in us)
    x1, y1 = max(u.x for u in us), max(u.y for u in us)
    w, h = x1 - x0, y1 - y0
    islands.append({"faces": fs, "x0": x0, "y0": y0, "w": w, "h": h, "rot": w < h})
for isl in islands:
    if isl["rot"]:
        isl["w"], isl["h"] = isl["h"], isl["w"]  # lie every island down: shelves are rows
islands.sort(key=lambda i: -i["h"])
MARGIN = 5.0 / SIZE


def shelves(k):
    """Lay the islands out at scale k; return their places, or None if they do not fit."""
    x = y = row = 0.0
    places = []
    for isl in islands:
        w, h = isl["w"] * k + MARGIN, isl["h"] * k + MARGIN
        if w > 1.0:
            return None
        if x + w > 1.0:
            x, y, row = 0.0, y + row, 0.0
        if y + h > 1.0:
            return None
        places.append((x + MARGIN / 2, y + MARGIN / 2))
        x += w
        row = max(row, h)
    return places


lo, hi = 0.0, 10.0
while shelves(hi) is not None:
    hi *= 2
for _ in range(40):
    mid = (lo + hi) / 2
    lo, hi = (mid, hi) if shelves(mid) is not None else (lo, mid)
places = shelves(lo)
for isl, (px_, py_) in zip(islands, places):
    for f in isl["faces"]:
        for lp in f.loops:
            u = lp[uvl].uv
            dx, dy = u.x - isl["x0"], u.y - isl["y0"]
            if isl["rot"]:
                dx, dy = dy, isl["h"] - dx  # a quarter turn (isl["h"] is the island's original width)
            lp[uvl].uv = (px_ + dx * lo, py_ + dy * lo)
bmesh.update_edit_mesh(mesh)
print(f"packed {len(islands)} islands at {lo * SIZE:.1f} texels a unit")
# lamps and the outside are not baked: park their UVs on one spot
ebm = bmesh.from_edit_mesh(mesh)
uvl = ebm.loops.layers.uv.active
for f in ebm.faces:
    if (f.material_index + 1) in LAMP_KINDS | OUTSIDE_KINDS:
        for lp in f.loops:
            lp[uvl].uv = (0.0, 0.0)
bmesh.update_edit_mesh(mesh)
bpy.ops.object.mode_set(mode="OBJECT")
fill = 0.0
uvd = mesh.uv_layers["Lightmap"].uv
for poly in mesh.polygons:
    if (poly.material_index + 1) not in LAMP_KINDS | OUTSIDE_KINDS:
        pts = [uvd[li].vector for li in poly.loop_indices]
        fill += abs(sum(pts[i].x * pts[(i + 1) % len(pts)].y - pts[(i + 1) % len(pts)].x * pts[i].y for i in range(len(pts)))) / 2
print(f"lightmap uv fill {fill * 100:.0f}%")

# ----------------------------------------------------------------------------- light and bake

# the other three quarters, as mirror images sharing the mesh, so every lamp lights the bake
for sx, sz in ((-1, 1), (1, -1), (-1, -1)):
    o = bpy.data.objects.new(f"Mirror{sx}{sz}", mesh)
    o.scale = (sx, sz, 1)  # Blender Y is the game's -z
    scene.collection.objects.link(o)

# the open drum of each sconce throws a scallop of light up the wall and a pool down it
for zc in LAMPS:
    for wall in (1, -1):
        for up in (1, -1):
            ld = bpy.data.lights.new(f"scallop{zc}{wall}{up}", "SPOT")
            ld.energy = 32.0
            ld.color = LIGHT
            ld.spot_size = math.radians(120)
            ld.spot_blend = 0.6
            ld.shadow_soft_size = 0.05
            lo = bpy.data.objects.new(ld.name, ld)
            t = SCONCE_T + (0.2 if up > 0 else -0.22)
            lo.location = g((wall * (H - 0.06), t - H, zc))
            # a spot shines down its own -Z: turn it to face up (+Z) or leave it facing down
            lo.rotation_euler = (math.pi, 0, 0) if up > 0 else (0, 0, 0)
            scene.collection.objects.link(lo)

world = bpy.data.worlds.new("Night")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
scene.world = world

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 5
scene.cycles.glossy_bounces = 2
scene.cycles.transmission_bounces = 0
scene.cycles.use_light_tree = True
scene.cycles.sample_clamp_indirect = 3.0
scene.render.threads_mode = "AUTO"

img = bpy.data.images.new("Lightmap", SIZE, SIZE, alpha=False, float_buffer=True)
for m in mesh.materials:
    node = m.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    m.node_tree.nodes.active = node

for o in scene.objects:
    o.select_set(False)
quarter.select_set(True)
bpy.context.view_layer.objects.active = quarter

import time

t0 = time.time()
EXR = os.path.join(OUT, "lightmap.exr")
if REUSE and os.path.exists(EXR):
    # --reuse: the last bake's light, to try another encoding without baking again (the model must not have changed)
    done = bpy.data.images.load(EXR)
    if tuple(done.size) != (SIZE, SIZE):
        sys.exit(f"--reuse: {EXR} is {done.size[0]} x {done.size[1]}, not {SIZE} x {SIZE}")
    img = done
    print(f"baked {SIZE}x{SIZE}: reused {EXR}")
else:
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=12, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES")
    print(f"baked {SIZE}x{SIZE} at {SAMPLES} samples in {time.time() - t0:.0f} s")
    img.filepath_raw = EXR
    img.file_format = "OPEN_EXR"
    img.save()
# the scene as baked (quarter, its mirror images and the sconces' spots), to open or re-bake by hand
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "hallway.blend"), compress=True)

# ----------------------------------------------------------------------------- encode the lightmap

# 8 bits a channel: the square root of light / SCALE, through the sRGB curve. The GPU's sRGB
# decode undoes the curve and the shader squares what it reads. Most of the corridor is lit at a
# few percent of its brightest spot (the wall beside a sconce), and the square root spends four
# times as many of the 256 steps down there as the sRGB curve alone, which keeps the dim walls
# smooth through WebP's compression.
import numpy as np

px = np.empty(SIZE * SIZE * 4, dtype=np.float32)
img.pixels.foreach_get(px)
px = px.reshape(SIZE, SIZE, 4)[:, :, :3]
# Knock out fireflies: a texel far brighter than the median of its 3 x 3 neighbours takes that median.
pad = np.pad(px, ((1, 1), (1, 1), (0, 0)), mode="edge")
stack = np.stack([pad[1 + dy : 1 + dy + SIZE, 1 + dx : 1 + dx + SIZE] for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
med = np.median(stack, axis=0)
hot = px > med * 1.5 + 0.02
px = np.where(hot, med, px)
print(f"fireflies removed: {int(hot.any(axis=2).sum())} texels")
# Then smooth what noise is left, but not across an edge in the light: each texel is averaged
# with its 5 x 5 neighbours, weighted down the further they are and the more their light differs.
lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
padp = np.pad(px, ((2, 2), (2, 2), (0, 0)), mode="edge")
padl = np.pad(lum, 2, mode="edge")
acc = np.zeros_like(px)
wsum = np.zeros_like(lum)
for dy in range(-2, 3):
    for dx in range(-2, 3):
        ln = padl[2 + dy : 2 + dy + SIZE, 2 + dx : 2 + dx + SIZE]
        w = math.exp(-(dx * dx + dy * dy) / (2 * 1.3**2)) * np.exp(-0.5 * ((ln - lum) / (0.12 * lum + 1e-3)) ** 2)
        acc += padp[2 + dy : 2 + dy + SIZE, 2 + dx : 2 + dx + SIZE] * w[:, :, None]
        wsum += w
px = acc / wsum[:, :, None]
# The colour of the light changes slowly (it is the lamps' warm white, tinted by what it bounced
# off), so its noise can be smoothed much further than its brightness: the colour of each texel
# (light over its luminance) is averaged over 9 x 9, again only with neighbours of similar light.
lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
tint = px / (lum[:, :, None] + 1e-6)
padt = np.pad(tint, ((4, 4), (4, 4), (0, 0)), mode="edge")
padl = np.pad(lum, 4, mode="edge")
acc = np.zeros_like(px)
wsum = np.zeros_like(lum)
for dy in range(-4, 5):
    for dx in range(-4, 5):
        ln = padl[4 + dy : 4 + dy + SIZE, 4 + dx : 4 + dx + SIZE]
        w = math.exp(-(dx * dx + dy * dy) / (2 * 2.5**2)) * np.exp(-0.5 * ((ln - lum) / (0.25 * lum + 1e-3)) ** 2)
        acc += padt[4 + dy : 4 + dy + SIZE, 4 + dx : 4 + dx + SIZE] * w[:, :, None]
        wsum += w
px = acc / wsum[:, :, None] * lum[:, :, None]
lit = px.max(axis=2)
scale = float(np.percentile(lit[lit > 1e-5], 99.95)) * 1.1
v = np.sqrt(np.clip(px / scale, 0.0, 1.0))
enc = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)
out = bpy.data.images.new("LightmapLDR", SIZE, SIZE, alpha=False)
out.colorspace_settings.name = "Non-Color"  # the numbers above are written as they are
rgba = np.ones((SIZE, SIZE, 4), dtype=np.float32)
rgba[:, :, :3] = enc
out.pixels.foreach_set(rgba.ravel())
out.filepath_raw = os.path.join(OUT, "lightmap.png")
out.file_format = "PNG"
out.save()
print(f"lightmap scale {scale:.4f} (light at 1.0 in the image)")

# ----------------------------------------------------------------------------- export

# one material for the whole quarter, carrying the lightmap as its base colour texture so the
# file is self-contained (the game reads it as light, not colour)
for o in list(scene.objects):
    if o is not quarter:
        bpy.data.objects.remove(o, do_unlink=True)
exp = bpy.data.materials.new("Hallway")
exp.use_nodes = True
nt = exp.node_tree
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = out
tex.interpolation = "Linear"
nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
mesh.materials.clear()
mesh.materials.append(exp)
for p in mesh.polygons:
    p.material_index = 0
mesh.color_attributes.active_color = mesh.color_attributes["Tint"]
mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
quarter["hallway"] = json.dumps({"lightScale": scale, "kinds": {str(k): v[0] for k, v in KINDS.items()}, "size": SIZE, "samples": SAMPLES})

bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT, "hallway-raw.glb"),
    export_format="GLB",
    use_selection=False,
    export_yup=True,
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_vertex_color="NAME",
    export_vertex_color_name="Tint",
    export_all_vertex_colors=False,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_extras=True,
    export_cameras=False,
    export_lights=False,
)
with open(os.path.join(OUT, "hallway.json"), "w") as fh:
    json.dump({"lightScale": scale, "size": SIZE, "samples": SAMPLES, "triangles": tris, "vertices": len(mesh.vertices)}, fh, indent=2)
print("exported", os.path.join(OUT, "hallway-raw.glb"))
