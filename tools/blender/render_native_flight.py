import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import textwrap
import traceback
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector


def parse_args():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Render a Flight native timeline with Blender")
    parser.add_argument("--timeline", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--frames-dir", required=True)
    parser.add_argument("--samples", type=int, default=48)
    parser.add_argument("--keep-frames", action="store_true")
    return parser.parse_args(args)


def sim_vec(value):
    return Vector((float(value["x"]), float(value["z"]), float(value["y"])))


def vec3(x, y, z):
    return {"x": x, "y": y, "z": z}


def rotate_sim(q, v):
    x2 = q["x"] + q["x"]
    y2 = q["y"] + q["y"]
    z2 = q["z"] + q["z"]
    xx = q["x"] * x2
    xy = q["x"] * y2
    xz = q["x"] * z2
    yy = q["y"] * y2
    yz = q["y"] * z2
    zz = q["z"] * z2
    wx = q["w"] * x2
    wy = q["w"] * y2
    wz = q["w"] * z2
    return {
        "x": (1 - (yy + zz)) * v["x"] + (xy - wz) * v["y"] + (xz + wy) * v["z"],
        "y": (xy + wz) * v["x"] + (1 - (xx + zz)) * v["y"] + (yz - wx) * v["z"],
        "z": (xz - wy) * v["x"] + (yz + wx) * v["y"] + (1 - (xx + yy)) * v["z"],
    }


def pose_matrix(position, orientation):
    right = sim_vec(rotate_sim(orientation, vec3(1, 0, 0)))
    back = sim_vec(rotate_sim(orientation, vec3(0, 0, 1)))
    up = sim_vec(rotate_sim(orientation, vec3(0, 1, 0)))
    loc = sim_vec(position)
    return Matrix(
        (
            (right.x, back.x, up.x, loc.x),
            (right.y, back.y, up.y, loc.y),
            (right.z, back.z, up.z, loc.z),
            (0, 0, 0, 1),
        )
    )


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def configure_scene(timeline, samples):
    scene = bpy.context.scene
    split = is_split_timeline(timeline)
    scene.frame_start = 0
    scene.frame_end = max(0, len(timeline["frames"]) - 1)
    scene.render.fps = int(timeline["fps"])
    scene.render.resolution_x = max(1, int(timeline["width"]) // 2) if split else int(timeline["width"])
    scene.render.resolution_y = int(timeline["height"])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = max(1, int(samples))
    for attr, value in (("use_gtao", True), ("gtao_distance", 4), ("gtao_factor", 1.4)):
        if hasattr(scene.eevee, attr):
            setattr(scene.eevee, attr, value)
    scene.world = bpy.data.worlds.new("Flight World")
    scene.world.color = (0.58, 0.7, 0.78)
    scene.view_settings.view_transform = "Filmic"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = -0.15
    scene.view_settings.gamma = 1


def is_split_timeline(timeline):
    return timeline.get("layout") == "split-screen" or any(frame.get("externalCamera") for frame in timeline.get("frames", []))


class MaterialCache:
    def __init__(self):
        self.materials = {}

    def get(self, name, color, roughness=0.55, metallic=0.15, alpha=1.0, emission=None):
        key = (name, color, roughness, metallic, alpha, emission)
        if key in self.materials:
            return self.materials[key]
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = hex_rgba(color, alpha)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = hex_rgba(color, alpha)
            bsdf.inputs["Roughness"].default_value = roughness
            bsdf.inputs["Metallic"].default_value = metallic
            bsdf.inputs["Alpha"].default_value = alpha
            if emission and "Emission Color" in bsdf.inputs:
                bsdf.inputs["Emission Color"].default_value = hex_rgba(emission, 1)
                bsdf.inputs["Emission Strength"].default_value = 0.7
        if alpha < 1:
            mat.blend_method = "BLEND"
            mat.use_screen_refraction = True
            try:
                mat.surface_render_method = "BLENDED"
            except Exception:
                pass
        self.materials[key] = mat
        return mat


def hex_rgba(value, alpha=1.0):
    text = value.lstrip("#")
    if len(text) != 6:
        return (0.8, 0.8, 0.8, alpha)
    return (
        int(text[0:2], 16) / 255,
        int(text[2:4], 16) / 255,
        int(text[4:6], 16) / 255,
        alpha,
    )


def parent_to(obj, parent):
    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)


def object_descendants(parent):
    descendants = []
    for child in parent.children:
        descendants.append(child)
        descendants.extend(object_descendants(child))
    return descendants


def object_world_bbox(objects):
    points = []
    for obj in objects:
        if obj.type != "MESH" or not obj.bound_box:
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        return None
    min_corner = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    max_corner = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return min_corner, max_corner


def empty(name, parent=None, matrix=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    if parent:
        parent_to(obj, parent)
    if matrix:
        obj.matrix_local = matrix
    return obj


def cube(name, parent, loc, dims, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    parent_to(obj, parent)
    obj.location = loc
    obj.rotation_euler = rot
    obj.scale = (max(dims[0], 0.001), max(dims[1], 0.001), max(dims[2], 0.001))
    obj.data.materials.append(mat)
    return obj


def cylinder(name, parent, loc, radius, depth, mat, vertices=32, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth)
    obj = bpy.context.object
    obj.name = name
    parent_to(obj, parent)
    obj.location = loc
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    return obj


def cone(name, parent, loc, radius1, radius2, depth, mat, vertices=32, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1, radius2=radius2, depth=depth)
    obj = bpy.context.object
    obj.name = name
    parent_to(obj, parent)
    obj.location = loc
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    return obj


def bar_between(name, parent, start, end, radius, mat, vertices=12):
    a = Vector(start)
    b = Vector(end)
    mid = (a + b) * 0.5
    direction = b - a
    length = max(direction.length, 0.001)
    obj = cylinder(name, parent, mid, radius, length, mat, vertices=vertices)
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return obj


def limited_rotation_between(current, target, max_angle):
    if current.length_squared < 1e-8 or target.length_squared < 1e-8:
        return None
    current = current.normalized()
    target = target.normalized()
    angle = current.angle(target, 0)
    if angle < 0.002:
        return None
    delta = current.rotation_difference(target)
    if angle <= max_angle:
        return delta
    identity = Quaternion()
    identity.identity()
    return identity.slerp(delta, max_angle / angle)


def sphere(name, parent, loc, radius, mat, segments=32):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=16, radius=radius)
    obj = bpy.context.object
    obj.name = name
    parent_to(obj, parent)
    obj.location = loc
    obj.data.materials.append(mat)
    return obj


def add_bevel(obj, amount=0.04):
    modifier = obj.modifiers.new("soft bevel", "BEVEL")
    modifier.width = amount
    modifier.segments = 2
    obj.modifiers.new("weighted normals", "WEIGHTED_NORMAL")


class AircraftRig:
    def __init__(self, ship, airframe, materials):
        self.ship_id = ship["id"]
        self.root = empty(f"aircraft:{self.ship_id}")
        self.surfaces = {}
        self.controls = {}
        self.hand_targets = {}
        self.sweep_groups = []
        self.afterburners = []
        self.exterior_objects = []
        self.hero_hidden_objects = []
        self.is_static = ship.get("static", False)
        if self.is_static:
            self.build_static_target(ship, materials)
            self.exterior_objects = object_descendants(self.root)
        else:
            self.build_airframe(ship, airframe, materials)
            self.exterior_objects = object_descendants(self.root)
            self.build_cockpit_controls(materials)

    def build_static_target(self, ship, materials):
        mat = materials.get(f"{self.ship_id}:balloon", ship.get("color", "#ff5da3"), roughness=0.38, metallic=0.02)
        sphere(f"{self.ship_id}:balloon", self.root, (0, 0, 0), 38, mat)
        tether = materials.get("tether", "#d8e6ec", roughness=0.8, metallic=0.02)
        cylinder(f"{self.ship_id}:tether", self.root, (0, 0, -40), 0.5, 80, tether, vertices=8)

    def build_airframe(self, ship, airframe, materials):
        color = ship.get("color", "#4da3ff")
        body_mat = materials.get(f"{self.ship_id}:body", color, roughness=0.48, metallic=0.18)
        panel_mat = materials.get("panel", "#d8e6ec", roughness=0.44, metallic=0.18)
        canopy_mat = materials.get("canopy", "#8ad8ff", roughness=0.08, metallic=0.08, alpha=0.42)
        gear_mat = materials.get("gear", "#d8dee2", roughness=0.52, metallic=0.35)
        dark_mat = materials.get("dark hardware", "#172229", roughness=0.6, metallic=0.2)
        control_mat = materials.get("control surface", "#f4a340", roughness=0.42, metallic=0.18, emission="#f4a340")
        burner_mat = materials.get("afterburner plume", "#66d7ff", roughness=0.18, metallic=0.0, alpha=0.72, emission="#66d7ff")
        burner_core = materials.get("afterburner core", "#f2c94c", roughness=0.2, metallic=0.0, alpha=0.68, emission="#f2c94c")
        tank_mat = materials.get("tank", "#c9a14a", roughness=0.6, metallic=0.3)

        for part in airframe.get("parts", []):
            if part["kind"] == "sensor":
                continue
            group = empty(
                f"{self.ship_id}:part:{part['id']}",
                self.root,
                pose_matrix(part["pose"]["offset"], part["pose"]["rotation"]),
            )
            kind = part["kind"]
            if kind == "fuselage":
                dims = part["dims"]
                obj = cube(part["id"], group, (0, 0, 0), (dims["width"], dims["length"], dims["height"]), body_mat)
                add_bevel(obj, min(dims["width"], dims["height"]) * 0.08)
                nose = cube(f"{part['id']}:nose", group, (0, -dims["length"] * 0.48, 0), (dims["width"] * 0.62, dims["length"] * 0.16, dims["height"] * 0.66), panel_mat)
                spine = cube(f"{part['id']}:spine", group, (0, -dims["length"] * 0.15, dims["height"] * 0.54), (dims["width"] * 0.34, dims["length"] * 0.44, dims["height"] * 0.08), panel_mat)
                self.hero_hidden_objects.extend([obj, nose, spine])
            elif kind == "wing":
                span = part["planform"]["span"]
                chord = part["planform"]["chord"]
                axis = part.get("control", {}).get("axis")
                vertical = axis == "yaw"
                if part.get("sweep") and not vertical:
                    glove = cube(f"{part['id']}:glove", group, (0, -chord * 0.06, 0), (span * 0.2, chord * 1.18, 0.13), body_mat)
                    add_bevel(glove, 0.018)
                    for side in (-1, 1):
                        sweep = empty(f"{part['id']}:{'left' if side < 0 else 'right'}:sweep", group)
                        self.sweep_groups.append({"object": sweep, "side": side, "min": part["sweep"]["minSweepDeg"]})
                        panel = cube(
                            f"{part['id']}:{'left' if side < 0 else 'right'}",
                            sweep,
                            (side * span * 0.25, 0, 0),
                            (span * 0.5, chord, 0.1),
                            body_mat,
                        )
                        add_bevel(panel, 0.014)
                    self.add_swept_control_surfaces(group, part, span, chord, control_mat)
                else:
                    dims = (0.09, chord, span) if vertical else (span, chord, 0.1)
                    wing = cube(part["id"], group, (0, 0, 0), dims, body_mat)
                    add_bevel(wing, 0.015)
                    self.add_control_surfaces(group, part, span, chord, vertical, control_mat)
            elif kind == "engine":
                radius = part["dims"]["radius"]
                length = part["dims"]["length"]
                cylinder(part["id"], group, (0, 0, 0), radius, length, panel_mat, vertices=32, rot=(math.pi / 2, 0, 0))
                cylinder(f"{part['id']}:intake", group, (0, -length * 0.52, 0), radius * 1.05, length * 0.08, dark_mat, vertices=32, rot=(math.pi / 2, 0, 0))
                if part.get("afterburnerThrustN"):
                    flame = cone(
                        f"{part['id']}:afterburner-plume",
                        group,
                        (0, length * 0.64, 0),
                        radius * 0.68,
                        radius * 0.12,
                        length * 0.58,
                        burner_mat,
                        vertices=32,
                        rot=(math.pi / 2, 0, 0),
                    )
                    core = cone(
                        f"{part['id']}:afterburner-core",
                        group,
                        (0, length * 0.56, 0),
                        radius * 0.3,
                        radius * 0.04,
                        length * 0.36,
                        burner_core,
                        vertices=24,
                        rot=(math.pi / 2, 0, 0),
                    )
                    self.afterburners.append({"flame": flame, "core": core})
            elif kind == "prop":
                radius = part["radius"]
                cylinder(part["id"], group, (0, 0, 0), radius * 0.12, radius * 0.12, panel_mat, vertices=24, rot=(math.pi / 2, 0, 0))
                for i in range(int(part["bladeCount"])):
                    angle = (i / max(1, int(part["bladeCount"]))) * math.tau
                    blade = cube(f"{part['id']}:blade:{i}", group, (math.cos(angle) * radius * 0.42, 0, math.sin(angle) * radius * 0.42), (radius * 0.82, 0.035, max(radius * 0.08, 0.04)), dark_mat, rot=(0, 0, angle))
                    add_bevel(blade, 0.01)
            elif kind == "canopy":
                dims = part["dims"]
                obj = cube(part["id"], group, (0, 0, dims["height"] * 0.12), (dims["width"] * 1.35, dims["length"] * 1.2, dims["height"] * 1.55), canopy_mat)
                add_bevel(obj, 0.04)
                cube(f"{part['id']}:frame", group, (0, 0, dims["height"] * 0.35), (dims["width"] * 1.45, 0.08, 0.07), panel_mat)
                self.hero_hidden_objects.append(obj)
            elif kind == "gear":
                track = part["trackM"]
                height = part["heightM"]
                wheel = part["wheelRadiusM"]
                for side in (-0.5, 0.5):
                    cube(f"{part['id']}:strut:{side}", group, (side * track, 0, -height * 0.45), (0.035, 0.035, height), gear_mat)
                    cylinder(f"{part['id']}:wheel:{side}", group, (side * track, 0, -height), wheel, wheel * 0.42, dark_mat, vertices=24, rot=(0, math.pi / 2, 0))
            elif kind == "weapon":
                dims = part["dims"]
                spacing = max(dims["width"] * 2.2, 0.25)
                start = -((part["count"] - 1) * spacing) / 2
                for i in range(int(part["count"])):
                    cube(f"{part['id']}:{i}", group, (start + i * spacing, 0, 0), (dims["width"], dims["length"], dims["height"]), dark_mat)
            elif kind == "tank":
                radius = part["dims"]["radius"]
                length = part["dims"]["length"]
                cylinder(part["id"], group, (0, 0, 0), radius, length, tank_mat, vertices=24, rot=(math.pi / 2, 0, 0))

    def add_control_surfaces(self, group, part, span, chord, vertical, material):
        control = part.get("control")
        if not control:
            return
        axis = control["axis"]
        panel_chord = max(chord * 0.32, 0.12)
        hinge_y = chord / 2 - panel_chord
        panel_span = span * (0.34 if axis == "roll" else 0.74)
        specs = []
        if axis == "roll":
            specs = [(f"{part['id']}-left", -1), (f"{part['id']}-right", 1)]
        else:
            specs = [(part["id"], 0)]
        for surface_id, side in specs:
            center_x = side * span * 0.31 if axis == "roll" else 0
            loc = (center_x, hinge_y, 0.08 if not vertical else 0)
            hinge = empty(f"{surface_id}:hinge", group)
            hinge.location = loc
            if vertical:
                cube(surface_id, hinge, (0, panel_chord / 2, 0), (0.11, panel_chord, panel_span), material)
            else:
                cube(surface_id, hinge, (0, panel_chord / 2, 0), (panel_span, panel_chord, 0.08), material)
            self.surfaces[surface_id] = {"object": hinge, "vertical": vertical}

    def add_swept_control_surfaces(self, group, part, span, chord, material):
        control = part.get("control")
        if not control:
            return
        axis = control["axis"]
        if axis != "roll":
            self.add_control_surfaces(group, part, span, chord, False, material)
            return
        panel_chord = max(chord * 0.32, 0.12)
        hinge_y = chord / 2 - panel_chord
        panel_span = span * 0.17
        for side, label in ((-1, "left"), (1, "right")):
            sweep = next((entry["object"] for entry in self.sweep_groups if entry["object"].name == f"{part['id']}:{label}:sweep"), None)
            if not sweep:
                continue
            surface_id = f"{part['id']}-{label}"
            hinge = empty(f"{surface_id}:hinge", sweep)
            hinge.location = (side * span * 0.31, hinge_y, 0.08)
            cube(surface_id, hinge, (0, panel_chord / 2, 0), (panel_span, panel_chord, 0.08), material)
            self.surfaces[surface_id] = {"object": hinge, "vertical": False}

    def build_cockpit_controls(self, materials):
        dark = materials.get("cockpit dark", "#11191f", roughness=0.58, metallic=0.18)
        cushion = materials.get("cockpit cushion", "#27302c", roughness=0.9, metallic=0.05)
        panel = materials.get("cockpit panel", "#24333b", roughness=0.5, metallic=0.2)
        metal = materials.get("cockpit metal", "#d7e5ea", roughness=0.42, metallic=0.25)
        frame = materials.get("canopy frame dark", "#31424a", roughness=0.44, metallic=0.32)
        glass = materials.get("hud glass", "#8ad8ff", roughness=0.06, metallic=0.04, alpha=0.18, emission="#8ad8ff")
        cyan = materials.get("instrument cyan", "#00ffff", roughness=0.3, metallic=0.0, emission="#00ffff")
        amber = materials.get("instrument amber", "#f2c94c", roughness=0.3, metallic=0.0, emission="#f2c94c")
        throttle = materials.get("throttle green", "#58d38c", roughness=0.38, metallic=0.12, emission="#58d38c")
        active = materials.get("trigger active", "#f2c94c", roughness=0.36, metallic=0.18, emission="#f2c94c")
        control = materials.get("control orange", "#f4a340", roughness=0.42, metallic=0.18, emission="#f4a340")

        cockpit = empty(f"{self.ship_id}:cockpit-controls", self.root)
        seat_y = -4.2
        seat_z = -0.34

        def puppet_loc(x, up, forward):
            # Ported from puppet/src/cockpit-rig.js: x is lateral, y is up, z is forward.
            return (x, seat_y - (forward + 0.16), seat_z + (up - 0.73))

        def puppet_dims(width, height, depth):
            return (width, depth, height)

        def puppet_child_loc(x, up, forward):
            return (x, -forward, up)

        seat_pan = cube("seat-pan", cockpit, puppet_loc(0, 0.48, -0.14), puppet_dims(0.62, 0.12, 0.62), cushion)
        add_bevel(seat_pan, 0.035)
        seat_back = cube("seat-back", cockpit, puppet_loc(0, 0.94, -0.38), puppet_dims(0.64, 0.9, 0.12), cushion, rot=(math.radians(-8), 0, 0))
        add_bevel(seat_back, 0.035)
        headrest = cube("seat-headrest", cockpit, puppet_loc(0, 1.42, -0.46), puppet_dims(0.46, 0.18, 0.13), cushion, rot=(math.radians(-8), 0, 0))
        add_bevel(headrest, 0.025)
        for side in (-1, 1):
            bolster = cube(f"seat-bolster:{side}", cockpit, puppet_loc(side * 0.36, 0.78, -0.26), puppet_dims(0.08, 0.55, 0.12), cushion, rot=(math.radians(-8), 0, 0))
            add_bevel(bolster, 0.025)
            console = cube(f"{'left' if side < 0 else 'right'}-console", cockpit, puppet_loc(side * 0.42, 0.67, -0.1), puppet_dims(0.12, 0.32, 0.74), panel)
            add_bevel(console, 0.015)
            self.hero_hidden_objects.append(console)
        hero_panel_objects = []

        lower_rail = cube("lower-instrument-rail", cockpit, puppet_loc(0, 0.42, -0.48), puppet_dims(0.86, 0.08, 0.16), frame)
        add_bevel(lower_rail, 0.015)

        coaming = cube("forward-coaming", cockpit, puppet_loc(0, 0.92, 0.2), puppet_dims(0.96, 0.13, 0.18), dark)
        add_bevel(coaming, 0.02)
        panel_face = cube("instrument-panel", cockpit, puppet_loc(0, 0.78, 0.16), puppet_dims(0.84, 0.3, 0.04), panel, rot=(math.radians(-8), 0, 0))
        add_bevel(panel_face, 0.012)
        hero_panel_objects.extend([coaming, panel_face])
        hero_panel_objects.append(cube("left-mfd", cockpit, puppet_loc(-0.22, 0.81, 0.13), puppet_dims(0.24, 0.13, 0.018), cyan, rot=(math.radians(-8), 0, 0)))
        hero_panel_objects.append(cube("right-mfd", cockpit, puppet_loc(0.22, 0.81, 0.13), puppet_dims(0.24, 0.13, 0.018), amber, rot=(math.radians(-8), 0, 0)))
        hero_panel_objects.append(cube("center-status", cockpit, puppet_loc(0, 0.62, 0.15), puppet_dims(0.22, 0.07, 0.018), cyan, rot=(math.radians(-8), 0, 0)))
        hud = cube("hud-glass", cockpit, puppet_loc(0, 1.15, 0.34), puppet_dims(0.44, 0.18, 0.018), glass, rot=(math.radians(-10), 0, 0))
        add_bevel(hud, 0.006)
        hero_panel_objects.append(hud)
        for i, x in enumerate([-0.34, -0.2, -0.07, 0.07, 0.2, 0.34]):
            hero_panel_objects.append(sphere(f"panel-light:{i}", cockpit, puppet_loc(x, 0.68 + (i % 2) * 0.08, 0.11), 0.022, cyan if i % 2 else amber, segments=12))
        self.hero_hidden_objects.extend(hero_panel_objects)

        bar_between("front-canopy-rail", cockpit, puppet_loc(-0.52, 0.42, 0.34), puppet_loc(0.52, 0.42, 0.34), 0.018, frame)
        bar_between("left-canopy-rail", cockpit, puppet_loc(-0.5, 0.56, -0.52), puppet_loc(-0.2, 1.7, -0.64), 0.014, frame)
        bar_between("right-canopy-rail", cockpit, puppet_loc(0.5, 0.56, -0.52), puppet_loc(0.2, 1.7, -0.64), 0.014, frame)
        bar_between("top-canopy-bow", cockpit, puppet_loc(-0.2, 1.7, -0.64), puppet_loc(0.2, 1.7, -0.64), 0.014, frame)
        bar_between("left-fuselage-sill", cockpit, puppet_loc(-0.66, 0.58, 0.5), puppet_loc(-0.52, 0.66, -0.78), 0.024, frame)
        bar_between("right-fuselage-sill", cockpit, puppet_loc(0.66, 0.58, 0.5), puppet_loc(0.52, 0.66, -0.78), 0.024, frame)
        bar_between("left-cockpit-tub", cockpit, puppet_loc(-0.62, 0.28, 0.34), puppet_loc(-0.44, 0.34, -0.74), 0.02, frame)
        bar_between("right-cockpit-tub", cockpit, puppet_loc(0.62, 0.28, 0.34), puppet_loc(0.44, 0.34, -0.74), 0.02, frame)
        bar_between("nose-hoop-bottom", cockpit, puppet_loc(-0.52, 0.43, 0.42), puppet_loc(0.52, 0.43, 0.42), 0.02, frame)
        bar_between("nose-hoop-top", cockpit, puppet_loc(-0.36, 0.98, 0.38), puppet_loc(0.36, 0.98, 0.38), 0.018, frame)
        bar_between("nose-hoop-left", cockpit, puppet_loc(-0.52, 0.43, 0.42), puppet_loc(-0.36, 0.98, 0.38), 0.018, frame)
        bar_between("nose-hoop-right", cockpit, puppet_loc(0.52, 0.43, 0.42), puppet_loc(0.36, 0.98, 0.38), 0.018, frame)

        stick = empty("stick", cockpit)
        stick.location = puppet_loc(0, 0.58, 0.24)
        bar_between("stick:post", stick, puppet_child_loc(0, 0, 0), puppet_child_loc(0, 0.3, -0.1), 0.018, metal, vertices=12)
        grip = cube("stick:grip", stick, puppet_child_loc(0, 0.34, -0.12), (0.08, 0.08, 0.16), dark, rot=(math.radians(-14), 0, 0))
        add_bevel(grip, 0.018)
        bar_between("stick:crossbar", stick, puppet_child_loc(-0.12, 0.38, -0.13), puppet_child_loc(0.12, 0.38, -0.13), 0.018, active)
        sphere("stick:trigger", stick, puppet_child_loc(0, 0.44, -0.16), 0.035, active, segments=12)
        left_grip = empty("stick:left-grip-target", stick)
        left_grip.location = puppet_child_loc(0.09, 0.38, -0.13)
        right_grip = empty("stick:right-grip-target", stick)
        right_grip.location = puppet_child_loc(-0.09, 0.38, -0.13)
        sphere("stick:left-grip-knob", stick, left_grip.location, 0.045, active, segments=12)
        sphere("stick:right-grip-knob", stick, right_grip.location, 0.045, active, segments=12)
        self.hand_targets = {"left": left_grip, "right": right_grip}
        self.controls["stick"] = stick
        self.controls["grip"] = grip

        lever = empty("throttle", cockpit)
        lever.location = puppet_loc(-0.37, 0.63, 0.18)
        base = cube("throttle:base", cockpit, puppet_loc(-0.38, 0.58, 0.18), puppet_dims(0.18, 0.06, 0.22), dark)
        add_bevel(base, 0.012)
        post = bar_between("throttle:post", lever, (0, 0, 0), (-0.02, 0.1, 0.17), 0.014, metal, vertices=10)
        knob = cube("throttle:knob", lever, (-0.03, 0.125, 0.22), (0.075, 0.095, 0.055), throttle, rot=(math.radians(-18), 0, 0))
        add_bevel(knob, 0.018)
        self.hero_hidden_objects.extend([base, post, knob])
        self.controls["throttle"] = lever

        self.pedal_base_y = puppet_loc(0, 0.33, 0.39)[1]
        for name, x in (("left_pedal", -0.32), ("right_pedal", 0.32)):
            pedal = empty(name, cockpit)
            pedal.location = puppet_loc(x * 0.47, 0.33, 0.39)
            cube(f"{name}:plate", pedal, (0, 0, 0), (0.16, 0.06, 0.08), control)
            cube(f"{name}:toe", pedal, (0, -0.04, 0.06), (0.13, 0.05, 0.05), metal)
            self.controls[name] = pedal

    def update(self, ship):
        self.root.matrix_world = pose_matrix(ship["position"], ship["orientation"])
        sweep_deg = ship.get("sweepDeg")
        for spec in self.sweep_groups:
            angle = math.radians(float(sweep_deg if sweep_deg is not None else spec.get("min", 0)))
            spec["object"].rotation_euler = (0, 0, spec["side"] * angle)

        surfaces = {surface["id"]: surface for surface in ship.get("surfaceControls", [])}
        for surface_id, spec in self.surfaces.items():
            angle = math.radians(surfaces.get(surface_id, {}).get("deflectionDeg", 0))
            obj = spec["object"]
            if spec["vertical"]:
                obj.rotation_euler = (0, 0, angle)
            else:
                obj.rotation_euler = (angle, 0, 0)

        controls = ship.get("controls", {})
        pitch = max(-1, min(1, controls.get("pitch", 0))) * 0.42
        roll = max(-1, min(1, -controls.get("roll", 0))) * 0.36
        yaw = max(-1, min(1, controls.get("yaw", 0)))
        throttle = max(0, min(1, controls.get("throttle", 0)))
        spool = max(0, min(1.2, float(ship.get("engineSpool", throttle))))
        burner_hot = bool(ship.get("afterburner")) or throttle > 0.97
        for entry in self.afterburners:
            pulse = 1 + 0.08 * math.sin(float(ship.get("airspeed", 0)) * 0.11)
            for obj, base in ((entry["flame"], 1.0), (entry["core"], 0.72)):
                obj.hide_render = not burner_hot
                obj.hide_viewport = not burner_hot
                obj.scale = (base * (0.7 + spool * 0.5) * pulse, base * (0.7 + spool * 0.5) * pulse, 0.75 + spool * 0.55)
        if "stick" in self.controls:
            self.controls["stick"].rotation_euler = (pitch, 0, roll)
        if "throttle" in self.controls:
            self.controls["throttle"].rotation_euler = (-0.55 + throttle * 1.05, 0, 0)
        pedal_base_y = getattr(self, "pedal_base_y", -4.75)
        if "left_pedal" in self.controls:
            self.controls["left_pedal"].location.y = pedal_base_y + yaw * 0.14
            self.controls["left_pedal"].rotation_euler = (-0.24 + yaw * 0.24, 0, 0)
        if "right_pedal" in self.controls:
            self.controls["right_pedal"].location.y = pedal_base_y - yaw * 0.14
            self.controls["right_pedal"].rotation_euler = (-0.24 - yaw * 0.24, 0, 0)

    def set_exterior_visible(self, visible):
        for obj in self.exterior_objects:
            obj.hide_render = not visible
            obj.hide_viewport = not visible
        if visible:
            for obj in self.hero_hidden_objects:
                obj.hide_render = False
                obj.hide_viewport = False

    def set_pilot_hero_visible(self):
        self.set_exterior_visible(True)
        for obj in self.hero_hidden_objects:
            obj.hide_render = True
            obj.hide_viewport = True


class AvatarRig:
    def __init__(self, avatar, pilot_rig):
        self.avatar = avatar
        self.pilot_rig = pilot_rig
        self.root = empty("vtuber:root", pilot_rig.root)
        self.imported = []
        self.top_level = []
        self.armature = None
        self.base_location = Vector((0, 0, 0))
        self.base_yaw = 0.0
        self.seat_target = Vector((0, 0, 0))
        self.scale_value = 1.0
        self.hip_local = Vector((0, 0, 0))
        self.contact_debug = {}
        self.import_avatar(Path(avatar["source"]))
        self.apply_mount()
        self.apply_neutral_pose()
        self.solve_contact_ik()

    def import_avatar(self, source):
        if not source.exists():
            raise FileNotFoundError(f"avatar asset not found: {source}")
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(source))
        self.imported = [obj for obj in bpy.data.objects if obj not in before]
        self.top_level = [obj for obj in self.imported if obj.parent is None or obj.parent not in self.imported]
        for obj in self.top_level:
            parent_to(obj, self.root)

        for obj in self.imported:
            if obj.type == "ARMATURE":
                self.armature = obj
            if obj.type == "MESH":
                obj.visible_shadow = True
                for mat in obj.data.materials:
                    if mat:
                        mat.diffuse_color = tuple(min(1.0, c * 1.08) if i < 3 else c for i, c in enumerate(mat.diffuse_color))
        self.fit_imported_avatar()
        self.hip_local = self.local_bone_position("J_Bip_C_Hips")

    def fit_imported_avatar(self):
        bpy.context.view_layer.update()
        bounds = object_world_bbox(self.imported)
        if not bounds:
            return
        min_corner, max_corner = bounds
        center = (min_corner + max_corner) * 0.5
        offset = Vector((-center.x, -center.y, -min_corner.z))
        for obj in self.top_level:
            obj.location += offset
        bpy.context.view_layer.update()

    def local_bone_position(self, name):
        if not self.armature:
            return Vector((0, 0, 0))
        bone = self.armature.pose.bones.get(name)
        if not bone:
            return Vector((0, 0, 0))
        bpy.context.view_layer.update()
        world = self.armature.matrix_world @ bone.matrix.translation
        return self.root.matrix_world.inverted() @ world

    def apply_mount(self):
        self.seat_target = sim_vec(self.avatar.get("rootLocal", {"x": 0, "y": -0.34, "z": -4.2}))
        self.base_yaw = math.radians(float(self.avatar.get("yawDeg", 180)))
        self.scale_value = float(self.avatar.get("scale", 0.78))
        self.base_location = self.root_location_for_rotation((0, 0, self.base_yaw), 0)
        self.root.location = self.base_location
        self.root.rotation_euler = (0, 0, self.base_yaw)
        self.root.scale = (self.scale_value, self.scale_value, self.scale_value)

    def root_location_for_rotation(self, rotation, seat_sink):
        rotation_matrix = Euler(rotation, "XYZ").to_matrix()
        target = self.seat_target + Vector((0, 0, -seat_sink))
        return target - (rotation_matrix @ (self.hip_local * self.scale_value))

    def set_pose_bone(self, name, xyz_deg):
        if not self.armature:
            return
        bone = self.armature.pose.bones.get(name)
        if not bone:
            return
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = tuple(math.radians(value) for value in xyz_deg)

    def apply_neutral_pose(self):
        # The sample VRM imports in a T-pose. This mirrors the lightweight seated pose from
        # puppet/src/puppet-app.js, then keeps the arms in a simple cockpit-ready rest pose.
        self.set_pose_bone("J_Bip_C_Hips", (-12, 0, 0))
        self.set_pose_bone("J_Bip_L_UpperLeg", (-84, 6, -6))
        self.set_pose_bone("J_Bip_R_UpperLeg", (-84, -6, 6))
        self.set_pose_bone("J_Bip_L_LowerLeg", (96, 0, 0))
        self.set_pose_bone("J_Bip_R_LowerLeg", (96, 0, 0))
        self.set_pose_bone("J_Bip_L_Foot", (-18, 0, 0))
        self.set_pose_bone("J_Bip_R_Foot", (-18, 0, 0))
        self.set_pose_bone("J_Bip_L_Shoulder", (0, 0, -8))
        self.set_pose_bone("J_Bip_R_Shoulder", (0, 0, 8))
        self.set_pose_bone("J_Bip_L_UpperArm", (28, 10, 28))
        self.set_pose_bone("J_Bip_R_UpperArm", (34, -18, -26))
        self.set_pose_bone("J_Bip_L_LowerArm", (-54, 0, -20))
        self.set_pose_bone("J_Bip_R_LowerArm", (-58, 0, 18))
        self.set_pose_bone("J_Bip_L_Hand", (-10, 8, -10))
        self.set_pose_bone("J_Bip_R_Hand", (-10, -8, 10))
        self.set_pose_bone("J_Bip_C_Spine", (6, 0, 0))
        self.set_pose_bone("J_Bip_C_Chest", (8, 0, 0))
        self.set_pose_bone("J_Bip_C_UpperChest", (4, 0, 0))

    def apply_contact_ik(self):
        if not self.armature:
            return
        specs = (
            ("left", "J_Bip_L_Hand"),
            ("right", "J_Bip_R_Hand"),
        )
        for side, bone_name in specs:
            target = self.pilot_rig.hand_targets.get(side)
            bone = self.armature.pose.bones.get(bone_name)
            if not target or not bone:
                continue
            constraint = bone.constraints.new(type="IK")
            constraint.name = f"cockpit {side} grip"
            constraint.target = target
            constraint.chain_count = 3
            if hasattr(constraint, "use_rotation"):
                constraint.use_rotation = True
            if hasattr(constraint, "weight"):
                constraint.weight = 0.88

    def pose_bone_world_position(self, bone):
        return self.armature.matrix_world @ bone.matrix.translation

    def rotate_pose_bone_world(self, bone, joint_world, delta_world):
        pivot = Matrix.Translation(joint_world)
        rotate = delta_world.to_matrix().to_4x4()
        desired_world = pivot @ rotate @ Matrix.Translation(-joint_world) @ (self.armature.matrix_world @ bone.matrix)
        bone.matrix = self.armature.matrix_world.inverted() @ desired_world

    def solve_chain_to_target(self, chain_names, effector_name, target, iterations=12, max_angle=0.65, weight=1.0):
        if not self.armature or not target:
            return None
        chain = [self.armature.pose.bones.get(name) for name in chain_names]
        chain = [bone for bone in chain if bone]
        effector = self.armature.pose.bones.get(effector_name)
        if not chain or not effector:
            return None

        bpy.context.view_layer.update()
        target_world = target.matrix_world.translation.copy()
        start_world = self.pose_bone_world_position(effector)
        weighted_target = start_world.lerp(target_world, max(0, min(1, weight)))
        start_error = (start_world - target_world).length
        for _ in range(iterations):
            for bone in reversed(chain):
                bpy.context.view_layer.update()
                joint_world = self.pose_bone_world_position(bone)
                effector_world = self.pose_bone_world_position(effector)
                current = effector_world - joint_world
                desired = weighted_target - joint_world
                delta = limited_rotation_between(current, desired, max_angle)
                if not delta:
                    continue
                self.rotate_pose_bone_world(bone, joint_world, delta)
        bpy.context.view_layer.update()
        end_world = self.pose_bone_world_position(effector)
        return {
            "start": start_error,
            "end": (end_world - target_world).length,
            "target": target_world,
            "effector": end_world,
        }

    def solve_contact_ik(self):
        if not self.armature:
            return
        self.contact_debug = {}
        specs = (
            ("left", ["J_Bip_L_Shoulder", "J_Bip_L_UpperArm", "J_Bip_L_LowerArm"], "J_Bip_L_Hand"),
            ("right", ["J_Bip_R_Shoulder", "J_Bip_R_UpperArm", "J_Bip_R_LowerArm"], "J_Bip_R_Hand"),
        )
        for side, chain, hand in specs:
            result = self.solve_chain_to_target(chain, hand, self.pilot_rig.hand_targets.get(side), iterations=28, max_angle=0.9)
            if result:
                self.contact_debug[side] = result

    # VRM humanoid bone → Blender bone name (the sample VRM uses the J_Bip_ convention).
    _VRM_TO_BLENDER = {
        "hips": "J_Bip_C_Hips",
        "spine": "J_Bip_C_Spine",
        "chest": "J_Bip_C_Chest",
        "upperChest": "J_Bip_C_UpperChest",
        "neck": "J_Bip_C_Neck",
        "head": "J_Bip_C_Head",
        "leftUpperLeg": "J_Bip_L_UpperLeg",
        "rightUpperLeg": "J_Bip_R_UpperLeg",
        "leftLowerLeg": "J_Bip_L_LowerLeg",
        "rightLowerLeg": "J_Bip_R_LowerLeg",
        "leftFoot": "J_Bip_L_Foot",
        "rightFoot": "J_Bip_R_Foot",
        "leftShoulder": "J_Bip_L_Shoulder",
        "rightShoulder": "J_Bip_R_Shoulder",
        "leftUpperArm": "J_Bip_L_UpperArm",
        "rightUpperArm": "J_Bip_R_UpperArm",
        "leftLowerArm": "J_Bip_L_LowerArm",
        "rightLowerArm": "J_Bip_R_LowerArm",
        "leftHand": "J_Bip_L_Hand",
        "rightHand": "J_Bip_R_Hand",
    }

    def update(self, frame):
        pose = frame.get("pilotPose") or {}
        if not pose:
            return
        # Apply the full per-bone pose — same data the React viewer uses.
        # The pilotPose.bones rotations are accumulated in buildPilotPose (neutral + seated + idle + gForce).
        # We apply them as offsets from the T-pose rest (no separate neutral pose).
        bones = pose.get("bones") or {}
        for vrm_name, rot in bones.items():
            blender_name = self._VRM_TO_BLENDER.get(vrm_name)
            if blender_name and self.armature:
                bone = self.armature.pose.bones.get(blender_name)
                if bone:
                    bone.rotation_mode = "XYZ"
                    # pilotPose.bones are in radians
                    bone.rotation_euler = (
                        float(rot.get("x", 0)),
                        float(rot.get("y", 0)),
                        float(rot.get("z", 0)),
                    )
        self.solve_contact_ik()


def build_world(materials):
    world = empty("world")
    terrain = materials.get("terrain", "#566d55", roughness=0.95, metallic=0.02)
    grid = materials.get("runway grid", "#78947f", roughness=0.8, metallic=0.0)
    cloud = materials.get("cloud haze", "#e5edf0", roughness=0.92, metallic=0.0, alpha=0.34)
    sun_mat = materials.get("low sun disc", "#ffd39a", roughness=0.2, metallic=0.0, alpha=0.88, emission="#ffd39a")
    cube("ground", world, (0, 0, -1.2), (42000, 42000, 0.4), terrain)
    for i in range(-16, 17):
        cube(f"grid:x:{i}", world, (i * 900, 0, -0.95), (2.2, 42000, 0.05), grid)
        cube(f"grid:y:{i}", world, (0, i * 900, -0.94), (42000, 2.2, 0.05), grid)

    cloud_specs = [
        (-2500, -1400, 430, 520, 150, 28),
        (-1200, 2300, 520, 420, 120, 22),
        (900, -2100, 610, 620, 160, 26),
        (2300, 1200, 470, 500, 140, 24),
        (3200, -300, 720, 720, 180, 32),
    ]
    for index, (x, y, z, sx, sy, sz) in enumerate(cloud_specs):
        obj = sphere(f"cloud-bank:{index}", world, (x, y, z), 1, cloud, segments=24)
        obj.scale = (sx, sy, sz)

    sun = sphere("sun-disc", world, (-3800, -5200, 1550), 70, sun_mat, segments=32)
    sun.scale = (1.0, 0.2, 1.0)

    bpy.ops.object.light_add(type="SUN", location=(0, 0, 0))
    sun = bpy.context.object
    sun.name = "sun"
    sun.rotation_euler = (math.radians(51), 0, math.radians(34))
    sun.data.energy = 3.6
    bpy.ops.object.light_add(type="AREA", location=(0, -260, 720))
    area = bpy.context.object
    area.name = "sky fill"
    area.data.energy = 650
    area.data.size = 950


def look_at_matrix(eye, target, up):
    direction = target - eye
    if direction.length < 1e-6:
        direction = Vector((0, -1, 0))
    direction.normalize()
    if up.length < 1e-6:
        up = Vector((0, 0, 1))
    up.normalize()
    right = up.cross(direction)
    if right.length < 1e-6:
        right = Vector((1, 0, 0))
    right.normalize()
    corrected_up = direction.cross(right)
    corrected_up.normalize()
    back = -direction
    return Matrix(
        (
            (right.x, corrected_up.x, back.x, eye.x),
            (right.y, corrected_up.y, back.y, eye.y),
            (right.z, corrected_up.z, back.z, eye.z),
            (0, 0, 0, 1),
        )
    )


def configure_camera(timeline):
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    bpy.context.scene.camera = camera
    camera.data.clip_start = 0.05
    camera.data.clip_end = 12000
    return camera


def update_camera(camera, camera_frame):
    eye = sim_vec(camera_frame["eye"])
    target = sim_vec(camera_frame["target"])
    up = sim_vec(camera_frame["up"])
    camera.matrix_world = look_at_matrix(eye, target, up)
    camera.data.angle = math.radians(float(camera_frame["verticalFovDeg"]))
    focus = camera_frame.get("focusDistanceM")
    f_stop = camera_frame.get("fStop")
    if focus and f_stop:
        camera.data.dof.use_dof = True
        camera.data.dof.focus_distance = max(0.1, float(focus))
        camera.data.dof.aperture_fstop = max(0.7, float(f_stop))
    else:
        camera.data.dof.use_dof = False


class TracerPool:
    def __init__(self, materials, count=16):
        self.objects = []
        self.mats = {
            "shot": materials.get("tracer shot", "#d7e5ea", roughness=0.3, metallic=0.0, emission="#d7e5ea"),
            "hit": materials.get("tracer hit", "#f2c94c", roughness=0.25, metallic=0.0, emission="#f2c94c"),
            "miss": materials.get("tracer miss", "#d7e5ea", roughness=0.3, metallic=0.0, emission="#d7e5ea"),
            "terrain": materials.get("tracer terrain", "#ff6b61", roughness=0.3, metallic=0.0, emission="#ff6b61"),
        }
        for i in range(count):
            curve = bpy.data.curves.new(f"tracer:{i}", "CURVE")
            curve.dimensions = "3D"
            curve.resolution_u = 1
            curve.bevel_depth = 1.2
            curve.bevel_resolution = 2
            poly = curve.splines.new("POLY")
            poly.points.add(1)
            obj = bpy.data.objects.new(f"tracer:{i}", curve)
            bpy.context.collection.objects.link(obj)
            obj.hide_render = True
            obj.hide_viewport = True
            self.objects.append(obj)

    def update(self, events):
        for obj in self.objects:
            obj.hide_render = True
            obj.hide_viewport = True
        visible = [event for event in events if event.get("origin") and event.get("impact")]
        for obj, event in zip(self.objects, visible):
            start = sim_vec(event["origin"])
            end = sim_vec(event["impact"])
            obj.data.splines[0].points[0].co = (start.x, start.y, start.z, 1)
            obj.data.splines[0].points[1].co = (end.x, end.y, end.z, 1)
            obj.data.materials.clear()
            obj.data.materials.append(self.mats.get(event.get("type"), self.mats["shot"]))
            obj.hide_render = False
            obj.hide_viewport = False


class ProjectilePool:
    def __init__(self, materials, count=16):
        self.entries = []
        self.mats = {
            "blue": materials.get("projectile blue", "#d7e5ea", roughness=0.18, metallic=0.0, emission="#d7e5ea"),
            "red": materials.get("projectile red", "#ff6b61", roughness=0.18, metallic=0.0, emission="#ff6b61"),
            "missile": materials.get("missile body", "#e8eef2", roughness=0.32, metallic=0.32),
            "smoke": materials.get("missile smoke", "#bcc6c9", roughness=0.86, metallic=0.0, alpha=0.44),
        }
        for i in range(count):
            ball = sphere(f"projectile:{i}:glow", None, (0, 0, 0), 3.2, self.mats["blue"], segments=16)
            curve = bpy.data.curves.new(f"projectile:{i}:trail", "CURVE")
            curve.dimensions = "3D"
            curve.resolution_u = 1
            curve.bevel_depth = 1.35
            curve.bevel_resolution = 2
            poly = curve.splines.new("POLY")
            poly.points.add(1)
            trail = bpy.data.objects.new(f"projectile:{i}:trail", curve)
            bpy.context.collection.objects.link(trail)
            smoke_curve = bpy.data.curves.new(f"projectile:{i}:smoke", "CURVE")
            smoke_curve.dimensions = "3D"
            smoke_curve.resolution_u = 2
            smoke_curve.bevel_depth = 2.2
            smoke_curve.bevel_resolution = 3
            smoke_poly = smoke_curve.splines.new("POLY")
            smoke_poly.points.add(2)
            smoke = bpy.data.objects.new(f"projectile:{i}:smoke", smoke_curve)
            bpy.context.collection.objects.link(smoke)
            body = cylinder(f"projectile:{i}:missile-body", None, (0, 0, 0), 1.15, 24, self.mats["missile"], vertices=18)
            nose = cone(f"projectile:{i}:missile-nose", None, (0, 0, 0), 1.15, 0.0, 5.2, self.mats["missile"], vertices=18)
            self.entries.append({"glow": ball, "trail": trail, "smoke": smoke, "body": body, "nose": nose})
        self.hide_all()

    def hide_all(self):
        for entry in self.entries:
            for obj in entry.values():
                obj.hide_render = True
                obj.hide_viewport = True

    def update(self, projectiles):
        self.hide_all()
        for entry, projectile in zip(self.entries, projectiles):
            pos = sim_vec(projectile["position"])
            velocity = sim_vec(projectile["velocity"])
            if velocity.length < 1e-6:
                direction = Vector((0, -1, 0))
            else:
                direction = velocity.normalized()
            is_missile = projectile.get("kind") == "missile"
            trail_length = min(360.0 if is_missile else 120.0, max(35.0, velocity.length * (0.16 if is_missile else 0.055)))
            start = pos - direction * trail_length
            end = pos + direction * 10.0
            mat = self.mats.get(projectile.get("team"), self.mats["blue"])
            entry["glow"].location = pos
            entry["glow"].scale = (1.05, 1.05, 1.05) if is_missile else (1, 1, 1)
            entry["glow"].data.materials.clear()
            entry["glow"].data.materials.append(mat)
            entry["body"].location = pos
            entry["body"].rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
            entry["nose"].location = pos + direction * 14.0
            entry["nose"].rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
            entry["trail"].data.splines[0].points[0].co = (start.x, start.y, start.z, 1)
            entry["trail"].data.splines[0].points[1].co = (end.x, end.y, end.z, 1)
            entry["trail"].data.materials.clear()
            entry["trail"].data.materials.append(mat)
            smoke_start = pos - direction * (trail_length * 1.25)
            smoke_mid = pos - direction * (trail_length * 0.62) + Vector((0, 0, math.sin(pos.x * 0.01) * 12.0))
            smoke_end = pos - direction * 16.0
            entry["smoke"].data.splines[0].points[0].co = (smoke_start.x, smoke_start.y, smoke_start.z, 1)
            entry["smoke"].data.splines[0].points[1].co = (smoke_mid.x, smoke_mid.y, smoke_mid.z, 1)
            entry["smoke"].data.splines[0].points[2].co = (smoke_end.x, smoke_end.y, smoke_end.z, 1)
            entry["smoke"].data.materials.clear()
            entry["smoke"].data.materials.append(self.mats["smoke"])
            visible = ("glow", "trail", "body", "nose", "smoke") if is_missile else ("glow", "trail")
            for key in visible:
                obj = entry[key]
                obj.hide_render = False
                obj.hide_viewport = False


class SubtitleOverlay:
    def __init__(self, camera, materials, timeline):
        self.subtitles = timeline.get("subtitles", [])
        self.split = is_split_timeline(timeline)
        self.wrap_width = 26 if self.split else 34
        self.max_lines = 3
        self.backing = self.make_backing(
            "subtitle:backing",
            camera,
            materials.get("subtitle backing", "#020407", roughness=0.9, metallic=0.0, alpha=0.42),
            (0, -0.044 if self.split else -0.056, -0.235),
        )
        self.text = self.make_text(
            "subtitle:feel",
            camera,
            materials.get("subtitle white", "#f8fbff", roughness=0.2, metallic=0.0, emission="#f8fbff"),
            (0, -0.044 if self.split else -0.056, -0.22),
        )
        self.shadow = self.make_text(
            "subtitle:shadow",
            camera,
            materials.get("subtitle shadow", "#020407", roughness=0.9, metallic=0.0, emission="#020407"),
            (0.0012, -0.045 if self.split else -0.057, -0.221),
        )
        self.hide()

    def make_backing(self, name, camera, mat, loc):
        bpy.ops.mesh.primitive_plane_add(size=1)
        obj = bpy.context.object
        obj.name = name
        parent_to(obj, camera)
        obj.location = loc
        obj.scale = (0.17 if self.split else 0.235, 0.052 if self.split else 0.052, 1)
        obj.data.materials.append(mat)
        return obj

    def make_text(self, name, camera, mat, loc):
        curve = bpy.data.curves.new(name, "FONT")
        curve.align_x = "CENTER"
        curve.align_y = "CENTER"
        curve.size = 0.0051 if self.split else 0.0062
        curve.space_line = 0.9
        curve.resolution_u = 12
        obj = bpy.data.objects.new(name, curve)
        bpy.context.collection.objects.link(obj)
        parent_to(obj, camera)
        obj.location = loc
        obj.data.materials.append(mat)
        return obj

    def active_subtitle(self, time):
        for subtitle in self.subtitles:
            if float(subtitle.get("start", 0)) <= time < float(subtitle.get("end", 0)):
                return subtitle
        return None

    def hide(self):
        for obj in (self.text, self.shadow, self.backing):
            obj.hide_render = True
            obj.hide_viewport = True

    def update(self, time):
        subtitle = self.active_subtitle(time)
        if not subtitle:
            self.hide()
            return
        label = str(subtitle.get("label", "THOUGHT")).strip() or "THOUGHT"
        text = f"{label}: " + str(subtitle.get("text", "")).strip()
        body = "\n".join(textwrap.wrap(text, width=self.wrap_width, max_lines=self.max_lines, placeholder="..."))
        for obj in (self.text, self.shadow):
            obj.data.body = body
            obj.hide_render = False
            obj.hide_viewport = False
        self.backing.hide_render = False
        self.backing.hide_viewport = False


def build_aircraft_rigs(timeline, materials):
    first_by_id = {}
    for frame in timeline["frames"]:
        for ship in frame["aircraft"]:
            first_by_id.setdefault(ship["id"], ship)
    rigs = {}
    for ship_id, ship in first_by_id.items():
        airframe = timeline["airframes"].get(ship_id, {"id": ship_id, "parts": []})
        rigs[ship_id] = AircraftRig(ship, airframe, materials)
    return rigs


def apply_camera_visibility(rigs, pilot_id, camera_frame):
    camera_mode = camera_frame["mode"]
    shot = camera_frame.get("shot", "")
    cockpit_like = camera_mode == "cockpit" or shot == "cockpit-controls" or shot.startswith("director-cockpit")
    pilot_hero_like = camera_mode == "pilot-hero" or shot.startswith("director-pilot")
    for rig in rigs.values():
        if rig.ship_id == pilot_id and cockpit_like:
            rig.set_exterior_visible(False)
        elif rig.ship_id == pilot_id and pilot_hero_like:
            rig.set_pilot_hero_visible()
        else:
            rig.set_exterior_visible(True)


def apply_external_visibility(rigs):
    for rig in rigs.values():
        rig.set_exterior_visible(True)


def render_timeline(timeline, output_path, frames_dir, keep_frames, samples):
    clear_scene()
    configure_scene(timeline, samples)
    split = is_split_timeline(timeline)
    materials = MaterialCache()
    build_world(materials)
    rigs = build_aircraft_rigs(timeline, materials)
    avatar_rig = None
    avatar = timeline.get("avatar")
    if avatar:
        pilot_rig = rigs.get(avatar.get("pilotId"))
        if pilot_rig:
            avatar_rig = AvatarRig(avatar, pilot_rig)
    camera = configure_camera(timeline)
    tracers = TracerPool(materials)
    projectiles = ProjectilePool(materials)
    subtitles = (
        SubtitleOverlay(camera, materials, timeline)
        if os.environ.get("NATIVE_RENDER_BLENDER_SUBTITLES") and timeline.get("subtitles")
        else None
    )

    frames_path = Path(frames_dir)
    if frames_path.exists():
        shutil.rmtree(frames_path)
    frames_path.mkdir(parents=True, exist_ok=True)
    left_path = frames_path / "left"
    right_path = frames_path / "right"
    if split:
        left_path.mkdir(parents=True, exist_ok=True)
        right_path.mkdir(parents=True, exist_ok=True)

    for frame in timeline["frames"]:
        frame_index = int(frame["index"])
        bpy.context.scene.frame_set(int(frame["index"]))
        for ship in frame["aircraft"]:
            rig = rigs.get(ship["id"])
            if rig:
                rig.update(ship)
        if avatar_rig:
            avatar_rig.update(frame)
            debug_contact = os.environ.get("NATIVE_RENDER_DEBUG_CONTACT")
            debug_frame = int(os.environ.get("NATIVE_RENDER_DEBUG_CONTACT_FRAME", "0"))
            if debug_contact and int(frame["index"]) == debug_frame:
                for side, result in avatar_rig.contact_debug.items():
                    print(
                        f"contact {side}: start={result['start']:.3f}m end={result['end']:.3f}m "
                        f"target=({result['target'].x:.3f},{result['target'].y:.3f},{result['target'].z:.3f}) "
                        f"hand=({result['effector'].x:.3f},{result['effector'].y:.3f},{result['effector'].z:.3f})",
                        flush=True,
                    )
        tracers.update(frame.get("events", []))
        projectiles.update(frame.get("projectiles", []))

        if split:
            apply_camera_visibility(rigs, timeline.get("pilotId"), frame["camera"])
            update_camera(camera, frame["camera"])
            if subtitles:
                subtitles.update(float(frame.get("time", 0)))
            bpy.context.scene.render.filepath = str(left_path / f"frame_{frame_index:06d}.png")
            print(f"render left {frame['index'] + 1}/{len(timeline['frames'])}: {frame['camera']['shot']}", flush=True)
            bpy.ops.render.render(write_still=True)

            if subtitles:
                subtitles.hide()
            apply_external_visibility(rigs)
            external_camera = frame.get("externalCamera") or frame["camera"]
            update_camera(camera, external_camera)
            bpy.context.scene.render.filepath = str(right_path / f"frame_{frame_index:06d}.png")
            print(f"render right {frame['index'] + 1}/{len(timeline['frames'])}: {external_camera['shot']}", flush=True)
            bpy.ops.render.render(write_still=True)
        else:
            apply_camera_visibility(rigs, timeline.get("pilotId"), frame["camera"])
            update_camera(camera, frame["camera"])
            if subtitles:
                subtitles.update(float(frame.get("time", 0)))
            bpy.context.scene.render.filepath = str(frames_path / f"frame_{frame_index:06d}.png")
            print(f"render frame {frame['index'] + 1}/{len(timeline['frames'])}: {frame['camera']['shot']}", flush=True)
            bpy.ops.render.render(write_still=True)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    bundled_ffmpeg = Path("/usr/local/opt/ffmpeg-full/bin/ffmpeg")
    ffmpeg = os.environ.get("FFMPEG_BIN") or (str(bundled_ffmpeg) if bundled_ffmpeg.exists() else "ffmpeg")
    if split:
        subprocess.check_call(
            [
                ffmpeg,
                "-y",
                "-framerate",
                str(timeline["fps"]),
                "-start_number",
                "0",
                "-i",
                str(left_path / "frame_%06d.png"),
                "-framerate",
                str(timeline["fps"]),
                "-start_number",
                "0",
                "-i",
                str(right_path / "frame_%06d.png"),
                "-filter_complex",
                "[0:v][1:v]hstack=inputs=2,pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(output),
            ]
        )
    else:
        subprocess.check_call(
            [
                ffmpeg,
                "-y",
                "-framerate",
                str(timeline["fps"]),
                "-start_number",
                "0",
                "-i",
                str(frames_path / "frame_%06d.png"),
                "-vf",
                "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(output),
            ]
        )
    if not keep_frames:
        shutil.rmtree(frames_path)


def main():
    args = parse_args()
    with open(args.timeline, "r", encoding="utf8") as handle:
        timeline = json.load(handle)
    render_timeline(timeline, args.out, args.frames_dir, args.keep_frames, args.samples)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
