import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

import type { Metric } from "../../logic/report";
import { updateOrthographicFrustum } from "../camera";
import { configureRuntimeDecoders } from "../decoders";
import { GREYBOX_REGION_ID } from "../greybox";
import type { ScenarioDefinition } from "../harness";

interface AssetEntry {
  file: string;
  bytes: number;
  geometryBytes?: number;
  triangles: number;
}

interface PipelineManifest {
  schemaVersion: number;
  generatedAt: string;
  sourceKind: string;
  source: AssetEntry;
  variants: {
    meshopt: AssetEntry | null;
    draco: AssetEntry | null;
    ktx2: AssetEntry | null;
    production: AssetEntry | null;
  };
  lod: Array<{ level: number; file: string; bytes: number; triangles: number }>;
  ktx2: { status: string };
}

interface LoadTiming {
  firstMs: number;
  medianMs: number;
  runs: number[];
}

interface AssetPipelineDebugApi {
  showLod(level: number, view: "near" | "far"): Promise<void>;
  getState(): Record<string, unknown>;
}

declare global {
  interface Window {
    __assetPipeline?: AssetPipelineDebugApi;
    /** 截图模式：场景 measure() 会等待该函数调用后再结束，便于外部截图。 */
    __assetPipelineRelease?: () => void;
  }
}

const ASSET_URLS = import.meta.glob("../../../assets/*.glb", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const MANIFEST_URLS = import.meta.glob("../../../assets/pipeline-manifest.json", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const MANIFEST_URL = MANIFEST_URLS["../../../assets/pipeline-manifest.json"];

const NEAR_SPAN = 2.6;
const FAR_SPAN = 9;

function urlFor(fileName: string): string {
  for (const [path, url] of Object.entries(ASSET_URLS)) {
    if (path.endsWith(`/${fileName}`)) {
      return url;
    }
  }
  throw new Error(`资产未被 Vite 打包：${fileName}`);
}

async function fetchAsset(fileName: string): Promise<{
  bytes: ArrayBuffer;
  fetchMs: number;
  file: File;
}> {
  const startedAt = performance.now();
  const response = await fetch(urlFor(fileName));
  if (!response.ok) {
    throw new Error(`加载 ${fileName} 失败：HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const fetchMs = performance.now() - startedAt;
  return {
    bytes,
    fetchMs,
    file: new File([bytes], fileName, { type: "model/gltf-binary" }),
  };
}

async function timeLoads(scene: Scene, file: File, runs = 5): Promise<LoadTiming> {
  const durations: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const container = await SceneLoader.LoadAssetContainerAsync("", file, scene);
    durations.push(performance.now() - startedAt);
    container.dispose();
  }
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    firstMs: durations[0],
    medianMs: sorted[Math.floor(sorted.length / 2)],
    runs: durations,
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function countTriangles(container: AssetContainer): number {
  return container.meshes.reduce((sum, mesh) => {
    const indices = (mesh as Mesh).getTotalIndices?.() ?? 0;
    return sum + indices / 3;
  }, 0);
}

interface PipelineState {
  metrics: Metric[];
  manifest: PipelineManifest | null;
  lodContainers: Map<number, AssetContainer>;
  activeLod: number | null;
  region: TransformNode | null;
  engineScene: Scene | null;
  ktx2Loaded: boolean;
  ktx2TextureCount: number;
}

const state: PipelineState = {
  metrics: [],
  manifest: null,
  lodContainers: new Map(),
  activeLod: null,
  region: null,
  engineScene: null,
  ktx2Loaded: false,
  ktx2TextureCount: 0,
};

let screenshotBarrier: { promise: Promise<void>; resolve: () => void } | null = null;

function createScreenshotBarrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pushMetric(metric: Metric): void {
  state.metrics.push(metric);
}

async function loadLodContainers(
  scene: Scene,
  manifest: PipelineManifest,
): Promise<void> {
  for (const level of manifest.lod) {
    const { file } = await fetchAsset(level.file);
    const container = await SceneLoader.LoadAssetContainerAsync("", file, scene);
    container.animationGroups.forEach((group) => group.stop());
    state.lodContainers.set(level.level, container);
  }
}

async function measureCompression(
  scene: Scene,
  manifest: PipelineManifest,
): Promise<void> {
  const baselineAsset = await fetchAsset(manifest.source.file);
  const meshoptAsset = manifest.variants.meshopt
    ? await fetchAsset(manifest.variants.meshopt.file)
    : null;
  const dracoAsset = manifest.variants.draco
    ? await fetchAsset(manifest.variants.draco.file)
    : null;

  pushMetric({
    name: "baselineBytes",
    value: baselineAsset.bytes.byteLength,
    unit: "bytes",
  });
  pushMetric({
    name: "baselineFetchMs",
    value: round(baselineAsset.fetchMs),
    unit: "ms",
  });

  // 预热 glTF loader，避免首次解析的插件初始化影响基线。
  (await SceneLoader.LoadAssetContainerAsync("", baselineAsset.file, scene)).dispose();

  const baseline = await timeLoads(scene, baselineAsset.file);
  pushMetric({ name: "baselineLoadFirstMs", value: round(baseline.firstMs), unit: "ms" });
  pushMetric({
    name: "baselineLoadMedianMs",
    value: round(baseline.medianMs),
    unit: "ms",
  });

  if (meshoptAsset && manifest.variants.meshopt) {
    const timing = await timeLoads(scene, meshoptAsset.file);
    const variant = manifest.variants.meshopt;
    pushMetric({ name: "meshoptBytes", value: variant.bytes, unit: "bytes" });
    pushMetric({
      name: "meshoptGeometryBytes",
      value: variant.geometryBytes ?? 0,
      unit: "bytes",
    });
    pushMetric({ name: "meshoptLoadFirstMs", value: round(timing.firstMs), unit: "ms" });
    pushMetric({
      name: "meshoptLoadMedianMs",
      value: round(timing.medianMs),
      unit: "ms",
    });
  }

  if (dracoAsset && manifest.variants.draco) {
    const timing = await timeLoads(scene, dracoAsset.file);
    const variant = manifest.variants.draco;
    pushMetric({ name: "dracoBytes", value: variant.bytes, unit: "bytes" });
    pushMetric({
      name: "dracoGeometryBytes",
      value: variant.geometryBytes ?? 0,
      unit: "bytes",
    });
    pushMetric({ name: "dracoLoadFirstMs", value: round(timing.firstMs), unit: "ms" });
    pushMetric({
      name: "dracoLoadMedianMs",
      value: round(timing.medianMs),
      unit: "ms",
    });
  }

  // 结构指标：从一次基线加载中读取骨骼 / morph / 动画数量。
  const container = await SceneLoader.LoadAssetContainerAsync("", baselineAsset.file, scene);
  const boneCount = container.skeletons.reduce(
    (sum, skeleton) => sum + skeleton.bones.length,
    0,
  );
  const morphTargetCount = container.meshes.reduce(
    (sum, mesh) => sum + ((mesh as Mesh).morphTargetManager?.numTargets ?? 0),
    0,
  );
  const skinnedMeshCount = container.meshes.filter(
    (mesh) => (mesh as Mesh).skeleton !== null,
  ).length;
  pushMetric({ name: "triangleCount", value: countTriangles(container), unit: "triangles" });
  pushMetric({ name: "meshCount", value: container.meshes.length, unit: "meshes" });
  pushMetric({ name: "boneCount", value: boneCount, unit: "bones", threshold: 7, comparison: "gte" });
  pushMetric({
    name: "morphTargetCount",
    value: morphTargetCount,
    unit: "targets",
    threshold: 1,
    comparison: "gte",
  });
  pushMetric({
    name: "skinnedMeshCount",
    value: skinnedMeshCount,
    unit: "meshes",
    threshold: 1,
    comparison: "gte",
  });
  pushMetric({
    name: "animationCount",
    value: container.animationGroups.length,
    unit: "animations",
    threshold: 1,
    comparison: "gte",
  });
  container.dispose();
}

async function measureKtx2(scene: Scene, manifest: PipelineManifest): Promise<void> {
  if (!manifest.variants.ktx2) {
    pushMetric({
      name: "ktx2Available",
      value: 0,
      unit: "boolean",
    });
    return;
  }

  const asset = await fetchAsset(manifest.variants.ktx2.file);
  const startedAt = performance.now();
  try {
    const container = await SceneLoader.LoadAssetContainerAsync("", asset.file, scene);
    container.addAllToScene();
    await scene.whenReadyAsync();
    const textures = container.materials.flatMap((material) =>
      material.getActiveTextures(),
    );
    const ready = textures.length > 0 && textures.every((texture) => texture.isReady());
    const internal = textures[0]?.getInternalTexture();
    state.ktx2Loaded = ready;
    state.ktx2TextureCount = textures.length;
    pushMetric({
      name: "ktx2LoadOk",
      value: ready ? 1 : 0,
      unit: "boolean",
      threshold: 1,
      comparison: "eq",
    });
    pushMetric({
      name: "ktx2TextureCount",
      value: textures.length,
      unit: "textures",
    });
    pushMetric({
      name: "ktx2TextureFormat",
      value: internal?.format ?? -1,
      unit: "format",
    });
    pushMetric({
      name: "ktx2LoadMs",
      value: round(performance.now() - startedAt),
      unit: "ms",
    });
    pushMetric({ name: "ktx2Bytes", value: manifest.variants.ktx2.bytes, unit: "bytes" });
    container.removeAllFromScene();
    container.dispose();
  } catch (error) {
    state.ktx2Loaded = false;
    pushMetric({
      name: "ktx2LoadOk",
      value: 0,
      unit: "boolean",
      threshold: 1,
      comparison: "eq",
    });
    pushMetric({
      name: "ktx2LoadMs",
      value: round(performance.now() - startedAt),
      unit: "ms",
    });
    console.error("[asset-pipeline] KTX2 加载失败", error);
  }
}

async function measureProduction(scene: Scene, manifest: PipelineManifest): Promise<void> {
  const variant = manifest.variants.production;
  if (!variant) {
    pushMetric({ name: "productionAvailable", value: 0, unit: "boolean" });
    return;
  }

  const asset = await fetchAsset(variant.file);
  const startedAt = performance.now();
  try {
    const container = await SceneLoader.LoadAssetContainerAsync("", asset.file, scene);
    container.addAllToScene();
    await scene.whenReadyAsync();
    const textures = container.materials.flatMap((material) =>
      material.getActiveTextures(),
    );
    const ready = textures.length > 0 && textures.every((texture) => texture.isReady());
    const internal = textures[0]?.getInternalTexture();
    const triangles = countTriangles(container);
    pushMetric({
      name: "productionLoadOk",
      value: ready && triangles > 0 ? 1 : 0,
      unit: "boolean",
      threshold: 1,
      comparison: "eq",
    });
    pushMetric({
      name: "productionLoadMs",
      value: round(performance.now() - startedAt),
      unit: "ms",
    });
    pushMetric({ name: "productionBytes", value: variant.bytes, unit: "bytes" });
    pushMetric({
      name: "productionTriangleCount",
      value: triangles,
      unit: "triangles",
    });
    pushMetric({
      name: "productionTextureFormat",
      value: internal?.format ?? -1,
      unit: "format",
    });
    container.removeAllFromScene();
    container.dispose();
  } catch (error) {
    pushMetric({
      name: "productionLoadOk",
      value: 0,
      unit: "boolean",
      threshold: 1,
      comparison: "eq",
    });
    console.error("[asset-pipeline] 生产组合（meshopt + KTX2）加载失败", error);
  }
}

export const assetPipelineScenario: ScenarioDefinition = {
  name: "asset-pipeline",
  description:
    "资产管线验证：meshopt vs draco 解码/体积、LOD 链、KTX2 加载、骨骼与 shape key 完整性",

  async setup(context) {
    configureRuntimeDecoders();
    state.metrics = [];
    state.lodContainers.clear();
    state.activeLod = null;
    state.ktx2Loaded = false;
    state.ktx2TextureCount = 0;
    state.engineScene = context.scene;

    if (!MANIFEST_URL) {
      throw new Error("缺少 assets/pipeline-manifest.json；先运行 npm run assets:build");
    }
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) {
      throw new Error(`加载管线清单失败：HTTP ${response.status}`);
    }
    const manifest = (await response.json()) as PipelineManifest;
    state.manifest = manifest;

    pushMetric({
      name: "sourceKindBlender",
      value: manifest.sourceKind === "blender" ? 1 : 0,
      unit: "boolean",
    });
    pushMetric({
      name: "sourceTriangles",
      value: manifest.source.triangles,
      unit: "triangles",
    });

    await measureCompression(context.scene, manifest);
    await measureKtx2(context.scene, manifest);
    await measureProduction(context.scene, manifest);

    for (const level of manifest.lod) {
      pushMetric({
        name: `lod${level.level}Triangles`,
        value: level.triangles,
        unit: "triangles",
      });
    }

    await loadLodContainers(context.scene, manifest);

    state.region =
      (context.scene.getTransformNodeByName(GREYBOX_REGION_ID) as TransformNode | null) ??
      null;

    const api: AssetPipelineDebugApi = {
      async showLod(level, view) {
        for (const container of state.lodContainers.values()) {
          container.removeAllFromScene();
        }
        const container = state.lodContainers.get(level);
        if (!container) {
          throw new Error(`LOD${level} 未加载`);
        }
        container.addAllToScene();
        container.animationGroups.forEach((group) => group.stop());
        state.activeLod = level;
        state.region?.setEnabled(false);

        const camera = context.scene.activeCamera as ArcRotateCamera | null;
        if (camera) {
          camera.setTarget(new Vector3(0, 1.15, 0));
          const engine = context.scene.getEngine();
          const aspect =
            engine.getRenderHeight() > 0
              ? engine.getRenderWidth() / engine.getRenderHeight()
              : 1;
          updateOrthographicFrustum(
            camera,
            aspect,
            view === "near" ? NEAR_SPAN : FAR_SPAN,
          );
        }

        await context.scene.whenReadyAsync();
        await nextFrame();
        await nextFrame();
      },
      getState() {
        return {
          manifest: state.manifest
            ? {
                sourceKind: state.manifest.sourceKind,
                ktx2: state.manifest.ktx2,
                variants: state.manifest.variants,
                lod: state.manifest.lod,
              }
            : null,
          activeLod: state.activeLod,
          ktx2Loaded: state.ktx2Loaded,
          ktx2TextureCount: state.ktx2TextureCount,
          lodLevels: [...state.lodContainers.keys()],
        };
      },
    };
    window.__assetPipeline = api;

    screenshotBarrier = null;
    if (new URLSearchParams(window.location.search).get("holdAssetPipeline") === "1") {
      screenshotBarrier = createScreenshotBarrier();
      window.__assetPipelineRelease = () => {
        screenshotBarrier?.resolve();
      };
    }

    // 默认展示 LOD0 近景，便于人工/截图直接看到资产。
    await api.showLod(0, "near");
  },

  async measure() {
    if (screenshotBarrier) {
      await screenshotBarrier.promise;
    }
    if (state.metrics.length === 0) {
      throw new Error("asset-pipeline 未采集到指标");
    }
    return state.metrics;
  },

  teardown() {
    for (const container of state.lodContainers.values()) {
      container.removeAllFromScene();
      container.dispose();
    }
    state.lodContainers.clear();
    state.region?.setEnabled(true);

    const camera = state.engineScene?.activeCamera as ArcRotateCamera | null;
    if (camera && state.engineScene) {
      camera.setTarget(Vector3.Zero());
      const engine = state.engineScene.getEngine();
      const aspect =
        engine.getRenderHeight() > 0
          ? engine.getRenderWidth() / engine.getRenderHeight()
          : 1;
      updateOrthographicFrustum(camera, aspect, 20);
    }

    state.activeLod = null;
    state.engineScene = null;
    screenshotBarrier = null;
    delete window.__assetPipeline;
    delete window.__assetPipelineRelease;
  },
};
