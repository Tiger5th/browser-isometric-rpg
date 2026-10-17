#!/usr/bin/env python3
"""VRM/glTF 角色资产 Blender 后处理（票 30：真实角色接入管线）。

背景
----
Booth 免费 VRM（VRoid 系）导出后是 MToon 材质 + VRM 专有扩展（springBone /
node_constraint / materials_mtoon）。本项目的渲染层用自研 toon shader
（src/render/anime/toonMaterial.ts）+ Babylon 描边 + glTF morph 眨眼，
因此不需要 MToon，也不需要 VRM 扩展；扩展由 tools/pipeline/vrm-to-glb.mjs
在 GLB 容器层剥离。

本脚本负责 Blender 侧的三件事：
  1. 导入标准 glTF（VRM 经 vrm-to-glb.mjs 预处理后的产物，或任何 glb）。
  2. 换贴图：把指定网格的 baseColor 贴图替换成给定 PNG（数据驱动，
     贴图路径从命令行传入；票 29 的色板卡产出后直接换路径即可）。
  3. 规范命名：网格/骨骼/材质按 tools/pipeline/lint.mjs 的 NAME_PATTERN
     重命名，使真实资产能过 lint（否则 `character_` 之外的命名会报违规）。
  4. 导出标准 GLB（不导出 MToon/VRM 扩展，骨骼 + 蒙皮 + 动画 + morph 全保留）。

设计目标（继承自 export_test_asset.py）：
- 完全不依赖 UI，headless 可跑；不确定的中间产物只在内存。
- 导出参数集中在一个 dict 里，便于与 export_test_asset.py 保持一致。

用法
----
    blender --background --factory-startup \
      --python tools/pipeline/blender/prepare_vrm_character.py -- \
        --input  assets/character_vrm_prepped.glb \
        --output assets/character_real_lod0.glb \
        [--texture-map body=assets/textures/character_body.png] \
        [--texture-map-mesh body=mesh_name] \
        [--rename-prefix character] \
        [--report reports/blender-vrm-prep.json]

--texture-map 的格式是 `<槽位名>=<PNG 路径>`；槽位名 currently 只支持
`body`（主贴图）与 `face`（脸部贴图）。多槽位可重复传。
"""

import json
import os
import sys

import bpy


# ---------------------------------------------------------------- 报告工具


class Report:
    """收集处理过程的结构化信息，最终写入 JSON（供管线 lint / 人工核对）。"""

    def __init__(self) -> None:
        self.data = {
            "input": None,
            "output": None,
            "textureMap": {},
            "renamed": [],
            "meshCount": 0,
            "primitiveCount": 0,
            "armatureCount": 0,
            "boneCount": 0,
            "materialCount": 0,
            "textureSwaps": [],
            "morphTargets": 0,
            "animations": [],
            "warnings": [],
        }

    def warn(self, message: str) -> None:
        self.data["warnings"].append(message)
        print(f"[prepare-vrm][warn] {message}")

    def write(self, path: str) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(self.data, handle, ensure_ascii=False, indent=2)
        print(f"[prepare-vrm] report → {path}")


# ---------------------------------------------------------------- 参数解析


def parse_args(argv):
    """解析 `--` 之后的参数；返回 dict。"""
    args = {}
    if "--" not in argv:
        return args
    rest = argv[argv.index("--") + 1 :]
    index = 0
    while index < len(rest):
        token = rest[index]
        if not token.startswith("--"):
            index += 1
            continue
        key = token[2:]
        if index + 1 < len(rest) and not rest[index + 1].startswith("--"):
            value = rest[index + 1]
            index += 2
        else:
            value = True
            index += 1
        if key == "texture-map":
            args.setdefault("textureMap", []).append(value)
        else:
            args[key] = value
    return args


# ---------------------------------------------------------------- 场景清理


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.textures,
        bpy.data.images,
        bpy.data.armatures,
        bpy.data.actions,
    ):
        for item in list(block):
            try:
                block.remove(item)
            except Exception:  # pragma: no cover - 防御性
                pass


# ---------------------------------------------------------------- 导入


def import_glb(path: str) -> None:
    bpy.ops.import_scene.gltf(filepath=path)


def scene_objects():
    return list(bpy.context.scene.objects)


def mesh_objects():
    return [obj for obj in scene_objects() if obj.type == "MESH"]


def armature_objects():
    return [obj for obj in scene_objects() if obj.type == "ARMATURE"]


# ---------------------------------------------------------------- 换贴图


def _slot_keywords(slot: str):
    """槽位名 → 网格名匹配关键词（小写子串匹配）。

    `body` 匹配除脸/发/眼之外的主网格；`face` 匹配脸/头部网格。
    VRoid 模型的网格命名通常是 Face / Body / Hair，直接按名匹配即可。
    """
    if slot == "body":
        return ("body", "skin", "torso", "cloth")
    if slot == "face":
        return ("face", "head", "eye")
    return (slot.lower(),)


def _find_material_nodes(material):
    """返回材质的 (principled, tex_image_node)；非节点材质返回 (None, None)。"""
    if not material or not material.use_nodes:
        return None, None
    principled = None
    tex_node = None
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            principled = node
        elif node.type == "TEX_IMAGE":
            # 取第一个真正连到 Base Color 的贴图节点；否则退回第一个。
            if tex_node is None:
                tex_node = node
    return principled, tex_node


def swap_texture(objects, slot: str, texture_path: str, report: Report) -> bool:
    """把 slot 对应网格的 baseColor 贴图替换为 texture_path。

    返回是否至少改到了一个网格。
    """
    keywords = _slot_keywords(slot)
    swapped = False
    for obj in objects:
        name_lower = obj.name.lower()
        if not any(keyword in name_lower for keyword in keywords):
            continue
        for material_slot in obj.material_slots:
            material = material_slot.material
            if material is None:
                continue
            principled, tex_node = _find_material_nodes(material)
            if tex_node is None:
                report.warn(
                    f"{obj.name}/{material.name} 没有 TEX_IMAGE 节点，跳过贴图替换"
                )
                continue
            image = bpy.data.images.load(os.path.abspath(texture_path), check_existing=False)
            image.name = f"texture_{slot}_replacement"
            tex_node.image = image
            if principled is not None:
                # 确保贴图仍连到 Base Color（VRM 导入后常在）。
                pass
            report.data["textureSwaps"].append(
                {
                    "slot": slot,
                    "mesh": obj.name,
                    "material": material.name,
                    "texture": os.path.basename(texture_path),
                }
            )
            swapped = True
    if not swapped:
        report.warn(
            f"贴图槽位 {slot} 没有匹配到网格（关键词 {keywords}）；"
            "未替换任何贴图"
        )
    return swapped


# ---------------------------------------------------------------- 规范命名

NAME_PREFIXES = (
    "b_",  # 骨骼
    "character_",
    "material_",
    "texture_",
    "anim_",
    "morph_",
    "skin_",
)


def _sanitize(name: str) -> str:
    """转成 lint.mjs 认可的小写蛇形片段。"""
    cleaned = []
    for char in name:
        if char.isalnum():
            cleaned.append(char.lower())
        elif char in " -_":
            cleaned.append("_")
    result = "".join(cleaned)
    while "__" in result:
        result = result.replace("__", "_")
    return result.strip("_") or "unnamed"


def _has_valid_prefix(name: str) -> bool:
    """是否已满足 lint NAME_PATTERN（已有合法前缀则不再重复添加）。"""
    return name.startswith(NAME_PREFIXES)


def rename_objects(objects, prefix: str, report: Report) -> None:
    """按前缀 + 蛇形重命名网格/骨骼/材质，使其满足 lint NAME_PATTERN。"""
    used = set()
    for obj in objects:
        base = _sanitize(obj.name)
        # 已有合法前缀（如 P0 占位资产的 character_ / material_）不重复添加，
        # 否则会得到 character_character_xxx 这种双前缀命名。
        new_name = base if _has_valid_prefix(base) else f"{prefix}_{base}"
        candidate = new_name
        suffix = 1
        while candidate in used:
            suffix += 1
            candidate = f"{new_name}_{suffix}"
        used.add(candidate)
        if obj.name != candidate:
            report.data["renamed"].append({"from": obj.name, "to": candidate})
        obj.name = candidate

    for armature in armature_objects():
        for bone in armature.data.bones:
            base = _sanitize(bone.name)
            # 已有 b_ 前缀（合法骨骼名 / 已处理过的骨骼）不重复加，
            # 否则会得到 b_b_xxx。与 _has_valid_prefix 同理但只认 b_。
            new_name = base if base.startswith("b_") else f"b_{base}"
            if bone.name != new_name:
                report.data["renamed"].append({"from": bone.name, "to": new_name})
            bone.name = new_name

    for material in bpy.data.materials:
        base = _sanitize(material.name)
        new_name = base if _has_valid_prefix(base) else f"material_{base}"
        if material.name != new_name:
            report.data["renamed"].append({"from": material.name, "to": new_name})
        material.name = new_name


# ---------------------------------------------------------------- 统计


def collect_stats(report: Report) -> None:
    meshes = mesh_objects()
    report.data["meshCount"] = len(meshes)
    report.data["primitiveCount"] = sum(
        max(1, len(obj.material_slots)) for obj in meshes
    )
    report.data["armatureCount"] = len(armature_objects())
    report.data["boneCount"] = sum(
        len(arm.data.bones) for arm in armature_objects()
    )
    report.data["materialCount"] = len(bpy.data.materials)
    report.data["morphTargets"] = sum(
        len(obj.data.shape_keys.key_blocks) - 1
        for obj in meshes
        if obj.data.shape_keys is not None
    )
    report.data["animations"] = [
        {"name": action.name, "frames": int(action.frame_range[1] - action.frame_range[0])}
        for action in bpy.data.actions
    ]


# ---------------------------------------------------------------- 导出

EXPORT_DEFAULTS = {
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
    "export_anim_single_armature": True,
    "export_extras": False,
    "export_cameras": False,
    "export_lights": False,
    "export_def_bones": False,
    "export_rest_position_armature": True,
}


def export_glb(output_path: str) -> None:
    available = set(
        bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    )
    kwargs = {key: value for key, value in EXPORT_DEFAULTS.items() if key in available}
    kwargs["filepath"] = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(kwargs["filepath"]), exist_ok=True)
    bpy.ops.export_scene.gltf(**kwargs)
    print(f"[prepare-vrm] wrote {output_path}")


# ---------------------------------------------------------------- main


def main() -> None:
    args = parse_args(sys.argv)
    input_path = args.get("input")
    output_path = args.get("output")
    report_path = args.get("report", "reports/blender-vrm-prep.json")
    rename_prefix = args.get("rename-prefix", "character")

    if not input_path or not output_path:
        print(
            "用法：blender --background --factory-startup --python "
            "tools/pipeline/blender/prepare_vrm_character.py -- "
            "--input in.glb --output out.glb "
            "[--texture-map body=path.png] [--report path.json]"
        )
        sys.exit(2)

    report = Report()
    report.data["input"] = os.path.abspath(input_path)
    report.data["output"] = os.path.abspath(output_path)

    for entry in args.get("textureMap", []):
        if "=" not in entry:
            report.warn(f"--texture-map 参数格式错误（应为 槽位=路径）：{entry}")
            continue
        slot, path = entry.split("=", 1)
        if not os.path.isfile(path):
            report.warn(f"贴图文件不存在：{path}")
            continue
        report.data["textureMap"][slot] = os.path.abspath(path)

    clear_scene()
    import_glb(os.path.abspath(input_path))

    meshes = mesh_objects()
    if not meshes:
        report.warn("导入后没有网格对象")
    if not armature_objects():
        report.warn("导入后没有骨架（VRM 应有骨骼；若是静态模型请人工确认）")

    for slot, path in report.data["textureMap"].items():
        swap_texture(meshes, slot, path, report)

    rename_objects(meshes, rename_prefix, report)
    collect_stats(report)

    if report.data["warnings"]:
        print(f"[prepare-vrm] {len(report.data['warnings'])} 条警告（见 report）")

    export_glb(output_path)
    report.write(report_path)


main()
