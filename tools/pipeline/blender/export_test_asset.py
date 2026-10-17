#!/usr/bin/env python3
"""Headless Blender 测试资产导出（含骨骼动画 + shape keys）。

用法：
  blender --background --factory-startup \
    --python tools/pipeline/blender/export_test_asset.py -- assets/character_test_lod0.glb

设计目标：
- 不读取任何外部美术文件；贴图由脚本确定性生成。
- 固定帧率/帧范围、线性插值、强制采样，保证连续两次导出字节一致。
- glTF 导出器负责 Z-up → Y-up；脚本内不做额外轴翻转。
"""

import math
import os
import struct
import sys
import zlib

import bmesh
import bpy
from mathutils import Vector

TEXTURE_SIZE = 1024
FPS = 24
FRAME_START = 1
FRAME_END = 49


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", crc32(kind + payload))
    )


def write_test_texture(path: str) -> None:
    """与 JS 后备生成器同构的程序化贴图；逐字节确定。"""
    rows = []
    for y in range(TEXTURE_SIZE):
        row = bytearray([0])  # filter: none
        for x in range(TEXTURE_SIZE):
            u = x / TEXTURE_SIZE
            v = y / TEXTURE_SIZE
            checker = (int(u * 16) + int(v * 16)) % 2 == 0
            r = 58 + 118 * u
            g = 76 + 96 * v
            b = 128 + 74 * (1 - u * v)
            if not checker:
                r *= 0.72
                g *= 0.74
                b *= 0.82
            if x % 128 < 3 or y % 128 < 3:
                r, g, b = 232, 204, 96
            if abs(math.hypot(u - 0.5, v - 0.5) - 0.3) < 0.008:
                r, g, b = 236, 242, 250
            row.extend((int(r), int(g), int(b), 255))
        rows.append(bytes(row))

    ihdr = struct.pack(">IIBBBBB", TEXTURE_SIZE, TEXTURE_SIZE, 8, 6, 0, 0, 0)
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(png_chunk(b"IHDR", ihdr))
        handle.write(png_chunk(b"IDAT", zlib.compress(b"".join(rows), 9)))
        handle.write(png_chunk(b"IEND", b""))


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.actions,
    ):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


PARTS = [
    # name, lon, lat, center, radii
    ("body", 80, 48, (0.0, 0.0, 1.15), (0.42, 0.28, 0.6)),
    ("head", 48, 24, (0.0, 0.0, 1.95), (0.3, 0.3, 0.32)),
    ("arm_l", 20, 12, (-0.55, 0.0, 1.35), (0.11, 0.11, 0.42)),
    ("arm_r", 20, 12, (0.55, 0.0, 1.35), (0.11, 0.11, 0.42)),
    ("leg_l", 20, 12, (-0.18, 0.0, 0.45), (0.13, 0.13, 0.5)),
    ("leg_r", 20, 12, (0.18, 0.0, 0.45), (0.13, 0.13, 0.5)),
]


def sort_bmesh_faces_deterministic(bm: bmesh.types.BMesh) -> None:
    """把 bmesh 的面按 (最小顶点 index, 顶点 index 元组) 排序，保证跨进程一致。

    背景（票 30 定位）：bmesh.ops.create_uvsphere 产出的**顶点**坐标与顺序是
    跨进程确定的，但**面在 bm.faces 中的存储顺序不是**（同一组面、不同排列，
    Blender 4.5.3 LTS 实测）。bm.to_mesh() 按该存储顺序生成多边形循环，
    glTF 导出器再据此写索引缓冲区——于是两次 headless 导出的 GLB 索引
    字节不同，`assets:blender:repro` 的 SHA-256 比对必然失败。

    bmesh 没有 sort_faces 算子，且 bmesh 不支持删除后重建的确定性保证，
    因此这里在 to_mesh 之前把面按规范化 key 重排：先收集
    (min_vert_index, vert_indices) 排序，再按该顺序重新插入面。
    """
    ordered = sorted(
        (tuple(vert.index for vert in face.verts) for face in bm.faces),
        key=lambda indices: (min(indices), indices),
    )
    faces = [face for face in bm.faces]
    bmesh.ops.delete(bm, geom=faces, context="FACES_ONLY")
    lookup = {vert.index: vert for vert in bm.verts}
    for indices in ordered:
        bm.faces.new(tuple(lookup[index] for index in indices))


def build_mesh() -> bpy.types.Object:
    bm = bmesh.new()
    for _name, lon, lat, center, radii in PARTS:
        result = bmesh.ops.create_uvsphere(
            bm,
            u_segments=lon,
            v_segments=lat,
            radius=1.0,
            calc_uvs=True,
        )
        verts = result["verts"]
        for vert in verts:
            vert.co = Vector(
                (
                    vert.co.x * radii[0] + center[0],
                    vert.co.y * radii[1] + center[1],
                    vert.co.z * radii[2] + center[2],
                )
            )

    for face in bm.faces:
        face.smooth = True

    # 必须在 to_mesh 之前：bmesh 面序跨进程不稳定（见函数 docstring）。
    sort_bmesh_faces_deterministic(bm)

    mesh = bpy.data.meshes.new("character_test_lod0")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    obj = bpy.data.objects.new("character_test_lod0", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_armature() -> bpy.types.Object:
    armature = bpy.data.armatures.new("character_test_rig")
    obj = bpy.data.objects.new("character_test_rig", armature)
    bpy.context.scene.collection.objects.link(obj)

    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = armature.edit_bones

    def add_bone(name, head, tail, parent=None, connect=False):
        bone = edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        if parent is not None:
            bone.parent = edit_bones[parent]
            bone.use_connect = connect
        return bone

    add_bone("b_root", (0, 0, 0), (0, 0, 0.75))
    add_bone("b_spine", (0, 0, 0.75), (0, 0, 1.7), "b_root", True)
    add_bone("b_head", (0, 0, 1.7), (0, 0, 2.27), "b_spine", True)
    add_bone("b_arm_l", (-0.55, 0, 1.6), (-0.55, 0, 1.0), "b_spine")
    add_bone("b_arm_r", (0.55, 0, 1.6), (0.55, 0, 1.0), "b_spine")
    add_bone("b_leg_l", (-0.18, 0, 0.9), (-0.18, 0, 0.0), "b_root")
    add_bone("b_leg_r", (0.18, 0, 0.9), (0.18, 0, 0.0), "b_root")

    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def assign_weights(mesh_obj: bpy.types.Object) -> None:
    groups = {
        name: mesh_obj.vertex_groups.new(name=name)
        for name in (
            "b_root",
            "b_spine",
            "b_head",
            "b_arm_l",
            "b_arm_r",
            "b_leg_l",
            "b_leg_r",
        )
    }

    for vertex in mesh_obj.data.vertices:
        x, _y, z = vertex.co
        if z > 1.78:
            groups["b_head"].add([vertex.index], 1.0, "REPLACE")
        elif abs(x) > 0.45 and z > 1.0:
            groups["b_arm_r" if x > 0 else "b_arm_l"].add(
                [vertex.index], 1.0, "REPLACE"
            )
        elif z < 0.85 and abs(x) > 0.05:
            groups["b_leg_r" if x > 0 else "b_leg_l"].add(
                [vertex.index], 1.0, "REPLACE"
            )
        else:
            t = min(1.0, max(0.0, (z - 0.6) / 0.9))
            groups["b_spine"].add([vertex.index], t, "REPLACE")
            groups["b_root"].add([vertex.index], 1.0 - t, "REPLACE")


def add_shape_key(mesh_obj: bpy.types.Object) -> bpy.types.ShapeKey:
    mesh_obj.shape_key_add(name="Basis", from_mix=False)
    key = mesh_obj.shape_key_add(name="morph_head_bulge", from_mix=False)
    for vertex in mesh_obj.data.vertices:
        if vertex.co.z > 1.78:
            offset = vertex.normal * 0.09
            key.data[vertex.index].co = vertex.co + Vector(offset)
    return key


def setup_material(mesh_obj: bpy.types.Object, texture_path: str) -> None:
    image = bpy.data.images.load(texture_path)
    image.name = "texture_test_character_base"
    image.pack()

    material = bpy.data.materials.new("material_test_character")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get("Principled BSDF")
    principled.inputs["Metallic"].default_value = 0.05
    principled.inputs["Roughness"].default_value = 0.85

    image_node = nodes.new("ShaderNodeTexImage")
    image_node.image = image
    links.new(image_node.outputs["Color"], principled.inputs["Base Color"])

    mesh_obj.data.materials.append(material)


def bind_armature(mesh_obj: bpy.types.Object, armature_obj: bpy.types.Object) -> None:
    mesh_obj.parent = armature_obj
    modifier = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    modifier.object = armature_obj


def add_animations(
    armature_obj: bpy.types.Object, mesh_obj: bpy.types.Object, key: bpy.types.ShapeKey
) -> None:
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = FRAME_START
    scene.frame_end = FRAME_END

    bpy.context.view_layer.objects.active = armature_obj
    bpy.ops.object.select_all(action="DESELECT")
    armature_obj.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    pose_bone = armature_obj.pose.bones["b_arm_r"]
    pose_bone.rotation_mode = "QUATERNION"

    armature_obj.animation_data_create()
    armature_action = bpy.data.actions.new("anim_test_character_idle")
    armature_obj.animation_data.action = armature_action

    key_frames = [FRAME_START + i * 6 for i in range(9)]
    for index, frame in enumerate(key_frames):
        t = index / 8
        angle = math.sin(t * math.tau) * 0.55
        pose_bone.rotation_quaternion = (
            math.cos(angle / 2),
            0.0,
            0.0,
            math.sin(angle / 2),
        )
        pose_bone.keyframe_insert("rotation_quaternion", frame=frame)
    bpy.ops.object.mode_set(mode="OBJECT")

    for fcurve in armature_action.fcurves:
        for point in fcurve.keyframe_points:
            point.interpolation = "LINEAR"

    shape_keys = mesh_obj.data.shape_keys
    shape_keys.animation_data_create()
    morph_action = bpy.data.actions.new("anim_test_character_morph")
    shape_keys.animation_data.action = morph_action
    key_block = shape_keys.key_blocks["morph_head_bulge"]
    for index, frame in enumerate(key_frames):
        t = index / 8
        key_block.value = (math.sin(t * math.tau) + 1) / 2
        key_block.keyframe_insert("value", frame=frame)
    for fcurve in morph_action.fcurves:
        for point in fcurve.keyframe_points:
            point.interpolation = "LINEAR"


def export_glb(output_path: str) -> None:
    desired = {
        "filepath": output_path,
        "export_format": "GLB",
        "export_apply": False,
        "export_yup": True,
        "export_texcoords": True,
        "export_normals": True,
        "export_skins": True,
        "export_morph": True,
        "export_animations": True,
        "export_force_sampling": True,
        "export_frame_range": True,
        "export_frame_step": 1,
        "export_optimize_animation_size": False,
        "export_optimize_animation_keep_anim_armature": True,
        "export_nla_strips": False,
        "export_anim_single_armature": True,
        "export_extras": False,
        "export_cameras": False,
        "export_lights": False,
        "export_def_bones": False,
        "export_rest_position_armature": True,
    }
    available = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    kwargs = {key: value for key, value in desired.items() if key in available}
    bpy.ops.export_scene.gltf(**kwargs)


def main() -> None:
    argv = sys.argv
    output_path = (
        argv[argv.index("--") + 1]
        if "--" in argv and len(argv) > argv.index("--") + 1
        else "assets/character_test_lod0.glb"
    )
    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    texture_path = os.path.join(
        os.path.dirname(output_path), "character_test_basecolor.png"
    )
    write_test_texture(texture_path)

    clear_scene()
    mesh_obj = build_mesh()
    armature_obj = build_armature()
    assign_weights(mesh_obj)
    key = add_shape_key(mesh_obj)
    setup_material(mesh_obj, texture_path)
    bind_armature(mesh_obj, armature_obj)
    add_animations(armature_obj, mesh_obj, key)

    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0

    export_glb(output_path)
    print(f"[blender-export] wrote {output_path}")


if __name__ == "__main__":
    main()
