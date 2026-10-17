import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";

import type { Metric } from "../../logic/report";
import type { ScenarioDefinition } from "../harness";
import { getLoadingGate, type LoadingGate } from "../loadingGate";
import { getRegionAsset, REGION_VIEW_SPAN } from "../regions/regionAsset";
import {
  delay,
  enterRegionDemo,
  exitRegionDemo,
  FrameMonitor,
  nextFrame,
  nextRenderedFrame,
  setRegionVisible,
  type RegionDemoCameraSnapshot,
} from "../regions/regionDemo";

const MASK_IN_MS = 260;
const MASK_OUT_MS = 320;
const VISIBLE_HOLD_MS = 1500;

interface RunState {
  gate: LoadingGate;
  camera: RegionDemoCameraSnapshot | null;
  frames: FrameMonitor;
  containers: AssetContainer[];
  maskInTotalMs: number;
  maskOutTotalMs: number;
}

let state: RunState | null = null;

function metric(name: string, value: number, unit: string): Metric {
  return { name, value, unit };
}

/**
 * 加载门演示：两个已预载区域在完全黑场下互换，验证切换体验与切换耗时。
 * 每个区域露出后 hold 1.5s，便于 ego-browser 在可见窗口内截图。
 */
export const regionGateScenario: ScenarioDefinition = {
  name: "region-gate",
  description: "加载门切换演示：黑场掩蔽下 A/B 区域互换，记录掩蔽与露出耗时、帧间隔",

  async setup(context) {
    const gate = getLoadingGate();
    // 先淡入黑场并等完全覆盖，再做隐藏灰盒/拉远相机等场景变化，避免切镜穿帮。
    const maskInMs = await gate.maskIn(MASK_IN_MS);
    const camera = enterRegionDemo(context.scene, REGION_VIEW_SPAN);

    state = {
      gate,
      camera,
      frames: new FrameMonitor(context.scene),
      containers: [],
      maskInTotalMs: maskInMs,
      maskOutTotalMs: 0,
    };
  },

  async measure(context): Promise<Metric[]> {
    if (!state) {
      throw new Error("region-gate 未初始化");
    }

    const { gate, frames, containers } = state;
    const { scene } = context;
    const sceneMeshesBaseline = scene.meshes.length;
    const asset = await getRegionAsset(context.engine);

    // 两个区域都在黑场下预载，不挂场景。
    const preloadStartedAt = performance.now();
    for (const label of ["A", "B"] as const) {
      const container = await LoadAssetContainerAsync(asset.file, scene, {
        pluginExtension: ".glb",
        name: `${label}-${asset.file.name}`,
      });
      containers.push(container);
    }
    const preloadBothMs = performance.now() - preloadStartedAt;
    const preloadedOutsideScene = scene.meshes.length === sceneMeshesBaseline;

    if (containers.length !== 2 || !preloadedOutsideScene) {
      throw new Error("region-gate 预载失败");
    }

    const addStartedAt = performance.now();
    containers[0].addAllToScene();
    const addRegionAMs = performance.now() - addStartedAt;

    // 遮罩内等材质就绪并预热两帧，把 GPU 上传/首帧编译藏进黑场。
    const warmupAStartedAt = performance.now();
    await scene.whenReadyAsync();
    await nextRenderedFrame(scene);
    await nextRenderedFrame(scene);
    const maskedWarmupAMs = performance.now() - warmupAStartedAt;

    // 露出 A。
    frames.start();
    const revealAMs = await gate.maskOut(MASK_OUT_MS);
    state.maskOutTotalMs += revealAMs;
    setRegionVisible(true, "A");
    await delay(VISIBLE_HOLD_MS);
    await nextFrame();
    const framesA = frames.stop();
    setRegionVisible(false);

    // 黑场下 A → B 互换。
    const maskInSwapMs = await gate.maskIn(MASK_IN_MS);
    state.maskInTotalMs += maskInSwapMs;
    const maskedDuringSwap = gate.isMasked() ? 1 : 0;

    const swapStartedAt = performance.now();
    containers[0].removeAllFromScene();
    containers[1].addAllToScene();
    const swapMs = performance.now() - swapStartedAt;
    const swappedSceneMeshCount = scene.meshes.length;

    // 遮罩内预热 B。
    const warmupBStartedAt = performance.now();
    await scene.whenReadyAsync();
    await nextRenderedFrame(scene);
    await nextRenderedFrame(scene);
    const maskedWarmupBMs = performance.now() - warmupBStartedAt;

    // 露出 B。
    frames.start();
    const revealBMs = await gate.maskOut(MASK_OUT_MS);
    state.maskOutTotalMs += revealBMs;
    setRegionVisible(true, "B");
    await delay(VISIBLE_HOLD_MS);
    await nextFrame();
    const framesB = frames.stop();
    setRegionVisible(false);

    // 退出：黑场 → 卸载 → 释放。
    const maskInExitMs = await gate.maskIn(MASK_IN_MS);
    state.maskInTotalMs += maskInExitMs;
    const removeStartedAt = performance.now();
    containers[1].removeAllFromScene();
    for (const container of containers) {
      container.dispose();
    }
    const removeAndDisposeMs = performance.now() - removeStartedAt;
    const finalSceneMeshCount = scene.meshes.length;
    containers.length = 0;

    const finalMaskOutMs = await gate.maskOut(MASK_OUT_MS);
    state.maskOutTotalMs += finalMaskOutMs;

    return [
      metric("gateRegionCount", 2, "regions"),
      metric("gatePreloadBothMs", preloadBothMs, "ms"),
      metric("gatePreloadedOutsideScene", preloadedOutsideScene ? 1 : 0, "boolean"),
      metric("gateAddRegionAMs", addRegionAMs, "ms"),
      metric("gateMaskedWarmupAMs", maskedWarmupAMs, "ms"),
      metric("gateRevealAMs", revealAMs, "ms"),
      metric("gateSwapMs", swapMs, "ms"),
      metric("gateMaskedWarmupBMs", maskedWarmupBMs, "ms"),
      metric("gateRevealBMs", revealBMs, "ms"),
      metric("gateRemoveAndDisposeMs", removeAndDisposeMs, "ms"),
      metric("gateMaskInTotalMs", state.maskInTotalMs, "ms"),
      metric("gateMaskOutTotalMs", state.maskOutTotalMs, "ms"),
      metric("gateMaskedDuringSwap", maskedDuringSwap, "boolean"),
      metric("gateVisibleHoldMs", VISIBLE_HOLD_MS, "ms"),
      metric("gateSceneMeshesBaseline", sceneMeshesBaseline, "meshes"),
      metric("gateSceneMeshesAfterSwap", swappedSceneMeshCount, "meshes"),
      metric("gateSceneMeshesAfterExit", finalSceneMeshCount, "meshes"),
      metric("gateExitedCleanly", finalSceneMeshCount === sceneMeshesBaseline ? 1 : 0, "boolean"),
      metric("gateFrameCountA", framesA.frameCount, "frames"),
      metric("gateMaxFrameMsA", framesA.maxFrameMs, "ms"),
      metric("gateAverageFrameMsA", framesA.averageFrameMs, "ms"),
      metric("gateFrameCountB", framesB.frameCount, "frames"),
      metric("gateMaxFrameMsB", framesB.maxFrameMs, "ms"),
      metric("gateAverageFrameMsB", framesB.averageFrameMs, "ms"),
      metric("gateTotalTransitionMs", preloadBothMs + swapMs + removeAndDisposeMs, "ms"),
    ];
  },

  async teardown(context) {
    setRegionVisible(false);
    if (state) {
      state.frames.stop();
      state.gate.maskOut(0);
      for (const container of state.containers) {
        container.dispose();
      }
      exitRegionDemo(context.scene, state.camera);
      state = null;
    } else {
      exitRegionDemo(context.scene, null);
    }
  },
};
