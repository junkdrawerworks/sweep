"""The Sweep stand: a plate that the RPLIDAR A1M8 screws onto, with a captive 1/4"-20 nut so it sits on any camera
tripod, and an apron that holds the lidar's USB adapter board with two zip ties.

    python3 hardware/sweep_stand.py      writes hardware/sweep-stand.stl and hardware/sweep-fit-test.stl

Needs manifold3d and trimesh (pip install manifold3d trimesh). Each STL is written to a temporary file first and
only replaces the old one once the export has succeeded and the mesh checks out (one closed solid, the right size).

Coordinates are the lidar's own: the origin is the middle of the spinning turret, x runs along the lidar (its motor
end is -x), and z = 0 is the bottom of the lidar's four feet, which is the plate's top face. The feet are four hex
standoffs, 5 mm across the flats and 8 mm tall, with a 2.0 mm bore: M2.5 thread. Their positions come from a model of
the A1M8 (hidmic/airi-hw, RPLIDAR-A1M8-R1.stl): (-41.77, +-20) and (28.23, +-28). The fit test settles whether they
match a real lidar before the full print.

The STLs are written upside down, the way they print: the plate's top face (the one the lidar stands on) on the
build plate, so it comes out flat, and the nut slot's roof is a short bridge.
"""
import os
import sys
import tempfile

import numpy as np
from manifold3d import CrossSection, Manifold, JoinType, OpType, set_circular_segments
import trimesh

set_circular_segments(96)
HERE = os.path.dirname(os.path.abspath(__file__))

# ---- the lidar (measured from the model; see the docstring) ----
FEET = [(-41.77, 20.0), (-41.77, -20.0), (28.23, 28.0), (28.23, -28.0)]
FOOT_AF = 5.0                      # hex standoffs, 5 mm across the flats
CONNECTOR = (-10.0, 10.5, 24.0, 30.0)  # x0, x1, y0, y1 of the 7-pin socket under the lidar; its plug goes in from below

# ---- screws: M2.5 x 6 mm, from below, into the bottom of the lidar's feet ----
SCREW_CLEAR = 2.9                  # through hole (M2.5 clearance; an M2 or a 2-56 also passes)
SCREW_LEN = 6.0                    # M2.5 x 6 mm
UNDER_HEAD = 2.5                   # plastic under each screw head: so each screw goes 3.5 mm into its foot
HEAD_D = 7.4                       # counterbore, wide enough for an M3 washer (7 mm) as a spacer if a screw is long

# ---- the tripod nut: 1/4"-20 hex, 7/16" (11.11 mm) across the flats, 7/32" (5.56 mm) thick ----
NUT_AF, NUT_T = 11.11 + 0.25, 5.56 + 0.5
NUT_AT = (-7.0, 0.0)               # under the lidar, between its feet, clear of the motor and the socket
TRIPOD_HOLE = 6.9                  # 1/4" (6.35 mm) screw, with room
FLOOR = 2.0                        # plastic between the tripod and the nut: a tripod screw needs to reach through it
BOSS_D = 30.0

# ---- the plate ----
PLATE = (-50.0, 37.0, -36.0, 36.0)  # x0, x1, y0, y1 under the lidar
APRON = (-24.0, 24.0, 20.0, 84.0)   # beside it, on the socket side, for the USB adapter board
CORNER = 7.0
TIE = (2.4, 5.2)                   # zip-tie slot, for ties up to 4.8 mm wide
BOARD_TIES_X = 17.0                # two slots per tie, 34 mm apart: boards up to about 32 mm wide fit between
BOARD_TIES_Y = (52.0, 70.0)
CABLE_TIE_Y, CABLE_TIE_X = 80.0, 7.0   # one more tie around the USB cable, so a tug pulls the stand, not the board


def rounded_rect(x0, x1, y0, y1, r):
    return CrossSection.square([x1 - x0 - 2 * r, y1 - y0 - 2 * r]).translate([x0 + r, y0 + r]).offset(r, JoinType.Round)


def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def cyl(x, y, d, z0, z1):
    return Manifold.cylinder(z1 - z0, d / 2).translate([x, y, z0])


def hexagon(af):
    """A hexagon with flats facing +-x (so it slides along y), af across the flats."""
    return CrossSection.circle(af / np.sqrt(3), 6).rotate(30)


def stand(thick=5.0, apron=True, counterbore=True, lighten=False):
    outline = rounded_rect(*PLATE, CORNER)
    if apron:
        outline = outline + rounded_rect(*APRON, CORNER)
    body = outline.extrude(thick).translate([0, 0, -thick])
    nx, ny = NUT_AT
    boss_bottom = -thick - FLOOR - NUT_T
    body = body + cyl(nx, ny, BOSS_D, boss_bottom, -thick + 0.01)
    cut = []
    for x, y in FEET:
        cut.append(cyl(x, y, SCREW_CLEAR, -thick - 1, 1))
        if counterbore:
            cut.append(cyl(x, y, HEAD_D, -thick - 1, -UNDER_HEAD))
    # the socket's plug comes down through the plate; the slot runs on under the lidar's edge so the cable can lie flat
    x0, x1, y0, y1 = CONNECTOR
    cut.append(box(x0 - 3, x1 + 3, y0 - 3, (APRON[2] + 20) if apron else y1 + 4, -thick - 1, 1))
    # the tripod screw: up through the floor, the nut, the plate, and on into the gap under the lidar
    cut.append(cyl(nx, ny, TRIPOD_HOLE, boss_bottom - 1, 1))
    # the nut slides in from the boss's side (-y) and sits over the hole
    nut = hexagon(NUT_AF)
    slot = CrossSection.batch_hull([nut.translate([nx, ny]), nut.translate([nx, ny - BOSS_D])])
    cut.append(slot.extrude(NUT_T).translate([0, 0, boss_bottom + FLOOR]))
    if apron:
        for ty in BOARD_TIES_Y:
            for sx in (-1, 1):
                cut.append(box(sx * BOARD_TIES_X - TIE[0] / 2, sx * BOARD_TIES_X + TIE[0] / 2, ty - TIE[1] / 2, ty + TIE[1] / 2, -thick - 1, 1))
        for sx in (-1, 1):
            cut.append(box(sx * CABLE_TIE_X - TIE[0] / 2, sx * CABLE_TIE_X + TIE[0] / 2, CABLE_TIE_Y - TIE[1] / 2, CABLE_TIE_Y + TIE[1] / 2, -thick - 1, 1))
    if lighten:
        # the fit test only needs the feet, the socket and the nut: open the middle up to print faster
        keep = 7.5
        hole = CrossSection.hull_points([[x, y] for x, y in FEET]).offset(-keep, JoinType.Round)
        hole = hole - CrossSection.circle(BOSS_D / 2 + 4).translate([nx, ny])
        hole = hole - CrossSection.square([x1 - x0 + 6 + 2 * keep, 60]).translate([x0 - 3 - keep, y0 - 3 - keep])
        cut.append(hole.extrude(thick + 2).translate([0, 0, -thick - 1]))
    return body - Manifold.batch_boolean(cut, OpType.Add)


def printable(m):
    """Upside down, as it prints: the lidar's face on the build plate, then moved to sit at z = 0."""
    flipped = m.mirror([0, 0, 1])  # z -> -z puts the top face (z = 0) at the bottom
    lo = flipped.bounding_box()
    return flipped.translate([0, 0, -lo[2]])


def write_stl(m, name, expect):
    mesh = m.to_mesh()
    tm = trimesh.Trimesh(vertices=np.asarray(mesh.vert_properties)[:, :3], faces=np.asarray(mesh.tri_verts), process=True)
    size = tm.extents
    problems = []
    if not tm.is_watertight:
        problems.append('not watertight')
    if len(tm.split(only_watertight=False)) != 1:
        problems.append('more than one piece')
    if tm.volume <= 0:
        problems.append('no volume')
    for got, want, axis in zip(size, expect, 'xyz'):
        if abs(got - want) > 0.05:
            problems.append(f'{axis} is {got:.2f} mm, expected {want:.2f}')
    if problems:
        sys.exit(f'{name}: not written: {", ".join(problems)}')
    path = os.path.join(HERE, name)
    fd, tmp = tempfile.mkstemp(suffix='.stl', dir=HERE)
    os.close(fd)
    try:
        tm.export(tmp)
        check = trimesh.load(tmp)
        if not check.is_watertight or abs(check.volume - tm.volume) > 1e-3 * tm.volume:
            sys.exit(f'{name}: the exported file does not read back the same; not written')
        os.replace(tmp, path)
        os.chmod(path, 0o644)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    print(f'{name}: {size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} mm, {tm.volume / 1000:.1f} cm3, {len(tm.faces)} triangles')
    return tm


def main():
    thick = 5.0
    full = printable(stand(thick=thick))
    boss_h = FLOOR + NUT_T
    write_stl(full, 'sweep-stand.stl', (PLATE[1] - PLATE[0], APRON[3] - PLATE[2], thick + boss_h))
    # the fit test is the plate's frame at the thickness under the screw heads, so the same screws test the same reach
    test = printable(stand(thick=UNDER_HEAD, apron=False, counterbore=False, lighten=True))
    write_stl(test, 'sweep-fit-test.stl', (PLATE[1] - PLATE[0], PLATE[3] - PLATE[2], UNDER_HEAD + boss_h))


if __name__ == '__main__':
    main()
