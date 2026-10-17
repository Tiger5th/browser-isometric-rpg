#!/usr/bin/env node
/**
 * 资产 lint（glTF-Transform 自定义校验）。
 *
 * 规则针对 AI 生成资产加固：
 * - 命名：小写蛇形 + 类别前缀；骨骼 `b_` 前缀；LOD 后缀 `_lodN`
 * - 三角数：角色 ≤ 15k / 环境 ≤ 5k / 道具 ≤ 3k
 * - 贴图：单边 ≤ 2048，建议 2 的幂
 * - 材质/贴图数量上限
 * - 拓扑：非流形边（>2 面共边）、退化三角、悬空顶点、边界边
 * - 蒙皮/morph 结构一致性
 *
 * 用法：node tools/pipeline/lint.mjs [file.glb ...]
 * 无参数时扫描 assets/*.glb 与 assets/textures/*.png；结果写入 reports/pipeline-lint.json。
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import {
  EXTMeshoptCompression,
  KHRDracoMeshCompression,
  KHRMeshQuantization,
  KHRTextureBasisu,
} from "@gltf-transform/extensions";
import draco3d from "draco3d";
import { MeshoptDecoder } from "meshoptimizer";

const ROOT = resolve(import.meta.dirname, "../..");
const ASSETS_DIR = join(ROOT, "assets");
const TEXTURES_DIR = join(ASSETS_DIR, "textures");
const REPORT_PATH = join(ROOT, "reports/pipeline-lint.json");

const TRIANGLE_LIMITS = {
  character: 15000,
  environment: 5000,
  prop: 3000,
  default: 20000,
};
const MAX_TEXTURE_SIZE = 2048;
const MAX_MATERIALS = 4;
const MAX_TEXTURES = 8;

/**
 * 外部（人工制作）资产：Booth 免费 VRM 等，经 assets:real-character 管线产出。
 *
 * 这些资产的命名（VRoid/Blender 惯例：J_Bip、hair1.001）、拓扑（发片开放
 * 网格、非流形边）与材质数量天然不符合程序化资产约定；强行重命名/减面
 * 只会破坏可调试性与质量。对外部资产：
 * - 命名/拓扑违规降级为 warning（仍全部上报，不阻断）；
 * - 预算改用下方放宽限额（仍受控，防止无脑塞高模）。
 * 结构性错误（morph 结构、skin 一致性、动画悬空通道）不放宽——那是管线
 * 消费硬约束。
 */
const EXTERNAL_ASSETS = new Set(["character_vroid_lod0.glb"]);
const EXTERNAL_LIMITS = {
  perMeshTriangles: 30000,
  totalTriangles: 60000,
  materials: 32,
  textures: 24,
};

const NAME_PATTERN =
  /^(b_[a-z0-9_]+|(character|environment|prop|material|texture|anim|collider|light|camera|scene|skin|primitive|attr|morph|sampler|node)_[a-z0-9_]+)$/;

/**
 * 报告时间戳：保证可复现（Windows 路径分隔符/时间戳会让两次运行输出不一致）。
 * 优先级：SOURCE_DATE_EPOCH（秒，https://reproducible-builds.org）>
 * 环境变量 LINT_TIMESTAMP（ISO 字符串，负向测试固定期望用）> 当前时间。
 */
export function reportTimestamp(sourcePath) {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch !== undefined && sourceDateEpoch !== "") {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  const fixed = process.env.LINT_TIMESTAMP;
  if (fixed !== undefined && fixed !== "") {
    return fixed;
  }
  if (sourcePath !== undefined) {
    // 缺省取源文件 mtime，同输入产出同报告。
    return statSync(sourcePath).mtime.toISOString();
  }
  return new Date().toISOString();
}

function violation(rule, severity, path, message) {
  return { rule, severity, path, message };
}

function categoryOf(name) {
  return name.split("_")[0] ?? "default";
}

function triangleLimitFor(name) {
  return TRIANGLE_LIMITS[categoryOf(name)] ?? TRIANGLE_LIMITS.default;
}

function checkName(name, path, violations, severity = "error") {
  if (!name || name.trim() === "") {
    violations.push(violation("naming", severity, path, "缺少名称"));
    return;
  }
  if (!NAME_PATTERN.test(name)) {
    violations.push(
      violation(
        "naming",
        severity,
        path,
        `名称 "${name}" 不符合小写蛇形/类别前缀约定（骨骼用 b_ 前缀）`,
      ),
    );
  }
}

function analyzeTopology(primitive) {
  const indices = primitive.getIndices()?.getArray();
  const position = primitive.getAttribute("POSITION")?.getArray();
  if (!indices || !position) {
    return null;
  }

  const edgeCounts = new Map();
  const usedVertices = new Set();
  let degenerateTriangles = 0;
  const indexCount = indices.length;

  for (let i = 0; i < indexCount; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (a === b || b === c || a === c) {
      degenerateTriangles += 1;
      continue;
    }

    const ax = position[a * 3];
    const ay = position[a * 3 + 1];
    const az = position[a * 3 + 2];
    const abx = position[b * 3] - ax;
    const aby = position[b * 3 + 1] - ay;
    const abz = position[b * 3 + 2] - az;
    const acx = position[c * 3] - ax;
    const acy = position[c * 3 + 1] - ay;
    const acz = position[c * 3 + 2] - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ < 1e-20) {
      degenerateTriangles += 1;
      continue;
    }

    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
    usedVertices.add(a);
    usedVertices.add(b);
    usedVertices.add(c);
  }

  let nonManifoldEdges = 0;
  let boundaryEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count > 2) {
      nonManifoldEdges += 1;
    } else if (count === 1) {
      boundaryEdges += 1;
    }
  }

  const vertexCount = position.length / 3;
  return {
    vertexCount,
    triangleCount: indexCount / 3,
    nonManifoldEdges,
    boundaryEdges,
    degenerateTriangles,
    looseVertices: Math.max(0, vertexCount - usedVertices.size),
  };
}

function lintDocument(document, fileName, { external = false } = {}) {
  const violations = [];
  const root = document.getRoot();
  const topology = [];
  /** 外部资产：命名/拓扑违规降级为 warning（见文件头 EXTERNAL_ASSETS 注释）。 */
  const severityFor = (base) => (external ? "warning" : base);
  const materialLimit = external ? EXTERNAL_LIMITS.materials : MAX_MATERIALS;
  const textureLimit = external ? EXTERNAL_LIMITS.textures : MAX_TEXTURES;

  for (const node of root.listNodes()) {
    checkName(node.getName(), `node:${node.getName() || "(unnamed)"}`, violations, severityFor("error"));
  }
  for (const mesh of root.listMeshes()) {
    checkName(mesh.getName(), `mesh:${mesh.getName() || "(unnamed)"}`, violations, severityFor("error"));
  }
  for (const material of root.listMaterials()) {
    checkName(
      material.getName(),
      `material:${material.getName() || "(unnamed)"}`,
      violations,
      severityFor("error"),
    );
  }
  for (const texture of root.listTextures()) {
    checkName(
      texture.getName(),
      `texture:${texture.getName() || "(unnamed)"}`,
      violations,
      severityFor("error"),
    );
  }
  for (const animation of root.listAnimations()) {
    checkName(
      animation.getName(),
      `animation:${animation.getName() || "(unnamed)"}`,
      violations,
      severityFor("error"),
    );
  }

  if (root.listMaterials().length > materialLimit) {
    violations.push(
      violation(
        "material-count",
        "error",
        "document",
        `材质数 ${root.listMaterials().length} 超过上限 ${materialLimit}`,
      ),
    );
  }
  if (root.listTextures().length > textureLimit) {
    violations.push(
      violation(
        "texture-count",
        "error",
        "document",
        `贴图数 ${root.listTextures().length} 超过上限 ${textureLimit}`,
      ),
    );
  }

  for (const texture of root.listTextures()) {
    const size = texture.getSize();
    if (!size || size[0] <= 0 || size[1] <= 0) {
      violations.push(
        violation(
          "texture-size",
          "warning",
          `texture:${texture.getName()}`,
          "无法读取贴图尺寸（可能为压缩格式，运行时确认）",
        ),
      );
      continue;
    }
    if (size[0] > MAX_TEXTURE_SIZE || size[1] > MAX_TEXTURE_SIZE) {
      violations.push(
        violation(
          "texture-size",
          "error",
          `texture:${texture.getName()}`,
          `贴图尺寸 ${size[0]}×${size[1]} 超过上限 ${MAX_TEXTURE_SIZE}`,
        ),
      );
    }
    const isPowerOfTwo = (value) => (value & (value - 1)) === 0;
    if (!isPowerOfTwo(size[0]) || !isPowerOfTwo(size[1])) {
      violations.push(
        violation(
          "texture-power-of-two",
          "warning",
          `texture:${texture.getName()}`,
          `贴图尺寸 ${size[0]}×${size[1]} 不是 2 的幂`,
        ),
      );
    }
  }

  for (const mesh of root.listMeshes()) {
    let meshTriangles = 0;
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      const triangleCount = indices
        ? indices.getCount() / 3
        : (position?.getCount() ?? 0) / 3;
      meshTriangles += triangleCount;

      const baseCount = position?.getCount() ?? 0;
      for (const target of primitive.listTargets()) {
        const targetPosition = target.getAttribute("POSITION");
        if (!targetPosition) {
          violations.push(
            violation(
              "morph-target",
              "error",
              `mesh:${mesh.getName()}`,
              "morph target 缺少 POSITION",
            ),
          );
        } else if (targetPosition.getCount() !== baseCount) {
          violations.push(
            violation(
              "morph-target",
              "error",
              `mesh:${mesh.getName()}`,
              `morph target 顶点数 ${targetPosition.getCount()} 与基础 ${baseCount} 不一致`,
            ),
          );
        }
      }

      const analysis = analyzeTopology(primitive);
      if (analysis) {
        topology.push({ mesh: mesh.getName(), ...analysis });
        if (analysis.nonManifoldEdges > 0) {
          violations.push(
            violation(
              "non-manifold",
              severityFor("error"),
              `mesh:${mesh.getName()}`,
              `非流形边 ${analysis.nonManifoldEdges} 条（>2 个面共边）`,
            ),
          );
        }
        if (analysis.degenerateTriangles > 0) {
          violations.push(
            violation(
              "degenerate-triangle",
              severityFor("error"),
              `mesh:${mesh.getName()}`,
              `退化三角 ${analysis.degenerateTriangles} 个`,
            ),
          );
        }
        if (analysis.looseVertices > 0) {
          violations.push(
            violation(
              "loose-vertex",
              "warning",
              `mesh:${mesh.getName()}`,
              `悬空顶点 ${analysis.looseVertices} 个`,
            ),
          );
        }
        if (analysis.boundaryEdges > 0) {
          violations.push(
            violation(
              "boundary-edge",
              "warning",
              `mesh:${mesh.getName()}`,
              `边界边 ${analysis.boundaryEdges} 条（开放网格；角色资产通常应为闭合）`,
            ),
          );
        }
      }
    }

    const limit = external
      ? EXTERNAL_LIMITS.perMeshTriangles
      : triangleLimitFor(mesh.getName());
    if (meshTriangles > limit) {
      violations.push(
        violation(
          "triangle-budget",
          "error",
          `mesh:${mesh.getName()}`,
          `三角数 ${Math.round(meshTriangles)} 超过 ${categoryOf(mesh.getName())} 上限 ${limit}`,
        ),
      );
    }
  }

  if (external) {
    const totalTriangles = topology.reduce((sum, item) => sum + item.triangleCount, 0);
    if (totalTriangles > EXTERNAL_LIMITS.totalTriangles) {
      violations.push(
        violation(
          "triangle-budget",
          "error",
          "document",
          `外部资产总三角数 ${Math.round(totalTriangles)} 超过上限 ${EXTERNAL_LIMITS.totalTriangles}`,
        ),
      );
    }
  }

  for (const skin of root.listSkins()) {
    const jointCount = skin.listJoints().length;
    const inverseBind = skin.getInverseBindMatrices();
    if (jointCount === 0) {
      violations.push(
        violation("skin", "error", `skin:${skin.getName()}`, "蒙皮没有关节"),
      );
    }
    if (inverseBind && inverseBind.getCount() !== jointCount) {
      violations.push(
        violation(
          "skin",
          "error",
          `skin:${skin.getName()}`,
          `逆绑定矩阵 ${inverseBind.getCount()} 与关节数 ${jointCount} 不一致`,
        ),
      );
    }
  }

  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      if (!channel.getTargetNode()) {
        violations.push(
          violation(
            "animation",
            "error",
            `animation:${animation.getName()}`,
            "动画通道缺少目标节点",
          ),
        );
      }
    }
  }

  const errors = violations.filter((item) => item.severity === "error");
  const warnings = violations.filter((item) => item.severity === "warning");

  return {
    file: fileName,
    status: errors.length === 0 ? "passed" : "failed",
    stats: {
      triangles: topology.reduce((sum, item) => sum + item.triangleCount, 0),
      vertices: topology.reduce((sum, item) => sum + item.vertexCount, 0),
      meshes: root.listMeshes().length,
      materials: root.listMaterials().length,
      textures: root.listTextures().length,
      animations: root.listAnimations().length,
      skins: root.listSkins().length,
    },
    topology,
    violations,
    errorCount: errors.length,
    warningCount: warnings.length,
  };
}

export async function lintAssets(paths) {
  const dracoDecoder = await draco3d.createDecoderModule();
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([
      KHRDracoMeshCompression,
      KHRMeshQuantization,
      EXTMeshoptCompression,
      KHRTextureBasisu,
    ])
    .registerDependencies({
      "draco3d.decoder": dracoDecoder,
      "meshopt.decoder": MeshoptDecoder,
    });

  const files = [];
  for (const path of paths) {
    const document = await io.read(path);
    const baseName = basename(path);
    files.push(
      lintDocument(document, path, { external: EXTERNAL_ASSETS.has(baseName) }),
    );
  }

  return {
    schemaVersion: 1,
    generatedAt: reportTimestamp(paths[0]),
    files,
    summary: {
      files: files.length,
      passed: files.filter((file) => file.status === "passed").length,
      failed: files.filter((file) => file.status === "failed").length,
      errors: files.reduce((sum, file) => sum + file.errorCount, 0),
      warnings: files.reduce((sum, file) => sum + file.warningCount, 0),
    },
  };
}

const TEXTURE_FILE_PATTERN =
  /^(environment|prop|texture)_[a-z0-9_]+\.png$/;
const MAX_TEXTURE_FILE_BYTES = 2.5 * 1024 * 1024;

/** 读取 PNG IHDR（不依赖图像解码库）。非 PNG 返回 null。 */
export function parsePngHeader(buffer) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buffer.length < 26) {
    return null;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) {
      return null;
    }
  }
  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

/**
 * 环境贴图 lint：命名规范、尺寸上限、平铺贴图必须正方形/2 的幂、
 * billboard 贴图必须带 alpha 通道（RGBA）。
 */
export async function lintTextures(paths) {
  const files = [];
  for (const path of paths) {
    const violations = [];
    const buffer = await readFile(path);
    const fileName = basename(path);
    const header = parsePngHeader(buffer);
    if (!header) {
      violations.push(violation("format", "error", fileName, "不是可解析的 PNG"));
    } else {
      if (!TEXTURE_FILE_PATTERN.test(fileName)) {
        violations.push(
          violation(
            "naming",
            "error",
            fileName,
            "贴图文件名必须为 environment_/prop_/texture_ 前缀 + 小写蛇形",
          ),
        );
      }
      if (header.width > MAX_TEXTURE_SIZE || header.height > MAX_TEXTURE_SIZE) {
        violations.push(
          violation(
            "texture-size",
            "error",
            fileName,
            `尺寸 ${header.width}×${header.height} 超过上限 ${MAX_TEXTURE_SIZE}`,
          ),
        );
      }
      const isTile = /^environment_.*_tile\.png$/.test(fileName);
      if (isTile) {
        if (header.width !== header.height) {
          violations.push(
            violation("tile-square", "error", fileName, "平铺地面贴图必须正方形"),
          );
        }
        const isPowerOfTwo = (value) => (value & (value - 1)) === 0;
        if (!isPowerOfTwo(header.width) || !isPowerOfTwo(header.height)) {
          violations.push(
            violation(
              "tile-power-of-two",
              "warning",
              fileName,
              "平铺贴图建议为 2 的幂，避免 mipmap/寻址问题",
            ),
          );
        }
      }
      if (fileName.startsWith("prop_") && header.colorType !== 6) {
        violations.push(
          violation(
            "alpha-channel",
            "error",
            fileName,
            "立面 billboard 贴图必须是 RGBA（运行时按白底抠图生成 alpha）",
          ),
        );
      }
      if (buffer.length > MAX_TEXTURE_FILE_BYTES) {
        violations.push(
          violation(
            "file-size",
            "warning",
            fileName,
            `文件 ${(buffer.length / 1024 / 1024).toFixed(2)}MB 超过 2.5MB，建议后续转 WebP/KTX2`,
          ),
        );
      }
    }

    const errors = violations.filter((item) => item.severity === "error");
    const warnings = violations.filter((item) => item.severity === "warning");
    files.push({
      file: path,
      status: errors.length === 0 ? "passed" : "failed",
      stats: header
        ? {
            width: header.width,
            height: header.height,
            bitDepth: header.bitDepth,
            colorType: header.colorType,
            bytes: buffer.length,
          }
        : { bytes: buffer.length },
      violations,
      errorCount: errors.length,
      warningCount: warnings.length,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: reportTimestamp(paths[0]),
    files,
    summary: {
      files: files.length,
      passed: files.filter((file) => file.status === "passed").length,
      failed: files.filter((file) => file.status === "failed").length,
      errors: files.reduce((sum, file) => sum + file.errorCount, 0),
      warnings: files.reduce((sum, file) => sum + file.warningCount, 0),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const explicit = args.map((path) => resolve(path));
  const glbPaths = explicit.length
    ? explicit.filter((path) => path.endsWith(".glb"))
    : (await readdir(ASSETS_DIR))
        .filter((name) => name.endsWith(".glb"))
        .sort()
        .map((name) => join(ASSETS_DIR, name));
  const texturePaths = explicit.length
    ? explicit.filter((path) => path.endsWith(".png"))
    : (await readdir(TEXTURES_DIR))
        .filter((name) => name.endsWith(".png"))
        .sort()
        .map((name) => join(TEXTURES_DIR, name));

  if (glbPaths.length === 0 && texturePaths.length === 0) {
    throw new Error("没有可 lint 的 .glb / .png 文件");
  }

  const report = {
    ...(glbPaths.length > 0
      ? await lintAssets(glbPaths)
      : {
          schemaVersion: 1,
          generatedAt: reportTimestamp(),
          files: [],
          summary: { files: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
        }),
    textures: texturePaths.length > 0 ? await lintTextures(texturePaths) : null,
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  for (const file of report.files) {
    const relative = file.file.replace(`${ROOT}/`, "");
    console.log(
      `[lint] ${relative}: ${file.status} · ${file.stats.triangles} tris · ` +
        `${file.errorCount} errors / ${file.warningCount} warnings`,
    );
    for (const item of file.violations) {
      console.log(`  [${item.severity}] ${item.rule} ${item.path}: ${item.message}`);
    }
  }
  console.log(
    `[lint] glb ${report.summary.passed}/${report.summary.files} passed · ` +
      `${report.summary.errors} errors · ${report.summary.warnings} warnings`,
  );
  if (report.textures) {
    for (const file of report.textures.files) {
      const relative = file.file.replace(`${ROOT}/`, "");
      const size = file.stats.width
        ? `${file.stats.width}×${file.stats.height}`
        : "?";
      console.log(
        `[lint] ${relative}: ${file.status} · ${size} · ` +
          `${file.errorCount} errors / ${file.warningCount} warnings`,
      );
      for (const item of file.violations) {
        console.log(`  [${item.severity}] ${item.rule} ${item.path}: ${item.message}`);
      }
    }
    console.log(
      `[lint] textures ${report.textures.summary.passed}/${report.textures.summary.files} passed · ` +
        `${report.textures.summary.errors} errors · ${report.textures.summary.warnings} warnings`,
    );
  }

  const totalErrors =
    report.summary.errors + (report.textures?.summary.errors ?? 0);
  if (totalErrors > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
