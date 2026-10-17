#!/usr/bin/env node
/**
 * 将 Babylon 运行时解码器本地化到 public/vendor/，避免运行时依赖 CDN。
 *
 * - meshopt：直接复制 @babylonjs/core 自带解码器
 * - Draco：Babylon CDN 的 glTF 解码器（draco3d npm 包不含浏览器 wrapper）
 * - KTX2：Babylon CDN 的 ktx2Decoder + 各 GPU 目标转码 wasm
 *
 * 用法：node tools/pipeline/vendor-decoders.mjs [--force]
 * 产物目录已 gitignore；新环境执行一次即可。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const FORCE = process.argv.includes("--force");

const DRACO_BASE = "https://cdn.babylonjs.com";
const KTX2_BASE = "https://cdn.babylonjs.com/ktx2Transcoders/1";

const DOWNLOADS = [
  {
    url: `${DRACO_BASE}/draco_wasm_wrapper_gltf.js`,
    path: "public/vendor/draco/draco_wasm_wrapper_gltf.js",
  },
  {
    url: `${DRACO_BASE}/draco_decoder_gltf.wasm`,
    path: "public/vendor/draco/draco_decoder_gltf.wasm",
  },
  {
    url: `${DRACO_BASE}/draco_decoder_gltf.js`,
    path: "public/vendor/draco/draco_decoder_gltf.js",
  },
  {
    url: `${DRACO_BASE}/babylon.ktx2Decoder.js`,
    path: "public/vendor/ktx2/babylon.ktx2Decoder.js",
  },
  ...["msc_basis_transcoder.js", "msc_basis_transcoder.wasm", "uastc_astc.wasm",
    "uastc_bc7.wasm", "uastc_r8_unorm.wasm", "uastc_rg8_unorm.wasm",
    "uastc_rgba8_srgb_v2.wasm", "uastc_rgba8_unorm_v2.wasm"].map((name) => ({
    url: `${KTX2_BASE}/${name}`,
    path: `public/vendor/ktx2/${name}`,
  })),
  {
    url: `${DRACO_BASE}/zstddec.wasm`,
    path: "public/vendor/ktx2/zstddec.wasm",
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败 ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, buffer);
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  await mkdir(join(ROOT, "public/vendor/meshopt"), { recursive: true });
  await copyFile(
    join(ROOT, "node_modules/@babylonjs/core/assets/meshopt/meshopt_decoder.js"),
    join(ROOT, "public/vendor/meshopt/meshopt_decoder.js"),
  );
  console.log("[vendor] meshopt_decoder.js（@babylonjs/core 自带）");

  const manifest = [];
  for (const item of DOWNLOADS) {
    const destination = join(ROOT, item.path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    if (!FORCE && (await exists(destination))) {
      const buffer = await readFile(destination);
      manifest.push({
        path: item.path,
        url: item.url,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        source: "cache",
      });
      continue;
    }
    const sha256 = await download(item.url, destination);
    manifest.push({ path: item.path, url: item.url, sha256, source: "download" });
    console.log(`[vendor] ${item.path}`);
  }

  await writeFile(
    join(ROOT, "public/vendor/decoders.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest }, null, 2)}\n`,
  );
  console.log(`[vendor] 完成：${manifest.length + 1} 个文件`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
