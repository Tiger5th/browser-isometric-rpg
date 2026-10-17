#!/usr/bin/env node
/**
 * VRM → 标准 glTF(GLB) 转换工具（Blender 不可用时的降级路径）。
 *
 * VRM 0.x / 1.0 都是 glTF 2.0 的扩展：.vrm 文件本身就是 GLB 容器。
 * 本工具直接操作 GLB 的 JSON 块，剥离 VRM 专有扩展（VRM / VRMC_vrm /
 * VRMC_springBone / VRMC_materials_mtoon / VRMC_node_constraint 等），
 * 保留标准 glTF 的网格、骨骼、蒙皮、动画与贴图，输出 Babylon 标准
 * glTF loader 可直接加载的 .glb。
 *
 * 为什么不用 @gltf-transform：VRM 扩展在 extensionsRequired 中时，
 * 通用读写器会因未知扩展报错/警告；在 GLB 块级别剥离最稳。
 *
 * 用法：
 *   node tools/pipeline/vrm-to-glb.mjs <input.vrm> [output.glb]
 *   node tools/pipeline/vrm-to-glb.mjs --self-test <source.glb>
 *
 * 真实 VRoid 导出后建议：
 *   node tools/pipeline/vrm-to-glb.mjs ~/Downloads/character.vrm \
 *     assets/character_vroid_lod0.glb
 * 场景 anime-pipeline 会自动优先加载 character_vroid_lod0.glb。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const VRM_EXTENSION_PATTERN = /^(VRM$|VRMC_)/;

function fail(message) {
  throw new Error(message);
}

/** 解析 GLB 容器；返回 JSON 与 BIN 块（可选）。 */
export function parseGlb(buffer) {
  if (buffer.byteLength < 12) {
    fail("文件过小，不是 GLB 容器");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    fail("不是 GLB 容器（magic 不匹配）；VRM 0.x/1.0 应为 GLB 容器");
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    fail(`不支持的 GLB 版本：${version}`);
  }
  const totalLength = view.getUint32(8, true);
  if (totalLength > buffer.byteLength) {
    fail(`GLB 头部长度 ${totalLength} 超过实际字节数 ${buffer.byteLength}`);
  }

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, chunkLength);
    offset += chunkLength;
    if (chunkType === CHUNK_JSON && json === null) {
      const text = new TextDecoder().decode(chunk).replace(/\u0000+$/g, "").trim();
      json = JSON.parse(text);
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = chunk.slice();
    }
  }
  if (!json) {
    fail("GLB 缺少 JSON 块");
  }
  return { json, bin };
}

/** 写出 GLB 容器；chunk 按 4 字节对齐（JSON 用空格、BIN 用 0 填充）。 */
export function writeGlb(json, bin) {
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonPadded = new Uint8Array(jsonBytes.byteLength + jsonPad);
  jsonPadded.fill(0x20);
  jsonPadded.set(jsonBytes);

  const binPad = bin ? (4 - (bin.byteLength % 4)) % 4 : 0;
  const binPadded = bin ? new Uint8Array(bin.byteLength + binPad) : null;
  if (binPadded) {
    binPadded.set(bin);
  }

  const total =
    12 + 8 + jsonPadded.byteLength + (binPadded ? 8 + binPadded.byteLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  let offset = 12;
  view.setUint32(offset, jsonPadded.byteLength, true);
  view.setUint32(offset + 4, CHUNK_JSON, true);
  offset += 8;
  out.set(jsonPadded, offset);
  offset += jsonPadded.byteLength;

  if (binPadded) {
    view.setUint32(offset, binPadded.byteLength, true);
    view.setUint32(offset + 4, CHUNK_BIN, true);
    offset += 8;
    out.set(binPadded, offset);
  }
  return out;
}

function stripExtensions(node, stripped) {
  if (Array.isArray(node)) {
    for (const item of node) {
      stripExtensions(item, stripped);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }

  if (node.extensions && typeof node.extensions === "object") {
    for (const key of Object.keys(node.extensions)) {
      if (VRM_EXTENSION_PATTERN.test(key)) {
        stripped.add(key);
        delete node.extensions[key];
      }
    }
    if (Object.keys(node.extensions).length === 0) {
      delete node.extensions;
    }
  }

  for (const value of Object.values(node)) {
    stripExtensions(value, stripped);
  }
}

function stripExtensionLists(json, stripped) {
  for (const listName of ["extensionsUsed", "extensionsRequired"]) {
    const list = json[listName];
    if (!Array.isArray(list)) {
      continue;
    }
    json[listName] = list.filter((name) => {
      if (VRM_EXTENSION_PATTERN.test(name)) {
        stripped.add(name);
        return false;
      }
      return true;
    });
    if (json[listName].length === 0) {
      delete json[listName];
    }
  }
}

/** 检测并剥离 VRM 扩展；返回转换结果与统计。 */
export function convertVrmToGlb(buffer, { keepUnknownVrm = false } = {}) {
  const { json, bin } = parseGlb(buffer);
  const stripped = new Set();
  const detected = new Set();
  const rootExtensions = json.extensions ?? {};
  for (const key of Object.keys(rootExtensions)) {
    if (VRM_EXTENSION_PATTERN.test(key)) {
      detected.add(key);
    }
  }
  for (const name of [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]) {
    if (VRM_EXTENSION_PATTERN.test(name)) {
      detected.add(name);
    }
  }

  const specVersion =
    rootExtensions.VRMC_vrm?.specVersion ??
    rootExtensions.VRM?.specVersion ??
    null;

  if (!keepUnknownVrm) {
    stripExtensions(json, stripped);
    stripExtensionLists(json, stripped);
  }

  const stats = {
    detected: [...detected],
    stripped: [...stripped],
    specVersion,
    nodes: json.nodes?.length ?? 0,
    meshes: json.meshes?.length ?? 0,
    primitives: (json.meshes ?? []).reduce(
      (sum, mesh) => sum + (mesh.primitives?.length ?? 0),
      0,
    ),
    skins: json.skins?.length ?? 0,
    joints: (json.skins ?? []).reduce((sum, skin) => sum + (skin.joints?.length ?? 0), 0),
    animations: json.animations?.length ?? 0,
    materials: json.materials?.length ?? 0,
    textures: json.textures?.length ?? 0,
    images: json.images?.length ?? 0,
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired: json.extensionsRequired ?? [],
  };
  return { glb: writeGlb(json, bin), stats };
}

async function convertFile(inputPath, outputPath) {
  const input = await readFile(inputPath);
  const { glb, stats } = convertVrmToGlb(input);
  await writeFile(outputPath, glb);
  console.log(`[vrm-to-glb] ${basename(inputPath)} → ${outputPath}`);
  console.log(
    `[vrm-to-glb] VRM 扩展：${stats.detected.join(", ") || "(未检测到)"}` +
      (stats.specVersion ? ` · specVersion ${stats.specVersion}` : ""),
  );
  console.log(
    `[vrm-to-glb] 剥离：${stats.stripped.join(", ") || "(无需剥离)"}`,
  );
  console.log(
    `[vrm-to-glb] 保留：${stats.nodes} nodes · ${stats.primitives} primitives · ` +
      `${stats.skins} skins (${stats.joints} joints) · ${stats.animations} animations · ` +
      `${stats.materials} materials · ${stats.textures} textures · ` +
      `${(glb.byteLength / 1024 / 1024).toFixed(2)} MiB`,
  );
  if (stats.detected.length === 0) {
    console.warn("[vrm-to-glb] 警告：输入中没有检测到 VRM 扩展，仍按普通 glTF 复制。");
  }
  return stats;
}

/** 自测：给标准 GLB 注入伪造 VRM 扩展，再转换并验证已剥离。 */
async function selfTest(sourcePath) {
  const source = await readFile(sourcePath);
  const { json, bin } = parseGlb(source);
  const fixture = structuredClone(json);
  fixture.extensionsUsed = [...(fixture.extensionsUsed ?? []), "VRM", "VRMC_springBone"];
  fixture.extensionsRequired = [...(fixture.extensionsRequired ?? []), "VRM"];
  fixture.extensions = {
    ...(fixture.extensions ?? {}),
    VRM: {
      specVersion: "0.0",
      meta: { title: "anime-pipeline fixture", version: "0.0.1" },
      materialProperties: [],
      secondaryAnimation: { boneGroups: [] },
    },
  };
  if (Array.isArray(fixture.materials) && fixture.materials.length > 0) {
    fixture.materials[0].extensions = {
      ...(fixture.materials[0].extensions ?? {}),
      VRM: { materialProperties: { shader: "VRM/MToon" } },
    };
  }
  if (Array.isArray(fixture.nodes) && fixture.nodes.length > 0) {
    fixture.nodes[0].extensions = {
      ...(fixture.nodes[0].extensions ?? {}),
      VRMC_node_constraint: { constraint: { rollAxis: "X" } },
    };
  }
  const fixtureGlb = writeGlb(fixture, bin);

  const tempDir = await mkdtemp(join(tmpdir(), "vrm-to-glb-selftest-"));
  try {
    const fixturePath = join(tempDir, "fixture.vrm");
    const outputPath = join(tempDir, "fixture.glb");
    await writeFile(fixturePath, fixtureGlb);
    const stats = await convertFile(fixturePath, outputPath);

    const roundTrip = parseGlb(await readFile(outputPath));
    const leftover = [];
    const visit = (node) => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (!node || typeof node !== "object") return;
      if (node.extensions) {
        for (const key of Object.keys(node.extensions)) {
          if (VRM_EXTENSION_PATTERN.test(key)) leftover.push(key);
        }
      }
      for (const value of Object.values(node)) visit(value);
    };
    visit(roundTrip.json);
    for (const name of [
      ...(roundTrip.json.extensionsUsed ?? []),
      ...(roundTrip.json.extensionsRequired ?? []),
    ]) {
      if (VRM_EXTENSION_PATTERN.test(name)) leftover.push(name);
    }

    const checks = {
      detectedVrm: stats.detected.includes("VRM"),
      strippedVrm: stats.stripped.includes("VRM"),
      strippedSpringBone: stats.stripped.includes("VRMC_springBone"),
      strippedNodeConstraint: stats.stripped.includes("VRMC_node_constraint"),
      noVrmLeftover: leftover.length === 0,
      meshPreserved: stats.primitives > 0,
      skinPreserved: stats.skins > 0,
      animationPreserved: stats.animations > 0,
    };
    for (const [name, passed] of Object.entries(checks)) {
      console.log(`[vrm-to-glb:self-test] ${passed ? "PASS" : "FAIL"} ${name}`);
    }
    if (Object.values(checks).some((passed) => !passed)) {
      throw new Error("VRM 自测失败");
    }
    console.log("[vrm-to-glb:self-test] 全部通过（容器级验证，非真实 VRoid 资产）");
    return checks;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    const sourcePath = args.find((arg) => arg !== "--self-test");
    if (!sourcePath) {
      fail("--self-test 需要提供一个标准 .glb 作为注入源");
    }
    await selfTest(resolve(sourcePath));
    return;
  }
  if (args.length < 1) {
    console.log(
      "用法：node tools/pipeline/vrm-to-glb.mjs <input.vrm> [output.glb]\n" +
        "      node tools/pipeline/vrm-to-glb.mjs --self-test <source.glb>",
    );
    process.exitCode = 1;
    return;
  }
  const inputPath = resolve(args[0]);
  const outputPath = resolve(
    args[1] ?? join(dirname(inputPath), `${basename(inputPath, ".vrm")}.glb`),
  );
  await convertFile(inputPath, outputPath);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
