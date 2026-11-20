"""
The street life kit: café terraces, benches, bollards, bicycle racks, planters, menu boards,
litter bins, advertising columns, news kiosks, metro entrances, drinking fountains and three
parked cars, modelled in Blender and exported as one glTF file.

    blender -b -P art/street/build_street.py -- [--out art/street/out] [--preview]
    python art/street/build_street.py [same options]        (with the bpy module, pip install bpy==5.3.0)

Usually run through  node scripts/pack-street.mjs , which also compresses the result into
src/city/street/street.glb.

Everything is made here from numbers: no downloaded models or textures, no brands, no lettering.
The pieces follow the look of Paris street furniture (dark green cast iron, rattan bistro chairs,
marble table tops) without copying any one design.

Coordinates are the game's throughout: x to the right, y up, z forwards, in metres, with the origin
on the ground at the middle of the piece. A piece's front (+z) is the side it shows the street: the
seat of a bench, the open end of a metro entrance, the bonnet of a car. Each model is built in those
coordinates and turned into Blender's (Z up) once at the end; the glTF exporter turns it back.

Each corner carries a colour attribute, "Tint": rgb is the surface's base colour (linear), alpha is
its kind (KINDS below, as kind / 16). The game's shader (src/city/shaders.ts, KIT_*) reads the kind
to decide how the surface takes the light (iron, chrome, glass, cloth...), which parts take the
instance's own colours (a car's paint, a café's chair weave and parasols), what glows at night, and
what it paints itself (the posters on a column, the steps down into the metro). The posters and the
steps also carry UV coordinates in metres.
"""

import json
import math
import os
import sys

import bpy  # first: with the bpy module, bmesh only exists once bpy is loaded
import bmesh
from mathutils import Matrix, Vector

# ----------------------------------------------------------------------------- options

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]


def opt(name, default):
    if f"--{name}" in argv:
        return type(default)(argv[argv.index(f"--{name}") + 1])
    return default


HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(opt("out", os.path.join(HERE, "out")))
PREVIEW = "--preview" in argv  # also render a line-up of every model (art/street/out/lineup.png)
os.makedirs(OUT, exist_ok=True)

# ----------------------------------------------------------------------------- kinds and colours

# kind id -> name. The ids are shared with the game (KIT_KIND in src/city/streetKit.ts).
KINDS = {
    1: "matte",  # stone, wood, rattan, marble: rgb as it is, rough
    2: "iron",  # painted cast iron: rgb as it is, a little sheen
    3: "chrome",  # bright metal: wheel rims, the bicycle rack
    4: "paint",  # car paint and bicycle frames: rgb times the instance's paint colour, glossy
    5: "cloth",  # chair weave, parasol canvas: rgb times the instance's cloth colour
    6: "glass",  # car windows: dark, reflects the sky
    7: "lamp",  # lit at night: the metro's globes
    8: "rubber",  # tyres
    9: "poster",  # painted by the shader (posters, magazines), lit from inside at night
    10: "foliage",  # clipped box hedges: tinted with the season's foliage colours
    11: "void",  # the stairwell into the metro, the shade under a car: painted dark by the shader
    12: "plastic",  # lamps, bumpers, number plates: rgb as it is, smooth
}
K = {name: kid for kid, name in KINDS.items()}

IRON = (0.016, 0.040, 0.026)  # the green of Paris street furniture, nearly black
IRON_BLACK = (0.018, 0.018, 0.020)
MARBLE = (0.72, 0.70, 0.66)
RATTAN = (0.40, 0.25, 0.11)
SLATS = (0.030, 0.075, 0.042)  # a bench's green slats
STONE = (0.46, 0.43, 0.38)
STEEL = (0.62, 0.62, 0.62)
DARK = (0.012, 0.012, 0.013)
WHITE = (1.0, 1.0, 1.0)
CREAM = (0.70, 0.60, 0.40)
WOOD = (0.20, 0.11, 0.05)
GLOBE = (1.0, 0.46, 0.12)  # a metro lamp's orange glass
SIGN = (0.72, 0.56, 0.20)

# ----------------------------------------------------------------------------- building pieces


class Model:
    """One model: a bmesh in game coordinates, with its colour, UV and bookkeeping layers."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.tint = self.bm.loops.layers.float_color.new("Tint")
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.done = self.bm.faces.layers.int.new("done")


M = None  # the model being built


def fresh_faces():
    return [f for f in M.bm.faces if f[M.done] == 0]


def fresh_verts():
    return list({v for f in fresh_faces() for v in f.verts})


def finish(kind, col, smooth=False, flat_axis=None, paint=None, uv=None, recalc=True):
    """
    Colour the faces made since the last finish. kind/col: the kind and base colour, or paint(face)
    gives (kind, col) per face. smooth: smooth shading, except (with flat_axis) faces that look
    along that axis (the caps of a cylinder). uv(co, face): UV coordinates for a corner.
    """
    faces = fresh_faces()
    if recalc and faces:
        bmesh.ops.recalc_face_normals(M.bm, faces=faces)
    for f in faces:
        f[M.done] = 1
        f.normal_update()
        k, c = paint(f) if paint else (kind, col)
        s = smooth
        if flat_axis is not None and abs(f.normal.dot(flat_axis)) > 0.95:
            s = False
        f.smooth = s
        for lp in f.loops:
            lp[M.tint] = (c[0], c[1], c[2], K[k] / 16.0)
            lp[M.uv].uv = uv(lp.vert.co, f) if uv else (0.0, 0.0)
    return faces


def transform(mat, verts=None):
    bmesh.ops.transform(M.bm, matrix=mat, verts=verts if verts is not None else fresh_verts())


def rot_y(a):
    """The game's yaw: turns +z towards +x for a > 0 (rotY in the shaders)."""
    return Matrix.Rotation(a, 4, "Y")


def V(*a):
    return Vector(a)


def box(c, s, kind, col, bevel=0.0, segs=2, rot=None, smooth_bevel=True):
    """A box of size s centred on c, its edges rounded by bevel, turned by rot (a 4x4 matrix) about its centre."""
    bmesh.ops.create_cube(M.bm, size=1.0)
    vs = fresh_verts()
    bmesh.ops.scale(M.bm, vec=Vector(s), verts=vs)
    if bevel > 0:
        edges = list({e for v in vs for e in v.link_edges})
        bmesh.ops.bevel(M.bm, geom=vs + edges, offset=bevel, offset_type="OFFSET", segments=segs, profile=0.5, affect="EDGES", clamp_overlap=True)
    m = Matrix.Translation(Vector(c)) @ (rot if rot is not None else Matrix())
    transform(m)

    def paint(f):
        return kind, col

    faces = finish(kind, col)
    if bevel > 0 and smooth_bevel:
        # the rounded edges smooth, the flat faces flat (so they shade evenly)
        for f in faces:
            n = (rot.to_3x3().inverted() @ f.normal) if rot is not None else f.normal
            f.smooth = max(abs(n.x), abs(n.y), abs(n.z)) < 0.98
    return faces


def cyl(p0, p1, r0, r1, segs, kind, col, caps=True, smooth=True):
    """A cylinder (or cone) from p0 (radius r0) to p1 (radius r1)."""
    p0, p1 = Vector(p0), Vector(p1)
    axis = p1 - p0
    bmesh.ops.create_cone(M.bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r0, radius2=r1, depth=axis.length)
    q = Vector((0, 0, 1)).rotation_difference(axis.normalized())
    transform(Matrix.Translation((p0 + p1) / 2) @ q.to_matrix().to_4x4())
    return finish(kind, col, smooth=smooth, flat_axis=axis.normalized())


def sphere(c, r, kind, col, segs=12, rings=8, scale=(1, 1, 1)):
    bmesh.ops.create_uvsphere(M.bm, u_segments=segs, v_segments=rings, radius=r)
    transform(Matrix.Translation(Vector(c)) @ Matrix.Diagonal((*scale, 1.0)))
    return finish(kind, col, smooth=True)


def lathe(profile, segs, kind, col, base=(0, 0, 0), sx=1.0, sz=1.0, smooth=True, a0=0.0, paint=None, uv=None):
    """
    Turn a profile of (radius, height) points, bottom to top, round the vertical axis through base.
    sx, sz stretch it into an oval. Ends at radius 0 close to a point; others are capped.
    """
    base = Vector(base)
    bm = M.bm
    rings = []
    for r, y in profile:
        if r < 1e-6:
            rings.append([bm.verts.new(base + V(0, y, 0))])
        else:
            ring = []
            for i in range(segs):
                a = a0 + 2 * math.pi * i / segs
                ring.append(bm.verts.new(base + V(sx * r * math.sin(a), y, sz * r * math.cos(a))))
            rings.append(ring)
    for ra, rb in zip(rings, rings[1:]):
        if len(ra) == 1 and len(rb) == 1:
            continue
        for i in range(segs):
            j = (i + 1) % segs
            if len(ra) == 1:
                bm.faces.new((ra[0], rb[i], rb[j]))
            elif len(rb) == 1:
                bm.faces.new((ra[i], ra[j], rb[0]))
            else:
                bm.faces.new((ra[i], ra[j], rb[j], rb[i]))
    for ring in (rings[0], rings[-1]):
        if len(ring) > 2:
            bm.faces.new(ring)
    return finish(kind, col, smooth=smooth, flat_axis=V(0, 1, 0), paint=paint, uv=uv)


def tube(points, r, segs, kind, col, closed=False, caps=True, smooth=True):
    """A round tube of radius r along a polyline (closed: a loop)."""
    pts = [Vector(p) for p in points]
    n = len(pts)
    bm = M.bm
    tangents = []
    for i in range(n):
        if closed:
            t = pts[(i + 1) % n] - pts[i - 1]
        else:
            t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        tangents.append(t.normalized())
    # a frame carried along the curve without twisting
    up = V(0, 1, 0) if abs(tangents[0].y) < 0.9 else V(1, 0, 0)
    u = tangents[0].cross(up).normalized()
    rings = []
    for i in range(n):
        t = tangents[i]
        u = (u - t * u.dot(t)).normalized()
        w = t.cross(u)
        ring = [bm.verts.new(pts[i] + (u * math.cos(2 * math.pi * k / segs) + w * math.sin(2 * math.pi * k / segs)) * r) for k in range(segs)]
        rings.append(ring)
    for i in range(n if closed else n - 1):
        a, b = rings[i], rings[(i + 1) % n]
        for k in range(segs):
            m = (k + 1) % segs
            bm.faces.new((a[k], a[m], b[m], b[k]))
    if caps and not closed:
        bm.faces.new(rings[0])
        bm.faces.new(rings[-1])
    return finish(kind, col, smooth=smooth, flat_axis=None)


def arc(c, rx, ry, a0, a1, n, plane="xy"):
    """Points along an elliptical arc round c (angles in radians, 0 along the plane's first axis)."""
    out = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        u, v = rx * math.cos(a), ry * math.sin(a)
        if plane == "xy":
            out.append(Vector(c) + V(u, v, 0))
        elif plane == "zy":
            out.append(Vector(c) + V(0, v, u))
        else:  # "xz"
            out.append(Vector(c) + V(u, 0, v))
    return out


def prism(poly, plane, d0, d1, kind, col):
    """A polygon given in a plane ('zy': (z, y) points; 'xy': (x, y); 'xz': (x, z)), extruded across it from d0 to d1."""

    def p3(p, d):
        a, b = p
        if plane == "zy":
            return V(d, b, a)
        if plane == "xy":
            return V(a, b, d)
        return V(a, d, b)

    bm = M.bm
    lo = [bm.verts.new(p3(p, d0)) for p in poly]
    hi = [bm.verts.new(p3(p, d1)) for p in poly]
    bm.faces.new(lo)
    bm.faces.new(hi)
    n = len(poly)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    return finish(kind, col)


def quad(pts, kind, col, n, uv=None):
    """One flat polygon, seen from the side n points to."""
    f = M.bm.faces.new([M.bm.verts.new(Vector(p)) for p in pts])
    f.normal_update()
    if f.normal.dot(Vector(n)) < 0:
        f.normal_flip()
    return finish(kind, col, recalc=False, uv=uv)


def loft(rings, kind, col, smooth=True, paint=None, cap0=True, cap1=True):
    """Skin a run of rings (lists of points, all the same length, each a closed loop)."""
    bm = M.bm
    vr = [[bm.verts.new(Vector(p)) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vr, vr[1:]):
        for k in range(n):
            m = (k + 1) % n
            bm.faces.new((a[k], a[m], b[m], b[k]))
    if cap0:
        bm.faces.new(vr[0])
    if cap1:
        bm.faces.new(vr[-1])
    faces = finish(kind, col, smooth=smooth, paint=paint)
    if cap0 or cap1:
        # the caps flat
        for f in faces:
            if len(f.verts) > 4:
                f.smooth = False
    return faces


def place(mat):
    """Move everything made since the last finish... (used through `group`)."""
    transform(mat)


class group:
    """Build several parts, then move them all together: with group(matrix): ..."""

    def __init__(self, mat):
        self.mat = mat

    def __enter__(self):
        self.before = set(M.bm.verts)

    def __exit__(self, *exc):
        vs = [v for v in M.bm.verts if v not in self.before]
        bmesh.ops.transform(M.bm, matrix=self.mat, verts=vs)
        for v in vs:
            for f in v.link_faces:
                f.normal_update()


# ----------------------------------------------------------------------------- the café


def bistro_chair(segs=6, arcs=8):
    """
    A rattan bistro chair facing +z, its seat centred on the origin's vertical. Woven seat and back take the
    cloth colour. segs: sides of its canes; arcs: steps round its back (fewer for the parasols' chairs).
    """
    seat_y = 0.45
    hs = 0.2
    # legs, splayed a little
    for sx in (-1, 1):
        for sz in (-1, 1):
            tube([V(sx * hs, seat_y - 0.01, sz * hs), V(sx * (hs + 0.03), 0.0, sz * (hs + 0.03))], 0.013, segs, "matte", RATTAN)
    # the seat's frame and its weave
    ring = [V(math.copysign(hs, math.cos(a)) * min(1, abs(math.cos(a)) * 1.6), seat_y, math.copysign(hs, math.sin(a)) * min(1, abs(math.sin(a)) * 1.6)) for a in [2 * math.pi * i / (16 if arcs >= 8 else 8) for i in range(16 if arcs >= 8 else 8)]]
    tube(ring, 0.016, segs, "matte", RATTAN, closed=True)
    box(V(0, seat_y + 0.012, 0), (0.38, 0.02, 0.38), "cloth", WHITE, bevel=0.006, segs=1)
    # stretchers between the legs
    for sz in (-1, 1):
        tube([V(-hs - 0.015, 0.16, sz * (hs + 0.015)), V(hs + 0.015, 0.16, sz * (hs + 0.015))], 0.009, min(segs, 5), "matte", RATTAN)
    # the back: two posts rising from the rear legs, a curved top rail, and a woven band between
    back = arc(V(0, 0.83, -0.02), 0.22, 0.2, math.radians(200), math.radians(340), arcs, plane="xz")
    tube([V(-hs, seat_y, -hs), V(-0.21, 0.66, -0.1), back[0]], 0.014, segs, "matte", RATTAN)
    tube([V(hs, seat_y, -hs), V(0.21, 0.66, -0.1), back[-1]], 0.014, segs, "matte", RATTAN)
    tube(back, 0.018, segs, "matte", RATTAN)
    # the woven band: a curved strip just under the rail
    bm = M.bm
    top = arc(V(0, 0.8, -0.02), 0.21, 0.19, math.radians(205), math.radians(335), arcs, plane="xz")
    bot = arc(V(0, 0.62, -0.03), 0.2, 0.18, math.radians(205), math.radians(335), arcs, plane="xz")
    outer = []
    inner = []
    for a, b in zip(top, bot):
        ctr = V(0, a.y, -0.02)
        da = (a - ctr).normalized() * 0.008
        db = (b - V(0, b.y, -0.03)).normalized() * 0.008
        outer.append((a + da, b + db))
        inner.append((a - da, b - db))
    vo = [(bm.verts.new(a), bm.verts.new(b)) for a, b in outer]
    vi = [(bm.verts.new(a), bm.verts.new(b)) for a, b in inner]
    for i in range(len(vo) - 1):
        bm.faces.new((vo[i][0], vo[i + 1][0], vo[i + 1][1], vo[i][1]))
        bm.faces.new((vi[i][1], vi[i + 1][1], vi[i + 1][0], vi[i][0]))
        bm.faces.new((vo[i][0], vi[i][0], vi[i + 1][0], vo[i + 1][0]))
        bm.faces.new((vo[i + 1][1], vi[i + 1][1], vi[i][1], vo[i][1]))
    bm.faces.new((vo[0][0], vo[0][1], vi[0][1], vi[0][0]))
    bm.faces.new((vo[-1][1], vo[-1][0], vi[-1][0], vi[-1][1]))
    finish("cloth", WHITE, smooth=True)


def round_table(c, r=0.3):
    x, z = c
    cyl(V(x, 0.0, z), V(x, 0.035, z), 0.21, 0.18, 16, "iron", IRON_BLACK)
    cyl(V(x, 0.035, z), V(x, 0.70, z), 0.022, 0.022, 8, "iron", IRON_BLACK)
    cyl(V(x, 0.70, z), V(x, 0.72, z), r + 0.006, r + 0.006, 24, "chrome", STEEL)
    cyl(V(x, 0.72, z), V(x, 0.745, z), r, r, 24, "matte", MARBLE)


def build_terrace():
    """Two bistro chairs side by side, backs to the facade, a little round marble table in front of them."""
    round_table((0.0, 0.2), 0.3)
    for sx in (-1, 1):
        with group(Matrix.Translation(V(sx * 0.36, 0, -0.2)) @ rot_y(-sx * 0.18)):
            bistro_chair()


def build_parasol(far=False):
    """
    A square table with a chair on each side, under a canvas parasol: a terrace out on a square.
    far: the version drawn beyond the small furniture's reach: the parasol and its table, no chairs.
    """
    # the table
    cyl(V(-0.0, 0.0, 0.0), V(0, 0.04, 0), 0.26, 0.22, 4, "iron", IRON_BLACK, smooth=False)
    cyl(V(0, 0.04, 0), V(0, 0.71, 0), 0.03, 0.03, 4 if far else 8, "iron", IRON_BLACK)
    box(V(0, 0.725, 0), (0.72, 0.03, 0.72), "matte", MARBLE, bevel=0 if far else 0.008, segs=1)
    if not far:
        for i in range(4):
            a = i * math.pi / 2
            with group(rot_y(a) @ Matrix.Translation(V(0, 0, -0.62))):
                bistro_chair(segs=4, arcs=5)
    # the parasol: a pole through the table, an eight-sided canopy with a valance
    cyl(V(0, 0.74, 0), V(0, 2.62, 0), 0.022, 0.022, 4 if far else 8, "matte", WOOD)
    if not far:
        cyl(V(0, 2.1, 0), V(0, 2.2, 0), 0.04, 0.04, 8, "matte", WOOD)
    canopy = [(0.0, 2.62), (0.06, 2.62), (1.45, 2.24), (1.45, 2.08), (1.41, 2.08), (1.41, 2.21), (0.06, 2.56), (0.0, 2.56)]
    lathe(canopy, 8, "cloth", WHITE, smooth=False, a0=math.pi / 8)
    if not far:
        sphere(V(0, 2.66, 0), 0.045, "matte", WOOD, segs=8, rings=5)


# ----------------------------------------------------------------------------- along the kerb


def build_bench():
    """A bench of green slats on cast-iron ends, seat facing +z."""
    end = [(0.30, 0.00), (0.22, 0.00), (0.16, 0.38), (-0.12, 0.38), (-0.18, 0.00), (-0.26, 0.00), (-0.21, 0.40), (-0.34, 0.86), (-0.27, 0.88), (-0.15, 0.47), (0.27, 0.47)]
    for x in (-0.78, 0.78):
        prism(end, "zy", x - 0.025, x + 0.025, "iron", IRON)
    for i in range(4):
        z = 0.22 - i * 0.108
        box(V(0, 0.485, z), (1.9, 0.03, 0.085), "matte", SLATS, bevel=0.008, segs=1)
    for i in range(3):
        t = 0.18 + i * 0.3
        y = 0.5 + t * (0.86 - 0.5)
        z = -0.16 - t * (0.33 - 0.16)
        rot = Matrix.Rotation(math.radians(-24), 4, "X")
        box(V(0, y, z), (1.9, 0.085, 0.03), "matte", SLATS, bevel=0.008, segs=1, rot=rot)


def build_bollard():
    """A cast-iron bollard with a ball on top, about knee-high-and-a-half."""
    prof = [(0.0, 0.0), (0.095, 0.0), (0.095, 0.05), (0.08, 0.075), (0.07, 0.14), (0.058, 0.66), (0.07, 0.68), (0.07, 0.72), (0.05, 0.74), (0.045, 0.78)]
    prof += [(0.045 + 0.03 * math.sin(a), 0.82 + 0.04 * -math.cos(a)) for a in [i * math.pi / 6 for i in range(1, 6)]]
    prof += [(0.0, 0.86)]
    lathe(prof, 8, "iron", IRON)


def build_rack():
    """A steel hoop for bicycles along x, with a city bicycle leaning on its street side (+z)."""
    hoop = [V(-0.35, 0.0, 0), V(-0.35, 0.5, 0)] + arc(V(0, 0.5, 0), 0.35, 0.35, math.pi, 0, 10)[1:-1] + [V(0.35, 0.5, 0), V(0.35, 0.0, 0)]
    tube(hoop, 0.025, 8, "chrome", STEEL)
    # the bicycle, front to +x, leaning a little onto the hoop
    with group(Matrix.Translation(V(0.05, 0, 0.17)) @ Matrix.Rotation(math.radians(-7), 4, "X")):
        for x in (-0.53, 0.53):
            tube(arc(V(x, 0.34, 0), 0.33, 0.33, 0, 2 * math.pi, 20)[:-1], 0.02, 6, "rubber", DARK, closed=True)
            tube(arc(V(x, 0.34, 0), 0.305, 0.305, 0, 2 * math.pi, 20)[:-1], 0.008, 4, "chrome", STEEL, closed=True)
            cyl(V(x, 0.34, -0.04), V(x, 0.34, 0.04), 0.03, 0.03, 8, "chrome", STEEL)
            for k in range(4):
                a = k * math.pi / 4
                d = V(math.cos(a), math.sin(a), 0) * 0.3
                cyl(V(x, 0.34, 0) - d, V(x, 0.34, 0) + d, 0.003, 0.003, 3, "chrome", STEEL, caps=False)
        R, F = V(-0.53, 0.34, 0), V(0.53, 0.34, 0)
        BB, S = V(-0.06, 0.3, 0), V(-0.16, 0.8, 0)
        H1, H2 = V(0.36, 0.84, 0), V(0.4, 0.68, 0)
        for a, b in ((BB, S), (S, H1), (BB, H2), (BB, R + V(0, 0, 0.04)), (BB, R - V(0, 0, 0.04)), (S, R + V(0, 0, 0.04)), (S, R - V(0, 0, 0.04)), (H2, H1)):
            tube([a, b], 0.017, 6, "paint", WHITE)
        for dz in (0.045, -0.045):
            tube([H2 + V(0, 0, dz * 0.5), F + V(0, 0, dz)], 0.012, 5, "chrome", STEEL)
        tube([H1, V(0.33, 0.97, 0)], 0.013, 5, "chrome", STEEL)
        tube([V(0.27, 0.99, -0.26), V(0.33, 0.97, -0.18), V(0.33, 0.97, 0.18), V(0.27, 0.99, 0.26)], 0.012, 5, "chrome", STEEL)
        tube([S, V(-0.18, 0.88, 0)], 0.013, 5, "chrome", STEEL)
        box(V(-0.2, 0.9, 0), (0.25, 0.05, 0.13), "matte", DARK, bevel=0.02, segs=2)
        # a wicker basket on the handlebars
        box(V(0.5, 0.93, 0), (0.28, 0.2, 0.32), "matte", RATTAN, bevel=0.02, segs=1)
        # chain guard
        box(V(-0.3, 0.34, 0.035), (0.5, 0.06, 0.01), "paint", WHITE, bevel=0.004, segs=1)


def build_planter():
    """A long planter box with a clipped box hedge, the kind that fences a café terrace."""
    box(V(0, 0.24, 0), (1.25, 0.48, 0.44), "iron", IRON, bevel=0.015, segs=1)
    box(V(0, 0.49, 0), (1.29, 0.03, 0.48), "iron", IRON, bevel=0.01, segs=1)
    box(V(0, 0.68, 0), (1.18, 0.4, 0.38), "foliage", WHITE, bevel=0.14, segs=3)


def build_menu():
    """An A-frame chalkboard: two boards leaning together, chalk lines on the front one."""
    for side in (1, -1):
        # each board stands on its own foot and leans in, so the tops meet over the middle
        rot = Matrix.Rotation(math.radians(-11 * side), 4, "X")
        with group(Matrix.Translation(V(0, 0, side * 0.16)) @ rot):
            # frame, board, chalk: the board's centre at (0, 0.42, 0.012) once leaning
            box(V(0, 0.42, side * 0.012), (0.5, 0.82, 0.022), "matte", WOOD, bevel=0.006, segs=1)
            box(V(0, 0.45, side * 0.024), (0.42, 0.62, 0.004), "matte", DARK)
            if side > 0:
                for i, w in enumerate((0.3, 0.22, 0.26, 0.14, 0.24, 0.18)):
                    box(V(-0.04 + (0.3 - w) * 0.2, 0.7 - i * 0.085, 0.027), (w, 0.018, 0.003), "matte", (0.75, 0.75, 0.72))


def build_bin():
    """A litter bin: a ring on a post, a pale green bag hanging in it."""
    cyl(V(0, 0, -0.2), V(0, 1.02, -0.2), 0.03, 0.03, 8, "iron", IRON)
    sphere(V(0, 1.04, -0.2), 0.035, "iron", IRON, segs=8, rings=5)
    tube(arc(V(0, 0.95, 0), 0.2, 0.2, 0, 2 * math.pi, 16, plane="xz")[:-1], 0.014, 6, "iron", IRON, closed=True)
    tube([V(0, 0.95, -0.2), V(0, 0.95, -0.03)], 0.016, 6, "iron", IRON)
    bag = [(0.0, 0.36), (0.13, 0.36), (0.17, 0.42), (0.19, 0.6), (0.2, 0.85), (0.205, 0.95), (0.19, 0.95), (0.0, 0.93)]
    lathe(bag, 12, "matte", (0.30, 0.40, 0.30))


# ----------------------------------------------------------------------------- on the squares


def poster_uv_round(r):
    """UV in metres round a drum of radius r: u along its circumference, v up."""

    def uv(co, f):
        a = math.atan2(co.x, co.z)
        # keep a face from straddling the seam behind (-z)
        fc = f.calc_center_median()
        if math.atan2(fc.x, fc.z) > 0 and a < -math.pi / 2:
            a += 2 * math.pi
        elif math.atan2(fc.x, fc.z) < 0 and a > math.pi / 2:
            a -= 2 * math.pi
        return (a * r, co.y)

    return uv


def poster_uv_flat(co, f):
    """UV in metres on a flat wall: u along it, v up."""
    n = f.normal
    t = V(0, 1, 0).cross(n)
    if t.length < 1e-6:
        return (co.x, co.z)
    t.normalize()
    return (co.dot(t), co.y)


def build_column():
    """An advertising column: a drum of posters on an iron plinth, under a little ribbed dome."""
    lathe([(0, 0), (0.68, 0), (0.68, 0.12), (0.63, 0.18), (0.63, 0.3), (0.58, 0.34), (0, 0.34)], 24, "iron", IRON)
    lathe([(0, 0.33), (0.56, 0.33), (0.56, 2.62), (0, 2.62)], 24, "poster", WHITE, uv=poster_uv_round(0.56))
    lathe([(0, 2.6), (0.6, 2.6), (0.6, 2.74), (0.66, 2.78), (0.7, 2.86), (0.7, 2.92), (0.62, 2.95), (0, 2.95)], 24, "iron", IRON)
    dome = [(0, 2.94), (0.6, 2.94), (0.57, 3.08), (0.48, 3.26), (0.33, 3.4), (0.15, 3.49), (0.08, 3.54), (0.1, 3.6), (0.06, 3.68), (0.02, 3.76), (0, 3.78)]
    lathe(dome, 24, "iron", IRON)
    # ribs down the dome
    for i in range(8):
        a = i * math.pi / 4
        pts = [V(math.sin(a) * (r + 0.012), y, math.cos(a) * (r + 0.012)) for r, y in dome[1:6]]
        tube(pts, 0.014, 4, "iron", IRON)
    # a scalloped valance under the cornice
    for i in range(24):
        a = (i + 0.5) * 2 * math.pi / 24
        c = V(math.sin(a) * 0.62, 2.62, math.cos(a) * 0.62)
        sphere(c, 0.075, "iron", IRON, segs=6, rings=4, scale=(1.0, 0.7, 1.0))


def chamfer_plan(hx, hz, ch, d):
    """A rectangle (half sizes hx, hz) with its corners cut by ch, grown by d: 8 points round +y, starting at the front right."""
    hx, hz = hx + d, hz + d
    c = max(0.0, min(ch + d * 0.4, hx * 0.9, hz * 0.9))
    return [V(hx - c, 0, hz), V(hx, 0, hz - c), V(hx, 0, -hz + c), V(hx - c, 0, -hz), V(-hx + c, 0, -hz), V(-hx, 0, -hz + c), V(-hx, 0, hz - c), V(-hx + c, 0, hz)]


def plan_stack(hx, hz, ch, profile, paint, uv=None):
    """Like lathe, but round a chamfered rectangle: profile is (outset, height) points, bottom to top, flat shaded."""
    rings = []
    for d, y in profile:
        rings.append([p + V(0, y, 0) for p in chamfer_plan(hx, hz, ch, d)])
    bm = M.bm
    vr = [[bm.verts.new(p) for p in ring] for ring in rings]
    for a, b in zip(vr, vr[1:]):
        for k in range(8):
            m = (k + 1) % 8
            bm.faces.new((a[k], a[m], b[m], b[k]))
    bm.faces.new(vr[0])
    bm.faces.new(vr[-1])
    return finish(None, None, paint=paint, uv=uv)


def build_kiosk():
    """A news kiosk: an eight-sided iron booth, magazines all round, a cream sign band, a curved roof and a finial."""
    hx, hz, ch = 1.1, 0.78, 0.3

    def by_height(f):
        y = f.calc_center_median().y
        if y < 0.97:
            return "iron", IRON
        if y < 2.13:
            return "poster", (1.0, 0.34, 1.0)  # green: the size of a sheet (magazines, a third of a poster)
        if y < 2.44:
            return "matte", CREAM
        return "iron", IRON

    body = [(0.04, 0.0), (0.04, 0.12), (0.0, 0.15), (0.0, 0.95), (0.08, 0.95), (0.08, 1.0), (0.0, 1.0), (0.0, 2.13), (0.03, 2.13), (0.03, 2.44)]
    plan_stack(hx, hz, ch, body, by_height, uv=poster_uv_flat)
    roof = [(0.03, 2.44), (0.14, 2.47), (0.17, 2.53), (0.17, 2.58), (0.06, 2.68), (-0.2, 2.86), (-0.45, 2.99), (-0.66, 3.06), (-0.72, 3.07)]
    plan_stack(hx, hz, ch, roof, lambda f: ("iron", IRON))
    # the finial
    lathe([(0, 3.05), (0.1, 3.05), (0.12, 3.12), (0.07, 3.2), (0.09, 3.28), (0.04, 3.36), (0.02, 3.5), (0, 3.52)], 10, "iron", IRON)
    # the front's counter of newspapers and the flap that shades it
    box(V(0, 1.02, hz + 0.16), (1.3, 0.05, 0.3), "iron", IRON, bevel=0.01, segs=1)
    for i in range(5):
        box(V(-0.5 + i * 0.25, 1.06, hz + 0.16), (0.21, 0.025, 0.27), "poster", (1.0, 0.3, 1.0))
    rot = Matrix.Rotation(math.radians(28), 4, "X")
    box(V(0, 2.2, hz + 0.24), (1.5, 0.03, 0.55), "iron", IRON, bevel=0.01, segs=1, rot=rot)


def build_metro():
    """
    A metro entrance in the Art Nouveau manner: an iron balustrade round three sides of the stairwell,
    its front open (+z), two lamp stalks rising from the front posts with orange globes, a sign between them.
    """
    hx, z0, z1 = 0.86, -2.05, 2.0
    # the stairwell and its stone kerb
    quad([V(-0.8, 0.012, z0 + 0.05), V(0.8, 0.012, z0 + 0.05), V(0.8, 0.012, z1), V(-0.8, 0.012, z1)], "void", DARK, (0, 1, 0), uv=lambda co, f: (co.x, z1 - co.z))
    for sx in (-1, 1):
        box(V(sx * hx, 0.05, (z0 + z1) / 2), (0.16, 0.1, z1 - z0 + 0.16), "matte", STONE, bevel=0.01, segs=1)
    box(V(0, 0.05, z0), (2 * hx + 0.16, 0.1, 0.16), "matte", STONE, bevel=0.01, segs=1)
    # posts
    posts = [V(sx * hx, 0, z) for sx in (-1, 1) for z in (z0, -1.0, 0.0, 1.0, z1)] + [V(0, 0, z0)]
    for p in posts:
        lathe([(0, 0.1), (0.05, 0.1), (0.04, 0.16), (0.03, 0.9), (0.045, 0.95), (0.03, 1.0), (0, 1.02)], 8, "iron", IRON, base=p)
    # rails along the U
    path_top = [V(-hx, 0.93, z1), V(-hx, 0.93, z0), V(hx, 0.93, z0), V(hx, 0.93, z1)]
    path_bot = [V(-hx, 0.16, z1), V(-hx, 0.16, z0), V(hx, 0.16, z0), V(hx, 0.16, z1)]
    tube(path_top, 0.022, 6, "iron", IRON)
    tube(path_bot, 0.015, 6, "iron", IRON)
    # the panels between: bars and a ring in each
    spans = []
    for sx in (-1, 1):
        zs = (z0, -1.0, 0.0, 1.0, z1)
        for a, b in zip(zs, zs[1:]):
            spans.append((V(sx * hx, 0, a), V(sx * hx, 0, b)))
    spans += [(V(-hx, 0, z0), V(0, 0, z0)), (V(0, 0, z0), V(hx, 0, z0))]
    for a, b in spans:
        d = b - a
        n = max(2, int(d.length / 0.13))
        for i in range(1, n):
            p = a + d * (i / n)
            box(p + V(0, 0.545, 0), (0.014, 0.77, 0.014), "iron", IRON)
        mid = (a + b) / 2 + V(0, 0.55, 0)
        along = d.normalized()
        ring = [mid + along * (0.3 * math.cos(t)) + V(0, 0.22 * math.sin(t), 0) for t in [k * 2 * math.pi / 14 for k in range(14)]]
        tube(ring, 0.018, 5, "iron", IRON, closed=True)
    # the lamp stalks: up from the front posts, leaning in, a globe at the top of each
    for sx in (-1, 1):
        pts = [V(sx * hx, 0.95, z1), V(sx * hx, 1.6, z1), V(sx * hx * 0.98, 2.2, z1), V(sx * hx * 0.9, 2.7, z1 + 0.02), V(sx * hx * 0.76, 3.05, z1 + 0.06), V(sx * hx * 0.6, 3.2, z1 + 0.1), V(sx * 0.42, 3.18, z1 + 0.14)]
        tube(pts, 0.035, 6, "iron", IRON)
        sphere(V(sx * 0.36, 3.06, z1 + 0.16), 0.11, "lamp", GLOBE, segs=10, rings=7, scale=(0.9, 1.25, 0.9))
        cyl(V(sx * 0.36, 3.17, z1 + 0.16), V(sx * 0.42, 3.19, z1 + 0.14), 0.04, 0.03, 6, "iron", IRON)
    # the sign: a plate between the stalks, framed in iron, no lettering
    box(V(0, 2.62, z1), (1.5, 0.36, 0.05), "iron", IRON, bevel=0.03, segs=2)
    box(V(0, 2.62, z1), (1.36, 0.24, 0.07), "matte", SIGN, bevel=0.01, segs=1)
    # brackets from the stalks to the sign
    for sx in (-1, 1):
        tube([V(sx * hx * 0.97, 2.4, z1), V(sx * 0.72, 2.52, z1)], 0.018, 5, "iron", IRON)


def build_fountain():
    """A drinking fountain in the manner of the Paris ones: four figures holding up a little dome over a spout."""
    lathe([(0, 0), (0.52, 0), (0.52, 0.12), (0.46, 0.18), (0.46, 0.3), (0.4, 0.34), (0, 0.34)], 8, "iron", IRON, smooth=False, a0=math.pi / 8)
    lathe([(0, 0.33), (0.36, 0.33), (0.31, 0.42), (0.26, 0.52), (0.24, 0.9), (0.28, 0.95), (0.31, 1.02), (0.25, 1.07), (0, 1.07)], 16, "iron", IRON)
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        c = V(math.sin(a) * 0.17, 0, math.cos(a) * 0.17)
        lathe([(0, 1.06), (0.11, 1.06), (0.1, 1.3), (0.075, 1.6), (0.058, 1.76), (0.075, 1.86), (0.07, 1.96), (0.04, 2.01), (0, 2.02)], 10, "iron", IRON, base=c)
        sphere(c + V(0, 2.08, 0), 0.058, "iron", IRON, segs=8, rings=6)
        out = V(math.sin(a), 0, math.cos(a))
        side = V(math.cos(a), 0, -math.sin(a))
        for s in (-1, 1):
            tube([c + V(0, 1.93, 0) + side * (0.06 * s), c + V(0, 2.06, 0) + side * (0.075 * s) + out * 0.02, c + V(0, 2.25, 0) + side * (0.05 * s) + out * 0.04], 0.018, 5, "iron", IRON)
    cyl(V(0, 1.06, 0), V(0, 2.28, 0), 0.045, 0.045, 8, "iron", IRON)
    dome = [(0, 2.25), (0.43, 2.25), (0.45, 2.3), (0.39, 2.36), (0.33, 2.44), (0.26, 2.56), (0.16, 2.66), (0.08, 2.72), (0.05, 2.78), (0.07, 2.82), (0.03, 2.88), (0, 2.9)]
    lathe(dome, 16, "iron", IRON)
    for i in range(16):
        a = (i + 0.5) * 2 * math.pi / 16
        sphere(V(math.sin(a) * 0.43, 2.23, math.cos(a) * 0.43), 0.05, "iron", IRON, segs=6, rings=4, scale=(1.0, 0.8, 1.0))


# ----------------------------------------------------------------------------- the cars


def car_section(hw, y0, y1, tuck=0.035, far=False):
    """
    One rounded cross-section of a car's lower body round the z axis, at half width hw from y0 to y1:
    16 points, or 8 for the far version.
    """
    h = y1 - y0
    rb = min(0.07, h * 0.3)
    rt = min(0.13, h * 0.4)
    ht = hw - tuck  # the shoulders a little in from the widest point
    if far:
        right = [V(hw - rb * 0.6, y0, 0), V(hw, y0 + h * 0.45, 0), V(ht - rt * 0.5, y1, 0)]
        return right + [V(-p.x, p.y, 0) for p in reversed(right)]
    pts = [V(0, y0, 0)]
    for k in range(3):
        a = -math.pi / 2 + (k + 0.5) * (math.pi / 2) / 3
        pts.append(V(hw - rb + rb * math.cos(a), y0 + rb + rb * math.sin(a), 0))
    pts.append(V(hw, y0 + h * 0.45, 0))
    for k in range(3):
        a = (k + 0.5) * (math.pi / 2) / 3
        pts.append(V(ht - rt + rt * math.cos(a), y1 - rt + rt * math.sin(a), 0))
    pts.append(V(0, y1, 0))
    right = pts[1:8]
    left = [V(-p.x, p.y, 0) for p in reversed(right)]
    return pts + left


def build_car(spec, far=False):
    """
    A generic car: a lofted lower body with wheel arches, a cabin of glass and pillars on top, wheels,
    lamps, bumpers and number plates. The paint takes the instance's colour. Front is +z.
    far: the version drawn beyond a few dozen metres, about a tenth of the triangles, the same outline.
    """
    L, W = spec["L"], spec["W"]
    hl = L / 2
    rw = spec["wheel"]
    zf = hl - spec["front_overhang"]
    zr = zf - spec["wheelbase"]
    belt = spec["belt"]
    ra = rw + 0.065  # the arches' radius
    cf, cr = spec.get("corner_front", 0.3), spec.get("corner_rear", 0.24)

    def half_width(z):
        if z > hl - cf:
            u = (z - (hl - cf)) / cf
            return W / 2 - cf + cf * math.sqrt(max(0.0, 1 - u * u)) * 0.92 + cf * 0.08
        if z < -hl + cr:
            u = ((-hl + cr) - z) / cr
            return W / 2 - cr + cr * math.sqrt(max(0.0, 1 - u * u)) * 0.92 + cr * 0.08
        return W / 2

    def top(z):
        return spec["top"](z)

    def bottom(z):
        y = 0.2
        if z > hl - 0.5:
            y += (z - (hl - 0.5)) * 0.2
        if z < -hl + 0.5:
            y += ((-hl + 0.5) - z) * 0.25
        for zw in (zf, zr):
            if abs(z - zw) < ra:
                y = max(y, rw + math.sqrt(ra * ra - (z - zw) ** 2))
        return y

    # sections: close together round the arches and the ends
    zs = set()
    steps = 1 if far else 6
    for i in range(steps + 1):
        zs.add(-hl + 0.002 + cr * i / steps)
        zs.add(hl - 0.002 - cf * i / steps)
    for zw in (zf, zr):
        for i in range(-steps, steps + 1):
            zs.add(zw + ra * i / steps)
    for i in range(1, 3 if far else 12):
        zs.add(-hl + L * i / (3 if far else 12))
    zs = sorted(z for z in zs if -hl < z < hl)
    # merge sections closer than 3 cm
    merged = []
    for z in zs:
        if not merged or z - merged[-1] > (0.3 if far else 0.03):
            merged.append(z)
    rings = []
    for z in merged:
        rings.append([p + V(0, 0, z) for p in car_section(half_width(z), bottom(z), top(z), far=far)])
    loft(rings, "paint", WHITE, smooth=True)

    # the cabin: a side profile, narrower at the roof
    prof = spec["cabin"]  # (z, y) points, front to back over the top
    hb = W / 2 - 0.06
    hr = W / 2 - 0.2
    roof = max(y for _, y in prof)

    def hw_at(y):
        t = (y - belt) / max(roof - belt, 1e-6)
        return hb + (hr - hb) * t

    bm = M.bm
    right = [bm.verts.new(V(hw_at(y), y, z)) for z, y in prof]
    left = [bm.verts.new(V(-hw_at(y), y, z)) for z, y in prof]
    n = len(prof)
    bm.faces.new(right)
    bm.faces.new(list(reversed(left)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((right[i], right[j], left[j], left[i]))
    vs = fresh_verts()
    bmesh.ops.recalc_face_normals(M.bm, faces=fresh_faces())
    edges = [e for e in {e for v in vs for e in v.link_edges} if not all(abs(v.co.y - belt) < 1e-4 for v in e.verts)]
    if not far:
        bmesh.ops.bevel(M.bm, geom=edges, offset=0.045, offset_type="OFFSET", segments=2, profile=0.5, affect="EDGES", clamp_overlap=True)
    glass_z = spec.get("glass_z", (-hl, hl))

    def cabin_paint(f):
        nrm = f.normal
        c = f.calc_center_median()
        if c.y < belt + 0.02:
            return "paint", WHITE
        side = abs(nrm.x) > 0.8
        front = nrm.z > 0.35 and nrm.y < 0.92
        back = nrm.z < -0.35 and nrm.y < 0.92
        if side and glass_z[0] < c.z < glass_z[1]:
            return "glass", DARK
        if (front or back) and not side and abs(nrm.x) < 0.5:
            return "glass", DARK
        return "paint", WHITE

    finish(None, None, paint=cabin_paint, recalc=False)

    # pillars between the side windows: dark strips just proud of the glass
    for zb in [] if far else spec.get("pillars", []):
        for sx in (-1, 1):
            y0, y1 = belt + 0.02, roof - 0.07
            pts = []
            for z, y in ((zb - 0.045, y0), (zb + 0.045, y0), (zb + 0.045, y1), (zb - 0.045, y1)):
                pts.append(V(sx * (hw_at(y) + 0.006), y, z))
            quad(pts, "plastic", DARK, (sx, 0, 0))

    # panels over the glass where there are no windows (a van's load space)
    for za, zb in spec.get("panels", []):
        for sx in (-1, 1):
            y0, y1 = belt + 0.01, roof - 0.06
            pts = [V(sx * (hw_at(y) + 0.004), y, z) for z, y in ((za, y0), (zb, y0), (zb, y1), (za, y1))]
            quad(pts, "paint", WHITE, (sx, 0, 0))

    # wheels: tyre, rim, hub
    for zw in (zf, zr):
        for sx in (-1, 1):
            xo = sx * (W / 2 - 0.035)
            xi = sx * (W / 2 - 0.235)
            if far:
                cyl(V(xi, rw, zw), V(xo, rw, zw), rw, rw, 6, "rubber", DARK, smooth=False)
                continue
            cyl(V(xi, rw, zw), V(xo, rw, zw), rw, rw, 18, "rubber", DARK)
            cyl(V(xo - sx * 0.01, rw, zw), V(xo + sx * 0.006, rw, zw), rw * 0.62, rw * 0.58, 14, "chrome", STEEL)
            cyl(V(xo, rw, zw), V(xo + sx * 0.012, rw, zw), rw * 0.18, rw * 0.14, 8, "plastic", DARK)
    # the shade under the car (the shader keeps it dark)
    quad([V(-W / 2 + 0.08, 0.015, -hl + 0.25), V(W / 2 - 0.08, 0.015, -hl + 0.25), V(W / 2 - 0.08, 0.015, hl - 0.25), V(-W / 2 + 0.08, 0.015, hl - 0.25)], "void", (0.0, 0.0, 0.0), (0, 1, 0), uv=lambda co, f: (co.x / (W / 2), co.z / hl))

    # front: lamps, grille, bumper, plate
    yl = spec["lamp_y"]
    zfr = hl - 0.004
    hwf = half_width(hl - 0.06)
    hwr = half_width(-hl + 0.06)
    if far:
        return
    for sx in (-1, 1):
        box(V(sx * (hwf - 0.2), yl, zfr - 0.03), (0.26, 0.11, 0.08), "plastic", (0.8, 0.8, 0.78), bevel=0.02, segs=2)
    box(V(0, yl - 0.05, zfr - 0.02), (2 * hwf - 0.75, 0.13, 0.06), "plastic", DARK, bevel=0.015, segs=1)
    box(V(0, 0.33, zfr - 0.03), (2 * hwf - 0.1, 0.16, 0.1), "plastic", (0.03, 0.03, 0.035), bevel=0.03, segs=2)
    box(V(0, 0.33, zfr + 0.02), (0.5, 0.11, 0.01), "plastic", (0.85, 0.85, 0.85))
    # rear: lamps, bumper, plate
    zrr = -hl + 0.004
    hwr = half_width(-hl + 0.06)
    ytl = spec["tail_y"]
    for sx in (-1, 1):
        box(V(sx * (hwr - 0.14), ytl, zrr + 0.03), (0.22, 0.12, 0.08), "plastic", (0.45, 0.02, 0.02), bevel=0.02, segs=2)
    box(V(0, 0.34, zrr + 0.03), (2 * hwr - 0.1, 0.16, 0.1), "plastic", (0.03, 0.03, 0.035), bevel=0.03, segs=2)
    box(V(0, ytl - 0.02, zrr - 0.008), (0.5, 0.11, 0.01), "plastic", (0.85, 0.85, 0.85))
    # door mirrors and handles
    zm = spec["mirror_z"]
    for sx in (-1, 1):
        box(V(sx * (hb + 0.09), belt + 0.1, zm), (0.14, 0.1, 0.07), "paint", WHITE, bevel=0.025, segs=2)
        for zh in spec.get("handles", []):
            box(V(sx * (W / 2 - 0.02), belt - 0.07, zh), (0.02, 0.025, 0.14), "plastic", (0.05, 0.05, 0.05), bevel=0.006, segs=1)


def smooth_top(points):
    """A function of z through (z, y) points (piecewise linear, ends held)."""
    pts = sorted(points)

    def f(z):
        if z <= pts[0][0]:
            return pts[0][1]
        for (za, ya), (zb, yb) in zip(pts, pts[1:]):
            if z <= zb:
                t = (z - za) / (zb - za)
                t = t * t * (3 - 2 * t)
                return ya + (yb - ya) * t
        return pts[-1][1]

    return f


CARS = {
    "car_hatch": dict(
        L=3.95, W=1.74, wheel=0.3, front_overhang=0.74, wheelbase=2.47, belt=0.93,
        top=smooth_top([(-1.975, 0.78), (-1.9, 0.92), (-1.8, 0.93), (1.0, 0.93), (1.6, 0.84), (1.9, 0.72), (1.975, 0.66)]),
        cabin=[(1.0, 0.93), (0.32, 1.42), (-1.35, 1.46), (-1.86, 0.96), (-1.84, 0.93)],
        pillars=[-0.35], glass_z=(-1.75, 0.9), lamp_y=0.66, tail_y=0.95, mirror_z=0.88, handles=[0.05, -0.85],
        corner_front=0.32, corner_rear=0.22,
    ),
    "car_saloon": dict(
        L=4.6, W=1.8, wheel=0.31, front_overhang=0.86, wheelbase=2.7, belt=0.9,
        top=smooth_top([(-2.3, 0.84), (-2.15, 0.93), (-1.5, 0.95), (0.95, 0.9), (1.7, 0.82), (2.15, 0.72), (2.3, 0.64)]),
        cabin=[(0.95, 0.9), (0.2, 1.38), (-0.95, 1.41), (-1.55, 0.95), (-1.6, 0.92)],
        pillars=[-0.3], glass_z=(-1.4, 0.85), lamp_y=0.64, tail_y=0.86, mirror_z=0.82, handles=[0.05, -0.75],
        corner_front=0.34, corner_rear=0.26,
    ),
    "car_van": dict(
        L=4.4, W=1.84, wheel=0.32, front_overhang=0.82, wheelbase=2.75, belt=0.98,
        top=smooth_top([(-2.2, 0.98), (1.15, 0.98), (1.75, 0.92), (2.1, 0.8), (2.2, 0.72)]),
        cabin=[(1.2, 0.98), (0.6, 1.72), (0.35, 1.84), (-2.17, 1.86), (-2.19, 0.98)],
        pillars=[], panels=[(-2.12, -0.42)], glass_z=(-2.2, 1.15), lamp_y=0.74, tail_y=0.92, mirror_z=1.05, handles=[0.3, -0.6],
        corner_front=0.3, corner_rear=0.12,
    ),
}

# ----------------------------------------------------------------------------- build everything

BUILDERS = {
    "terrace": build_terrace,
    "parasol": build_parasol,
    "bench": build_bench,
    "bollard": build_bollard,
    "rack": build_rack,
    "planter": build_planter,
    "menu": build_menu,
    "bin": build_bin,
    "column": build_column,
    "kiosk": build_kiosk,
    "metro": build_metro,
    "fountain": build_fountain,
}
for name, spec in CARS.items():
    BUILDERS[name] = (lambda s: lambda: build_car(s))(spec)
# the far versions (src/city/kit.ts: KIT_SPEC's far)
BUILDERS["parasol_far"] = lambda: build_parasol(far=True)
for name, spec in CARS.items():
    BUILDERS[name + "_far"] = (lambda s: lambda: build_car(s, far=True))(spec)

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
scene = bpy.context.scene
material = bpy.data.materials.new("Kit")

nt = material.node_tree
attr = nt.nodes.new("ShaderNodeAttribute")
attr.attribute_name = "Tint"
nt.links.new(attr.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
nt.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6

TO_BLENDER = Matrix.Rotation(math.pi / 2, 4, "X")  # game (x, y, z) -> Blender (x, -z, y)
info = {}
objects = {}
for name, build in BUILDERS.items():
    M = Model(name)
    build()
    bm = M.bm
    lo = Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))
    hi = Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))
    bmesh.ops.transform(bm, matrix=TO_BLENDER, verts=bm.verts)
    bm.faces.layers.int.remove(M.done)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    mesh.color_attributes.active_color = mesh.color_attributes["Tint"]
    mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    objects[name] = obj
    mesh.calc_loop_triangles()
    tris = len(mesh.loop_triangles)
    info[name] = {"triangles": tris, "min": [round(c, 3) for c in lo], "max": [round(c, 3) for c in hi]}
    print(f"built {name}: {tris} triangles, {len(mesh.vertices)} vertices, {hi.x - lo.x:.2f} x {hi.y - lo.y:.2f} x {hi.z - lo.z:.2f} m")

# ----------------------------------------------------------------------------- preview

if PREVIEW:
    # a line-up of everything (linked copies), lit by a sun and a sky, rendered in Cycles on the CPU
    order = list(BUILDERS) if opt("shots", "all") == "all" else opt("shots", "all").split(",")
    copies = []
    x = 0.0
    for name in order:
        w = max(info[name]["max"][0] - info[name]["min"][0], info[name]["max"][2] - info[name]["min"][2]) if opt("yaw", 0.0) else info[name]["max"][0] - info[name]["min"][0]
        c = objects[name].copy()
        x += w / 2 + 0.6
        c.location = (x, 0, 0)
        c.rotation_euler = (0, 0, math.radians(opt("yaw", 0.0)))
        x += w / 2
        scene.collection.objects.link(c)
        copies.append(c)
    mid = x / 2
    for o in objects.values():
        o.hide_render = True
    ground = bpy.data.meshes.new("ground")
    gb = bmesh.new()
    bmesh.ops.create_grid(gb, x_segments=1, y_segments=1, size=60)
    gb.to_mesh(ground)
    gb.free()
    gmat = bpy.data.materials.new("Ground")

    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.31, 0.29, 1)
    ground.materials.append(gmat)
    go = bpy.data.objects.new("ground", ground)
    go.location = (mid, 0, 0)
    scene.collection.objects.link(go)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new("sky")

    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.65, 0.8, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = 50
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(opt("samples", 24))
    scene.cycles.use_denoising = False
    shots = opt("shots", "all")
    rows = [order[:8], order[8:]] if shots == "all" else [shots.split(",")]
    for i, row in enumerate(rows):
        for c in copies:
            c.hide_render = c.data.name not in row
        xs = [c.location.x for c in copies if c.data.name in row]
        cx = (min(xs) + max(xs)) / 2
        span = max(xs) - min(xs) + 5
        cam.data.lens = 40
        dist = span * 0.95
        cam.location = (cx, -dist, dist * 0.32)
        cam.rotation_euler = (math.radians(75), 0, 0)
        scene.render.resolution_x = 1800
        scene.render.resolution_y = 640
        scene.render.filepath = os.path.join(OUT, f"lineup-{i}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", scene.render.filepath)
    for c in copies:
        bpy.data.objects.remove(c, do_unlink=True)
    for o in (go, sun, cam):
        bpy.data.objects.remove(o, do_unlink=True)
    for o in objects.values():
        o.hide_render = False

# ----------------------------------------------------------------------------- export

bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT, "street-raw.glb"),
    export_format="GLB",
    use_selection=False,
    export_yup=True,
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_vertex_color="NAME",
    export_vertex_color_name="Tint",
    export_all_vertex_colors=False,
    export_materials="NONE",
    export_extras=False,
    export_cameras=False,
    export_lights=False,
)
with open(os.path.join(OUT, "street.json"), "w") as fh:
    json.dump({"kinds": KINDS, "models": info}, fh, indent=2)
print("exported", os.path.join(OUT, "street-raw.glb"))
