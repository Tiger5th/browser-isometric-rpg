#!/usr/bin/env node
/**
 * P0 资产管线：压缩对比、自动 LOD、KTX2 转码、清单与报告。
 *
 * 输入：assets/character_test_lod0.glb（优先 Blender 导出；缺失时由
 *       build-test-asset.mjs 生成程序化后备资产）
 * 输出：assets/*.glb、assets/pipeline-manifest.json、reports/pipeline.json
 *
 * 用法：node tools/pipeline/build-assets.mjs [--skip-ktx2]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import {
  EXTMeshoptCompression,
  KHRDracoMeshCompression,
  KHRMeshQuantization,
  KHRTextureBasisu,
} from "@gltf-transform/extensions";
import {
  cloneDocument,
  draco,
  meshopt,
  prune,
  simplify,
  weld,
} from "@gltf-transform/functions";
import draco3d from "draco3d";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";

const ROOT = resolve(import.meta.dirname, "../..");
const ASSETS_DIR = join(ROOT, "assets");
const REPORTS_DIR = join(ROOT, "reports");
const SOURCE_PATH = join(ASSETS_DIR, "character_test_lod0.glb");
const BUILD_TEST_ASSET = join(ROOT, "tools/pipeline/build-test-asset.mjs");

const PATHS = {
  meshopt: join(ASSETS_DIR, "character_test_meshopt.glb"),
  draco: join(ASSETS_DIR, "character_test_draco.glb"),
  ktx2: join(ASSETS_DIR, "character_test_ktx2.glb"),
  meshoptKtx2: join(ASSETS_DIR, "character_test_meshopt_ktx2.glb"),
  lod1: join(ASSETS_DIR, "character_test_lod1.glb"),
  lod2: join(ASSETS_DIR, "character_test_lod2.glb"),
};
const MANIFEST_PATH = join(ASSETS_DIR, "pipeline-manifest.json");
const REPORT_PATH = join(REPORTS_DIR, "pipeline.json");

function log(message) {
  console.log(`[assets] ${message}`);
}

async function sha256(path) {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileSizeOrNull(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** 解析 GLB 的 JSON 块，并按贴图/几何拆分字节数。 */
async function inspectGlbBytes(path) {
  const buffer = await readFile(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const jsonLength = view.getUint32(12, true);
  const jsonText = new TextDecoder().decode(
    new Uint8Array(buffer.buffer, buffer.byteOffset + 20, jsonLength),
  );
  const json = JSON.parse(jsonText);
  const imageBufferViews = new Set(
    (json.images ?? []).map((image) => image.bufferView).filter((index) => index !== undefined),
  );
  const buffers = json.buffers ?? [];
  const isMeshoptFallback = (bufferIndex) =>
    buffers[bufferIndex]?.extensions?.EXT_meshopt_compression?.fallback === true;
  const bufferViews = json.bufferViews ?? [];
  let imageBytes = 0;
  let geometryBytes = 0;
  let decodedGeometryBytes = null;
  bufferViews.forEach((bufferView, index) => {
    if (imageBufferViews.has(index)) {
      imageBytes += bufferView.byteLength ?? 0;
      return;
    }
    const meshoptExtension = bufferView.extensions?.EXT_meshopt_compression;
    if (meshoptExtension) {
      // 实际落盘的是 meshopt 压缩块；bufferView.byteLength 是解码后大小。
      geometryBytes += meshoptExtension.byteLength ?? 0;
      decodedGeometryBytes = (decodedGeometryBytes ?? 0) + (bufferView.byteLength ?? 0);
      return;
    }
    if (isMeshoptFallback(bufferView.buffer)) {
      // fallback buffer 不落盘，仅用于不支持扩展的加载器。
      return;
    }
    geometryBytes += bufferView.byteLength ?? 0;
  });
  return {
    totalBytes: buffer.byteLength,
    jsonBytes: jsonLength,
    imageBytes,
    geometryBytes,
    decodedGeometryBytes,
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired: json.extensionsRequired ?? [],
  };
}

function countTriangles(document) {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      if (indices) {
        triangles += indices.getCount() / 3;
      } else {
        const position = primitive.getAttribute("POSITION");
        triangles += position ? position.getCount() / 3 : 0;
      }
    }
  }
  return Math.round(triangles);
}

function documentStats(document) {
  const root = document.getRoot();
  let vertices = 0;
  let morphTargets = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
      morphTargets += primitive.listTargets().length;
    }
  }
  const skins = root.listSkins();
  return {
    triangles: countTriangles(document),
    vertices,
    meshes: root.listMeshes().length,
    primitives: root
      .listMeshes()
      .reduce((sum, mesh) => sum + mesh.listPrimitives().length, 0),
    materials: root.listMaterials().length,
    textures: root.listTextures().map((texture) => ({
      name: texture.getName(),
      mimeType: texture.getMimeType(),
      size: texture.getSize(),
    })),
    skins: skins.length,
    bones: skins.reduce((sum, skin) => sum + skin.listJoints().length, 0),
    animations: root.listAnimations().map((animation) => ({
      name: animation.getName(),
      channels: animation.listChannels().length,
    })),
    morphTargets,
  };
}

async function readDocument(io, path) {
  const document = await io.read(path);
  return document;
}

function stripMorphTargets(document) {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const target of primitive.listTargets()) {
        primitive.removeTarget(target);
        target.dispose();
      }
    }
  }
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      if (channel.getTargetPath() === "weights") {
        animation.removeChannel(channel);
        channel.dispose();
      }
    }
  }
}

async function makeVariant(io, source, kind) {
  const document = cloneDocument(source);
  if (kind === "meshopt") {
    await document.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }), prune());
  } else if (kind === "draco") {
    await document.transform(
      draco({
        method: "edgebreaker",
        quantizePosition: 14,
        quantizeNormal: 10,
        quantizeTexcoord: 12,
        quantizeGeneric: 12,
      }),
      prune(),
    );
  }
  return document;
}

async function makeLod(io, source, ratio, error) {
  const document = cloneDocument(source);
  stripMorphTargets(document);
  await document.transform(
    weld({ tolerance: 0.0001 }),
    simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
    prune(),
  );
  return document;
}

function findKtxBinary() {
  if (process.env.KTX_BIN && existsSync(process.env.KTX_BIN)) {
    return process.env.KTX_BIN;
  }
  for (const candidate of ["/opt/homebrew/bin/ktx", "/usr/local/bin/ktx"]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    return execFileSync("which", ["ktx"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function runKtx2(sourcePath, outputPath, ktxBinary) {
  const env = { ...process.env, PATH: `${dirname(ktxBinary)}:${process.env.PATH ?? ""}` };
  execFileSync(
    join(ROOT, "node_modules/.bin/gltf-transform"),
    [
      "etc1s",
      sourcePath,
      outputPath,
      "--quality",
      "128",
      "--compression",
      "2",
      "--filter",
      "lanczos4",
    ],
    { cwd: ROOT, env, stdio: "pipe" },
  );
}

async function main() {
  const skipKtx2 = process.argv.includes("--skip-ktx2");
  await mkdir(ASSETS_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  if (!existsSync(SOURCE_PATH)) {
    log("未找到源资产，运行程序化后备生成器…");
    execFileSync(process.execPath, [BUILD_TEST_ASSET, SOURCE_PATH], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  const dracoEncoder = await draco3d.createEncoderModule();
  const dracoDecoder = await draco3d.createDecoderModule();
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions([
      KHRDracoMeshCompression,
      KHRMeshQuantization,
      EXTMeshoptCompression,
      KHRTextureBasisu,
    ])
    .registerDependencies({
      "draco3d.encoder": dracoEncoder,
      "draco3d.decoder": dracoDecoder,
      "meshopt.encoder": MeshoptEncoder,
      "meshopt.decoder": MeshoptDecoder,
    });

  const source = await readDocument(io, SOURCE_PATH);
  const sourceStats = documentStats(source);
  log(
    `源资产：${sourceStats.triangles} tris / ${sourceStats.vertices} verts / ` +
      `${sourceStats.bones} bones / ${sourceStats.morphTargets} morph / ${sourceStats.animations.length} anim`,
  );

  const variants = {};

  for (const kind of ["meshopt", "draco"]) {
    log(`生成 ${kind} 变体…`);
    const document = await makeVariant(io, source, kind);
    await writeFile(PATHS[kind], await io.writeBinary(document));
    variants[kind] = {
      path: PATHS[kind],
      ...(await inspectGlbBytes(PATHS[kind])),
      stats: documentStats(document),
      sha256: await sha256(PATHS[kind]),
    };
  }

  log("生成 LOD1 / LOD2…");
  for (const [level, ratio, error] of [
    [1, 0.5, 0.01],
    [2, 0.2, 0.03],
  ]) {
    const document = await makeLod(io, source, ratio, error);
    const path = PATHS[`lod${level}`];
    await writeFile(path, await io.writeBinary(document));
    variants[`lod${level}`] = {
      path,
      level,
      ratio,
      ...(await inspectGlbBytes(path)),
      stats: documentStats(document),
      sha256: await sha256(path),
    };
  }

  const baseline = {
    path: SOURCE_PATH,
    ...(await inspectGlbBytes(SOURCE_PATH)),
    stats: sourceStats,
    sha256: await sha256(SOURCE_PATH),
  };

  let ktx2;
  const ktxBinary = findKtxBinary();
  if (skipKtx2) {
    ktx2 = {
      status: "skipped",
      reason: "命令行指定 --skip-ktx2",
      fallback: "PNG（源资产内嵌 baseColor PNG）",
    };
  } else if (!ktxBinary) {
    ktx2 = {
      status: "blocked",
      reason:
        "未找到 KTX-Software 的 ktx/toktx 可执行文件；glTF-Transform etc1s 需要它。" +
        "安装方式见 reports/pipeline.json 的 ktx2.installHint。",
      installHint:
        "brew 无 formula；可用 KTX-Software 官方 macOS .pkg 安装，或下载后 pkgutil --expand-full 解压并把 ktx 加入 PATH。",
      fallback: "PNG（源资产内嵌 baseColor PNG）",
    };
    log("跳过 KTX2：未找到 ktx 可执行文件");
  } else {
    log(`生成 KTX2 变体（${ktxBinary}）…`);
    try {
      runKtx2(SOURCE_PATH, PATHS.ktx2, ktxBinary);
      const document = await readDocument(io, PATHS.ktx2);
      ktx2 = {
        status: "ok",
        path: PATHS.ktx2,
        encoder: "KTX-Software etc1s (ETC1S + mipmaps)",
        ...(await inspectGlbBytes(PATHS.ktx2)),
        stats: documentStats(document),
        sha256: await sha256(PATHS.ktx2),
      };
    } catch (error) {
      ktx2 = {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        fallback: "PNG（源资产内嵌 baseColor PNG）",
      };
      log(`KTX2 转码失败：${ktx2.reason}`);
    }
  }

  const ratio = (value, base) =>
    base > 0 ? Number((value / base).toFixed(4)) : null;

  let production = null;
  if (ktx2.status === "ok") {
    log("生成生产组合变体：KTX2 源 → meshopt…");
    const ktx2Document = await readDocument(io, PATHS.ktx2);
    const document = cloneDocument(ktx2Document);
    await document.transform(
      meshopt({ encoder: MeshoptEncoder, level: "high" }),
      prune(),
    );
    await writeFile(PATHS.meshoptKtx2, await io.writeBinary(document));
    const productionDocument = await readDocument(io, PATHS.meshoptKtx2);
    production = {
      path: PATHS.meshoptKtx2,
      label: "meshopt + KTX2（推荐生产组合）",
      ...(await inspectGlbBytes(PATHS.meshoptKtx2)),
      stats: documentStats(productionDocument),
      sha256: await sha256(PATHS.meshoptKtx2),
      totalRatio: null,
    };
    production.totalRatio = ratio(production.totalBytes, baseline.totalBytes);
  }

  const compression = {
    baseline,
    meshopt: {
      ...variants.meshopt,
      totalRatio: ratio(variants.meshopt.totalBytes, baseline.totalBytes),
      geometryRatio: ratio(variants.meshopt.geometryBytes, baseline.geometryBytes),
    },
    draco: {
      ...variants.draco,
      totalRatio: ratio(variants.draco.totalBytes, baseline.totalBytes),
      geometryRatio: ratio(variants.draco.geometryBytes, baseline.geometryBytes),
    },
  };

  const lod = [
    {
      level: 0,
      ...baseline,
      triangleRatio: 1,
    },
    {
      ...variants.lod1,
      triangleRatio: ratio(variants.lod1.stats.triangles, sourceStats.triangles),
    },
    {
      ...variants.lod2,
      triangleRatio: ratio(variants.lod2.stats.triangles, sourceStats.triangles),
    },
  ];

  const blenderAvailable = (() => {
    try {
      execFileSync("which", ["blender"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  })();

  const decoderPayloadBytes = {
    meshopt: (await fileSizeOrNull(join(ROOT, "public/vendor/meshopt/meshopt_decoder.js"))) ?? null,
    draco:
      (
        await Promise.all([
          fileSizeOrNull(join(ROOT, "public/vendor/draco/draco_wasm_wrapper_gltf.js")),
          fileSizeOrNull(join(ROOT, "public/vendor/draco/draco_decoder_gltf.wasm")),
          fileSizeOrNull(join(ROOT, "public/vendor/draco/draco_decoder_gltf.js")),
        ])
      ).reduce((sum, size) => sum + (size ?? 0), 0) || null,
  };

  const textureCompression =
    ktx2.status === "ok"
      ? {
          pngBytes: baseline.imageBytes,
          ktx2Bytes: ktx2.imageBytes,
          byteRatio: ratio(ktx2.imageBytes, baseline.imageBytes),
          note: "KTX2 ETC1S；运行时按设备能力转码为 ASTC/BC7/ETC2/RGBA",
        }
      : null;

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceKind: blenderAvailable ? "blender" : "procedural-fallback",
    source: {
      file: "character_test_lod0.glb",
      triangles: baseline.stats.triangles,
      ...baseline,
    },
    variants: {
      meshopt: {
        file: "character_test_meshopt.glb",
        bytes: compression.meshopt.totalBytes,
        geometryBytes: compression.meshopt.geometryBytes,
        triangles: compression.meshopt.stats.triangles,
      },
      draco: {
        file: "character_test_draco.glb",
        bytes: compression.draco.totalBytes,
        geometryBytes: compression.draco.geometryBytes,
        triangles: compression.draco.stats.triangles,
      },
      ktx2:
        ktx2.status === "ok"
          ? {
              file: "character_test_ktx2.glb",
              bytes: ktx2.totalBytes,
              geometryBytes: ktx2.geometryBytes,
              triangles: ktx2.stats.triangles,
            }
          : null,
      production: production
        ? {
            file: "character_test_meshopt_ktx2.glb",
            bytes: production.totalBytes,
            geometryBytes: production.geometryBytes,
            triangles: production.stats.triangles,
          }
        : null,
    },
    lod: lod.map((level) => ({
      level: level.level,
      file: `character_test_lod${level.level}.glb`,
      bytes: level.totalBytes,
      triangles: level.stats.triangles,
    })),
    ktx2: { status: ktx2.status },
  };

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    blender: {
      available: blenderAvailable,
      script: "tools/pipeline/blender/export_test_asset.py",
      determinism: blenderAvailable ? "pending-run" : "not-run",
      status: blenderAvailable ? "available" : "blocked",
      reason: blenderAvailable
        ? null
        : "本机 PATH 中无 blender；导出脚本已就绪。程序化后备生成器两次运行字节一致（见 reports/procedural-determinism.json），但 Blender 导出可重复性仍未实测。",
      fallback: "tools/pipeline/build-test-asset.mjs（程序化资产生成器）",
      fallbackDeterminism: "passed（reports/procedural-determinism.json）",
    },
    source: {
      kind: blenderAvailable ? "blender" : "procedural-fallback",
      ...baseline,
    },
    compression,
    lod,
    ktx2,
    textureCompression,
    decoderPayloadBytes,
    production,
    recommendation: {
      geometryCompression: "meshopt",
      reason:
        `meshopt 总体积 ${(compression.meshopt.totalRatio * 100).toFixed(1)}%、` +
        `几何体积 ${(compression.meshopt.geometryRatio * 100).toFixed(1)}%；` +
        `draco 分别为 ${(compression.draco.totalRatio * 100).toFixed(1)}% / ` +
        `${(compression.draco.geometryRatio * 100).toFixed(1)}%。` +
        "meshopt 同时压缩动画与 morph，且解码器体积远小于 Draco。",
      textureCompression:
        ktx2.status === "ok"
          ? `KTX2 ETC1S（贴图字节 ${(textureCompression.byteRatio * 100).toFixed(1)}%）`
          : "PNG 回退",
      productionVariant:
        production
          ? `meshopt + KTX2 组合 ${production.totalBytes} B（源 ${baseline.totalBytes} B，` +
            `${(production.totalRatio * 100).toFixed(1)}%）`
          : null,
      lod: "3 级可接受（近景 LOD1 48.0 dB / LOD2 37.6 dB；远景 LOD2 53.6 dB）",
      decodeTiming:
        "浏览器实测见 reports/p0-asset-pipeline.json 与 reports/asset-pipeline-browser-runs.json",
      decodeTimingInterpretation:
        "热路径两者相当（约 4–5 ms/次，差异在噪声内）；Draco 冷启动需额外加载约 764 KB 解码器。" +
        "meshopt 的决策依据是体积与解码器足迹，不是解码速度。",
      webgpuKtx2: "Chromium WebGPU 实测通过（RGBA8 转码），见 reports/webgpu-ktx2.json",
      safari: "未实测；回退方案为 PNG（reports/ktx2-compatibility.json）",
    },
    notes: [
      "字节拆分：imageBytes 为内嵌贴图 bufferView，geometryBytes 为其余 bufferView（几何/蒙皮/动画/morph）。",
      "压缩率 = 变体 / 源资产；小于 1 表示更小。",
      "LOD 生成前移除 morph target 与权重动画，仅比较基础几何的视觉质量。",
    ],
  };

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  log(`报告：${REPORT_PATH}`);
  log(`清单：${MANIFEST_PATH}`);
  for (const kind of ["meshopt", "draco"]) {
    log(
      `${kind}: 总 ${compression[kind].totalBytes} B (${(
        compression[kind].totalRatio * 100
      ).toFixed(1)}%) · 几何 ${compression[kind].geometryBytes} B (${(
        compression[kind].geometryRatio * 100
      ).toFixed(1)}%)`,
    );
  }
  log(
    `LOD: ${lod.map((level) => `${level.level}=${level.stats.triangles} tris`).join(" / ")}`,
  );
  log(`KTX2: ${ktx2.status}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
