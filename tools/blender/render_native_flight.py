import argparse
import json
import math
import shutil
import subprocess
import sys
import traceback
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


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
    scene.frame_start = 0
    scene.frame_end = max(0, len(timeline["frames"]) - 1)
    scene.render.fps = int(timeline["fps"])
    scene.render.resolution_x = int(timeline["width"])
    scene.render.resolution_y = int(timeline["height"])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = max(1, int(samples))
    scene.world = bpy.data.worlds.new("Flight World")
    scene.world.color = (0.52, 0.68, 0.82)
    scene.view_settings.view_transform = "Filmic"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1


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


def bar_between(name, parent, start, end, radius, mat, vertices=12):
    a = Vector(start)
    b = Vector(end)
    mid = (a + b) * 0.5
    direction = b - a
    length = max(direction.length, 0.001)
    obj = cylinder(name, parent, mid, radius, length, mat, vertices=vertices)
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return obj


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
        self.exterior_objects = []
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
                cube(f"{part['id']}:nose", group, (0, -dims["length"] * 0.48, 0), (dims["width"] * 0.62, dims["length"] * 0.16, dims["height"] * 0.66), panel_mat)
                cube(f"{part['id']}:spine", group, (0, -dims["length"] * 0.15, dims["height"] * 0.54), (dims["width"] * 0.34, dims["length"] * 0.44, dims["height"] * 0.08), panel_mat)
            elif kind == "wing":
                span = part["planform"]["span"]
                chord = part["planform"]["chord"]
                axis = part.get("control", {}).get("axis")
                vertical = axis == "yaw"
                dims = (0.09, chord, span) if vertical else (span, chord, 0.1)
                wing = cube(part["id"], group, (0, 0, 0), dims, body_mat)
                add_bevel(wing, 0.015)
                self.add_control_surfaces(group, part, span, chord, vertical, control_mat)
            elif kind == "engine":
                radius = part["dims"]["radius"]
                length = part["dims"]["length"]
                cylinder(part["id"], group, (0, 0, 0), radius, length, panel_mat, vertices=32, rot=(math.pi / 2, 0, 0))
                cylinder(f"{part['id']}:intake", group, (0, -length * 0.52, 0), radius * 1.05, length * 0.08, dark_mat, vertices=32, rot=(math.pi / 2, 0, 0))
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

    def build_cockpit_controls(self, materials):
        dark = materials.get("cockpit dark", "#11191f", roughness=0.58, metallic=0.18)
        panel = materials.get("cockpit panel", "#24333b", roughness=0.5, metallic=0.2)
        metal = materials.get("cockpit metal", "#d7e5ea", roughness=0.42, metallic=0.25)
        frame = materials.get("canopy frame dark", "#31424a", roughness=0.44, metallic=0.32)
        glass = materials.get("hud glass", "#8ad8ff", roughness=0.06, metallic=0.04, alpha=0.24, emission="#8ad8ff")
        cyan = materials.get("instrument cyan", "#00ffff", roughness=0.3, metallic=0.0, emission="#00ffff")
        amber = materials.get("instrument amber", "#f2c94c", roughness=0.3, metallic=0.0, emission="#f2c94c")
        throttle = materials.get("throttle green", "#58d38c", roughness=0.38, metallic=0.12, emission="#58d38c")
        active = materials.get("trigger active", "#f2c94c", roughness=0.36, metallic=0.18, emission="#f2c94c")
        control = materials.get("control orange", "#f4a340", roughness=0.42, metallic=0.18, emission="#f4a340")

        cockpit = empty(f"{self.ship_id}:cockpit-controls", self.root)
        cube("seat-pan", cockpit, (0, -4.05, -0.46), (1.55, 1.25, 0.18), dark)
        cube("seat-back", cockpit, (0, -3.56, 0.1), (1.32, 0.18, 1.05), dark, rot=(math.radians(-10), 0, 0))
        cube("left-console", cockpit, (-0.92, -4.72, -0.18), (0.28, 1.9, 0.38), panel)
        cube("right-console", cockpit, (0.92, -4.72, -0.18), (0.28, 1.9, 0.38), panel)
        cube("forward-coaming", cockpit, (0, -5.62, 0.02), (2.62, 0.36, 0.22), dark)
        cube("instrument-panel", cockpit, (0, -5.42, -0.08), (2.24, 0.14, 0.56), panel, rot=(math.radians(-6), 0, 0))
        cube("left-mfd", cockpit, (-0.55, -5.335, 0.0), (0.42, 0.02, 0.24), cyan, rot=(math.radians(-6), 0, 0))
        cube("right-mfd", cockpit, (0.55, -5.335, 0.0), (0.42, 0.02, 0.24), amber, rot=(math.radians(-6), 0, 0))
        cube("center-status", cockpit, (0, -5.33, -0.2), (0.34, 0.02, 0.12), cyan, rot=(math.radians(-6), 0, 0))
        cube("hud-glass", cockpit, (0, -5.14, 0.5), (0.68, 0.02, 0.36), glass, rot=(math.radians(-8), 0, 0))
        for i, x in enumerate([-0.66, -0.44, -0.22, 0.22, 0.44, 0.66]):
            sphere(f"panel-light:{i}", cockpit, (x, -5.08, 0.08 + (i % 2) * 0.16), 0.035, cyan if i % 2 else amber, segments=12)
        for i, x in enumerate([-0.72, -0.48, -0.24, 0, 0.24, 0.48, 0.72]):
            cube(f"panel-bar:{i}", cockpit, (x, -5.075, -0.28), (0.13, 0.018, 0.035 + 0.025 * (i % 3)), cyan if i % 2 else amber)

        bar_between("left-canopy-rail", cockpit, (-1.05, -5.72, 0.16), (-0.78, -3.35, 0.76), 0.045, frame)
        bar_between("right-canopy-rail", cockpit, (1.05, -5.72, 0.16), (0.78, -3.35, 0.76), 0.045, frame)
        bar_between("left-canopy-bow", cockpit, (-1.02, -4.66, 0.6), (-0.24, -4.55, 1.08), 0.05, frame)
        bar_between("right-canopy-bow", cockpit, (1.02, -4.66, 0.6), (0.24, -4.55, 1.08), 0.05, frame)
        bar_between("top-canopy-bow", cockpit, (-0.28, -4.55, 1.08), (0.28, -4.55, 1.08), 0.04, frame)
        bar_between("left-front-strut", cockpit, (-1.08, -5.44, 0.1), (-0.66, -5.08, 0.94), 0.045, frame)
        bar_between("right-front-strut", cockpit, (1.08, -5.44, 0.1), (0.66, -5.08, 0.94), 0.045, frame)
        bar_between("front-canopy-header", cockpit, (-0.66, -5.08, 0.94), (0.66, -5.08, 0.94), 0.045, frame)

        stick = empty("stick", cockpit)
        stick.location = (0.2, -5.16, -0.34)
        cylinder("stick:post", stick, (0, 0, 0.25), 0.03, 0.5, metal, vertices=12)
        grip = sphere("stick:grip", stick, (0, 0, 0.53), 0.085, active, segments=16)
        self.controls["stick"] = stick
        self.controls["grip"] = grip

        lever = empty("throttle", cockpit)
        lever.location = (-0.46, -5.52, -0.28)
        cube("throttle:base", cockpit, (-0.46, -5.52, -0.32), (0.24, 0.36, 0.08), dark)
        cylinder("throttle:post", lever, (0, 0, 0.25), 0.026, 0.52, metal, vertices=10)
        sphere("throttle:knob", lever, (0, 0, 0.55), 0.09, throttle, segments=16)
        self.controls["throttle"] = lever

        for name, x in (("left_pedal", -0.32), ("right_pedal", 0.32)):
            pedal = empty(name, cockpit)
            pedal.location = (x, -6.02, -0.15)
            cube(f"{name}:plate", pedal, (0, 0, 0), (0.24, 0.16, 0.08), control)
            cube(f"{name}:toe", pedal, (0, 0.07, 0.07), (0.19, 0.05, 0.05), metal)
            self.controls[name] = pedal

    def update(self, ship):
        self.root.matrix_world = pose_matrix(ship["position"], ship["orientation"])
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
        if "stick" in self.controls:
            self.controls["stick"].rotation_euler = (pitch, 0, roll)
        if "throttle" in self.controls:
            self.controls["throttle"].rotation_euler = (-0.55 + throttle * 1.05, 0, 0)
        if "left_pedal" in self.controls:
            self.controls["left_pedal"].location.y = -6.02 + yaw * 0.42
            self.controls["left_pedal"].rotation_euler = (-0.24 + yaw * 0.24, 0, 0)
        if "right_pedal" in self.controls:
            self.controls["right_pedal"].location.y = -6.02 - yaw * 0.42
            self.controls["right_pedal"].rotation_euler = (-0.24 - yaw * 0.24, 0, 0)

    def set_exterior_visible(self, visible):
        for obj in self.exterior_objects:
            obj.hide_render = not visible
            obj.hide_viewport = not visible


class AvatarRig:
    def __init__(self, avatar, pilot_rig):
        self.avatar = avatar
        self.pilot_rig = pilot_rig
        self.root = empty("vtuber:root", pilot_rig.root)
        self.imported = []
        self.armature = None
        self.base_location = Vector((0, 0, 0))
        self.base_yaw = 0.0
        self.import_avatar(Path(avatar["source"]))
        self.apply_mount()
        self.apply_neutral_pose()

    def import_avatar(self, source):
        if not source.exists():
            raise FileNotFoundError(f"avatar asset not found: {source}")
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(source))
        self.imported = [obj for obj in bpy.data.objects if obj not in before]
        top_level = [obj for obj in self.imported if obj.parent is None or obj.parent not in self.imported]
        for obj in top_level:
            parent_to(obj, self.root)

        for obj in self.imported:
            if obj.type == "ARMATURE":
                self.armature = obj
            if obj.type == "MESH":
                obj.visible_shadow = True
                for mat in obj.data.materials:
                    if mat:
                        mat.diffuse_color = tuple(min(1.0, c * 1.08) if i < 3 else c for i, c in enumerate(mat.diffuse_color))

    def apply_mount(self):
        self.base_location = sim_vec(self.avatar.get("rootLocal", {"x": 0, "y": -0.34, "z": -4.2}))
        self.base_yaw = math.radians(float(self.avatar.get("yawDeg", 180)))
        self.root.location = self.base_location
        self.root.rotation_euler = (0, 0, self.base_yaw)
        scale_value = float(self.avatar.get("scale", 0.78))
        self.root.scale = (scale_value, scale_value, scale_value)

    def set_pose_bone(self, name, xyz_deg):
        if not self.armature:
            return
        bone = self.armature.pose.bones.get(name)
        if not bone:
            return
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = tuple(math.radians(value) for value in xyz_deg)

    def apply_neutral_pose(self):
        # The sample VRM imports in a T-pose. Keep this intentionally mild: enough to sell a seated
        # cockpit shot without pretending this first pass is a solved IK rig.
        self.set_pose_bone("J_Bip_L_UpperArm", (0, 0, -54))
        self.set_pose_bone("J_Bip_R_UpperArm", (0, 0, 54))
        self.set_pose_bone("J_Bip_L_LowerArm", (0, -10, -14))
        self.set_pose_bone("J_Bip_R_LowerArm", (0, 10, 14))
        self.set_pose_bone("J_Bip_C_Spine", (-5, 0, 0))
        self.set_pose_bone("J_Bip_C_Chest", (4, 0, 0))

    def update(self, frame):
        dynamics = frame.get("pilotDynamics") or {}
        if dynamics.get("pilotId") != self.avatar.get("pilotId"):
            return
        pitch = math.radians(float(dynamics.get("rootPitchDeg", 0)))
        roll = math.radians(float(dynamics.get("rootRollDeg", 0)))
        head_pitch = math.radians(float(dynamics.get("headPitchDeg", 0)))
        head_roll = math.radians(float(dynamics.get("headRollDeg", 0)))
        seat_sink = float(dynamics.get("seatSinkM", 0))
        self.root.location = self.base_location + Vector((0, 0, -seat_sink))
        self.root.rotation_euler = (pitch, roll, self.base_yaw)
        self.set_pose_bone("J_Bip_C_Neck", (math.degrees(head_pitch) * 0.45, math.degrees(head_roll) * 0.25, 0))
        self.set_pose_bone("J_Bip_C_Head", (math.degrees(head_pitch), math.degrees(head_roll), 0))


def build_world(materials):
    terrain = materials.get("terrain", "#4b6b48", roughness=0.95, metallic=0.02)
    grid = materials.get("runway grid", "#6f8f74", roughness=0.8, metallic=0.0)
    cube("ground", empty("world"), (0, 0, -1.2), (9000, 9000, 0.4), terrain)
    for i in range(-8, 9):
        cube(f"grid:x:{i}", bpy.data.objects["world"], (i * 500, 0, -0.95), (3, 9000, 0.05), grid)
        cube(f"grid:y:{i}", bpy.data.objects["world"], (0, i * 500, -0.94), (9000, 3, 0.05), grid)

    bpy.ops.object.light_add(type="SUN", location=(0, 0, 0))
    sun = bpy.context.object
    sun.name = "sun"
    sun.rotation_euler = (math.radians(45), 0, math.radians(28))
    sun.data.energy = 4.0
    bpy.ops.object.light_add(type="AREA", location=(0, -200, 600))
    area = bpy.context.object
    area.name = "sky fill"
    area.data.energy = 500
    area.data.size = 800


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


def render_timeline(timeline, output_path, frames_dir, keep_frames, samples):
    clear_scene()
    configure_scene(timeline, samples)
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

    frames_path = Path(frames_dir)
    if frames_path.exists():
        shutil.rmtree(frames_path)
    frames_path.mkdir(parents=True, exist_ok=True)

    for frame in timeline["frames"]:
        bpy.context.scene.frame_set(int(frame["index"]))
        for ship in frame["aircraft"]:
            rig = rigs.get(ship["id"])
            if rig:
                rig.update(ship)
        if avatar_rig:
            avatar_rig.update(frame)
        cockpit_like = (
            frame["camera"]["mode"] in {"cockpit", "pilot-hero"} or frame["camera"]["shot"] == "cockpit-controls"
        )
        for rig in rigs.values():
            rig.set_exterior_visible(not (cockpit_like and rig.ship_id == timeline.get("pilotId")))
        update_camera(camera, frame["camera"])
        tracers.update(frame.get("events", []))
        bpy.context.scene.render.filepath = str(frames_path / f"frame_{int(frame['index']):06d}.png")
        print(f"render frame {frame['index'] + 1}/{len(timeline['frames'])}: {frame['camera']['shot']}", flush=True)
        bpy.ops.render.render(write_still=True)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(
        [
            "ffmpeg",
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
