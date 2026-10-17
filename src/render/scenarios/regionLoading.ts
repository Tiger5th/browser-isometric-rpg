import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";

import type { Metric } from "../../logic/report";
import type { ScenarioDefinition } from "../harness";
import { getLoadingGate, type LoadingGate } from "../loadingGate";
import {
  getRegionAsset,
  hasCachedRegionAsset,
  REGION_VIEW_SPAN,
  type RegionAsset,
} from "../regions/regionAsset";
import {
  delay,
  enterRegionDemo,
  exitRegionDemo,
  FrameMonitor,
  HeapSampler,
  nextFrame,
  nextRenderedFrame,
  setRegionVisible,
  toMebibytes,
  toMegabytes,
  type HeapSampleResult,
  type RegionDemoCameraSnapshot,
} from "../regions/regionDemo";

const MASK_IN_MS = 220;
const MASK_OUT_MS = 260;
const REVEAL_HOLD_MS = 700;

interface RunState {
  gate: LoadingGate;
  camera: RegionDemoCameraSnapshot | null;
  heap: HeapSampler;
  frames: FrameMonitor;
  maskInMs: number;
  /** 当前持有的区域容器；measure 异常时由 finally/teardown 兜底释放。 */
  container: AssetContainer | null;
}

/** 安全释放容器：先摘出场景再 dispose，重复调用无副作用。 */
function disposeContainer(container: AssetContainer): void {
  try {
    container.removeAllFromScene();
  } catch {
    // 容器可能尚未挂载或已卸载；释放阶段忽略移除失败。
  }
  container.dispose();
}

let state: RunState | null = null;

function metric(name: string, value: number, unit: string): Metric {
  return { name, value, unit };
}

async function timed<T>(work: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = performance.now();
  const value = await work();
  return { value, ms: performance.now() - startedAt };
}

function heapMetrics(sample: HeapSampleResult): Metric[] {
  return [
    metric("jsHeapBaselineMB", toMegabytes(sample.baselineBytes), "MB"),
    metric("jsHeapPeakMB", toMegabytes(sample.peakBytes), "MB"),
    metric("jsHeapPeakDeltaMB", toMegabytes(sample.peakDeltaBytes), "MB"),
    metric("jsHeapAfterCycleMB", toMegabytes(sample.afterBytes), "MB"),
    metric("memorySamplingEnabled", sample.available ? 1 : 0, "boolean"),
    metric("memorySampleCount", sample.sampleCount, "samples"),
  ];
}

/**
 * 50MB 中型区域加载验证：
 * 程序化导出 GLB → AssetContainer 预载（不进场景）→ addAllToScene → removeAllFromScene → dispose。
 * 进入/退出均由黑场加载门掩蔽，避免切换瞬间穿帮。
 */
export const regionLoadingScenario: ScenarioDefinition = {
  name: "region-loading",
  description:
    "50MB 程序化区域：glTF 导出 → AssetContainer 预载/挂载/卸载/释放，含加载门掩蔽与内存峰值",

  async setup(context) {
    const gate = getLoadingGate();
    const heap = new HeapSampler();
    // 先淡入黑场并等完全覆盖，再做隐藏灰盒/拉远相机等场景变化，避免切镜穿帮。
    const maskInMs = await gate.maskIn(MASK_IN_MS);
    const camera = enterRegionDemo(context.scene, REGION_VIEW_SPAN);
    heap.start();

    state = {
      gate,
      camera,
      heap,
      frames: new FrameMonitor(context.scene),
      maskInMs,
      container: null,
    };
  },

  async measure(context): Promise<Metric[]> {
    if (!state) {
      throw new Error("region-loading 未初始化");
    }

    const { gate, heap, frames } = state;
    const { scene } = context;
    let container: AssetContainer | null = null;
    let containerAttached = false;
    let containerDisposed = false;

    try {
      const cacheHit = hasCachedRegionAsset();
      const asset: RegionAsset = await getRegionAsset(context.engine);

      // 预载：AssetContainer 只解析资产，不挂到场景。
      const sceneMeshesBeforePreload = scene.meshes.length;
      const preload = await timed(() =>
        LoadAssetContainerAsync(asset.file, scene, {
          pluginExtension: ".glb",
          name: asset.file.name,
        }),
      );
      container = preload.value;
      if (state) {
        state.container = container;
      }
      const sceneMeshesAfterPreload = scene.meshes.length;
      const containerMeshCount = container.meshes.length;
      const containerMaterialCount = container.materials.length;
      const preloadedOutsideScene = sceneMeshesAfterPreload === sceneMeshesBeforePreload;

      if (sceneMeshesAfterPreload !== sceneMeshesBeforePreload) {
        throw new Error("预载阶段不应把网格加入场景");
      }

      const add = await timed(() => {
        container?.addAllToScene();
      });
      containerAttached = true;
      const sceneMeshesAfterAdd = scene.meshes.length;
      const attachedToScene = sceneMeshesAfterAdd > sceneMeshesBeforePreload;

      if (!attachedToScene) {
        throw new Error("addAllToScene 未能把区域加入场景");
      }

      const containerVertexCount = container.meshes.reduce(
        (sum, mesh) => sum + mesh.getTotalVertices(),
        0,
      );

      // 关键：仍在黑场下等材质就绪并渲染三帧，让 GPU 上传与首帧 shader 编译发生在遮罩后面。
      const warmupStartedAt = performance.now();
      await scene.whenReadyAsync();
      await nextRenderedFrame(scene);
      await nextRenderedFrame(scene);
      await nextRenderedFrame(scene);
      const maskedWarmupMs = performance.now() - warmupStartedAt;

      // 加载门淡出，露出区域；hold 窗口内外部可截图。
      frames.start();
      const maskOutMs = await gate.maskOut(MASK_OUT_MS);
      setRegionVisible(true, "region-loading");
      await delay(REVEAL_HOLD_MS);
      await nextFrame();
      const revealFrames = frames.stop();
      setRegionVisible(false);

      // 退出：先黑场掩蔽，再卸载。
      const maskInBeforeRemoveMs = await gate.maskIn(MASK_IN_MS);
      const gateMaskedDuringSwap = gate.isMasked() ? 1 : 0;

      const remove = await timed(() => {
        container?.removeAllFromScene();
      });
      containerAttached = false;
      const sceneMeshesAfterRemove = scene.meshes.length;
      const detachedFromScene = sceneMeshesAfterRemove === sceneMeshesBeforePreload;

      if (!detachedFromScene) {
        throw new Error(
          `removeAllFromScene 后网格数未恢复：${sceneMeshesAfterRemove} !== ${sceneMeshesBeforePreload}`,
        );
      }

      const dispose = await timed(() => {
        container?.dispose();
      });
      containerDisposed = true;
      if (state) {
        state.container = null;
      }
      const maskOutAfterDisposeMs = await gate.maskOut(MASK_OUT_MS);

      const heapSample = heap.stop();

      return [
        metric("regionGlbSizeBytes", asset.bytes, "bytes"),
        {
          name: "regionGlbSizeMB",
          value: toMegabytes(asset.bytes),
          unit: "MB",
          threshold: REGION_SIZE_BUDGET_MB,
          comparison: "lte",
        },
        metric("regionGlbSizeMiB", toMebibytes(asset.bytes), "MiB"),
        metric("regionExportMs", asset.stats.exportMs, "ms"),
        metric("regionAssetCached", cacheHit ? 1 : 0, "boolean"),
        metric("regionChunkCount", asset.stats.chunkCount, "chunks"),
        metric("regionChunkSubdivisions", asset.stats.chunkSubdivisions, "subdivisions"),
        metric("regionSourceMeshCount", asset.stats.sourceMeshCount, "meshes"),
        metric("regionVertexCount", asset.stats.vertexCount, "vertices"),
        metric("regionTriangleCount", asset.stats.triangleCount, "triangles"),
        metric("containerPreloadMs", preload.ms, "ms"),
        metric("containerAddToSceneMs", add.ms, "ms"),
        metric("containerRemoveFromSceneMs", remove.ms, "ms"),
        metric("containerDisposeMs", dispose.ms, "ms"),
        metric("containerMeshCount", containerMeshCount, "meshes"),
        metric("containerMaterialCount", containerMaterialCount, "materials"),
        metric("containerVertexCount", containerVertexCount, "vertices"),
        metric("maskedWarmupMs", maskedWarmupMs, "ms"),
        metric("sceneMeshesBeforePreload", sceneMeshesBeforePreload, "meshes"),
        metric("sceneMeshesAfterPreload", sceneMeshesAfterPreload, "meshes"),
        metric("sceneMeshesAfterAdd", sceneMeshesAfterAdd, "meshes"),
        metric("sceneMeshesAfterRemove", sceneMeshesAfterRemove, "meshes"),
        metric("containerPreloadedOutsideScene", preloadedOutsideScene ? 1 : 0, "boolean"),
        metric("containerAddAttachedToScene", attachedToScene ? 1 : 0, "boolean"),
        metric("containerRemoveDetachedFromScene", detachedFromScene ? 1 : 0, "boolean"),
        metric("gateMaskInMs", state.maskInMs, "ms"),
        metric("gateMaskInBeforeRemoveMs", maskInBeforeRemoveMs, "ms"),
        metric("gateMaskOutMs", maskOutMs, "ms"),
        metric("gateMaskOutAfterDisposeMs", maskOutAfterDisposeMs, "ms"),
        metric("gateMaskedDuringSwap", gateMaskedDuringSwap, "boolean"),
        metric("revealFrameCount", revealFrames.frameCount, "frames"),
        metric("revealMaxFrameMs", revealFrames.maxFrameMs, "ms"),
        metric("revealAverageFrameMs", revealFrames.averageFrameMs, "ms"),
        ...heapMetrics(heapSample),
      ];
    } finally {
      // 异常路径也必须摘出并释放 ~50MB 容器，避免污染后续场景。
      if (container && !containerDisposed) {
        if (containerAttached) {
          container.removeAllFromScene();
        }
        container.dispose();
      }
      if (state) {
        state.container = null;
      }
    }
  },

  async teardown(context) {
    setRegionVisible(false);
    if (state) {
      state.frames.stop();
      state.gate.maskOut(0);
      if (state.container) {
        disposeContainer(state.container);
        state.container = null;
      }
      exitRegionDemo(context.scene, state.camera);
      state.heap.stop();
      state = null;
    } else {
      exitRegionDemo(context.scene, null);
    }
  },
};

// region-loading 的 size 预算在场景外单独判定：50MB（十进制）。
export const REGION_SIZE_BUDGET_MB = 50;
