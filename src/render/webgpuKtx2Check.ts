import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

import { configureRuntimeDecoders } from "./decoders";

export interface WebGpuKtx2Result {
  ok: boolean;
  backend: "webgpu";
  loadMs: number;
  textureCount: number;
  texturesReady: boolean;
  textureFormat: number | null;
  caps: {
    astc: boolean;
    bc: boolean;
    etc2: boolean;
  } | null;
  adapterInfo: Record<string, string> | null;
  error?: string;
}

/**
 * 独立验证：WebGPU 引擎加载 KTX2 资产并等待纹理就绪。
 * 由 ego-browser 通过动态 import 调用，不进入 Harness 场景注册表。
 */
export async function runWebGpuKtx2Check(
  assetUrl = "/assets/character_test_ktx2.glb",
): Promise<WebGpuKtx2Result> {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  canvas.style.cssText =
    "position:fixed;left:-2000px;top:0;width:512px;height:512px;pointer-events:none";
  document.body.append(canvas);

  const result: WebGpuKtx2Result = {
    ok: false,
    backend: "webgpu",
    loadMs: 0,
    textureCount: 0,
    texturesReady: false,
    textureFormat: null,
    caps: null,
    adapterInfo: null,
  };

  let engine: WebGPUEngine | null = null;
  let scene: Scene | null = null;
  try {
    configureRuntimeDecoders();

    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      const info = adapter?.info as Record<string, string> | undefined;
      if (info) {
        result.adapterInfo = {
          vendor: info.vendor ?? "",
          architecture: info.architecture ?? "",
          device: info.device ?? "",
          description: info.description ?? "",
        };
      }
    }

    engine = new WebGPUEngine(canvas, { antialias: false });
    await engine.initAsync();
    scene = new Scene(engine);
    scene.clearColor.set(0.05, 0.06, 0.08, 1);

    const camera = new FreeCamera("camera.check", new Vector3(0, 1.4, -5), scene);
    camera.setTarget(new Vector3(0, 1.4, 0));
    new HemisphericLight("light.check", new Vector3(0, 1, 0), scene);

    const response = await fetch(assetUrl);
    if (!response.ok) {
      throw new Error(`加载失败：HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const file = new File([bytes], "character_test_ktx2.glb", {
      type: "model/gltf-binary",
    });

    const startedAt = performance.now();
    const container = await SceneLoader.LoadAssetContainerAsync("", file, scene);
    container.addAllToScene();
    engine.runRenderLoop(() => scene?.render());
    await scene.whenReadyAsync();
    scene.render();
    result.loadMs = performance.now() - startedAt;

    const textures = container.materials.flatMap((material) =>
      material.getActiveTextures(),
    );
    result.textureCount = textures.length;
    result.texturesReady =
      textures.length > 0 && textures.every((texture) => texture.isReady());
    const internal = textures[0]?.getInternalTexture();
    result.textureFormat = internal?.format ?? null;

    const caps = engine.getCaps();
    result.caps = {
      astc: Boolean(caps.astc),
      bc: Boolean(caps.s3tc),
      etc2: Boolean(caps.etc2),
    };
    result.ok = result.texturesReady;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    engine?.stopRenderLoop();
    scene?.dispose();
    engine?.dispose();
    canvas.remove();
  }

  return result;
}
