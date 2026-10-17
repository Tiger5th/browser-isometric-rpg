import "@babylonjs/core/Animations/animatable";
import { Animation } from "@babylonjs/core/Animations/animation";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import type { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

import type { Metric } from "../../logic/report";
import { createToonMaterial } from "../anime/toonMaterial";
import { updateOrthographicFrustum } from "../camera";
import { configureRuntimeDecoders } from "../decoders";
import { GREYBOX_REGION_ID } from "../greybox";
import type { ScenarioDefinition } from "../harness";

export const ANIME_PIPELINE_SCENARIO_NAME = "anime-pipeline";

const CAMERA_VERTICAL_SPAN = 3.2;
const CAMERA_ALPHA = -Math.PI / 4;
const CAMERA_TARGET_Y = 0.98;
const OUTLINE_WIDTH = 0.022;
const MAX_SCREENSHOT_HOLD_MS = 60_000;

const HIDDEN_ENTITY_NAMES = [
  "entity.crate-01",
  "entity.crate-02",
  "entity.pillar-01",
  "entity.dummy-01",
  "entity.spawn-01",
];

/** 真实 VRoid 资产（用户转换后放入 assets/）优先于程序化占位角色。 */
const VRM_ASSET_URLS = import.meta.glob("../../../assets/character_vroid_lod0.glb", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const PLACEHOLDER_ASSET_URLS = import.meta.glob(
  "../../../assets/character_anime_placeholder.glb",
  {
    eager: true,
    query: "?url",
    import: "default",
  },
) as Record<string, string>;

const VRM_URL = Object.values(VRM_ASSET_URLS)[0] ?? null;
const PLACEHOLDER_URL = Object.values(PLACEHOLDER_ASSET_URLS)[0] ?? null;

type CharacterSource = "vroid" | "placeholder";
type AnimationSource = "gltf" | "procedural-fallback" | "none";

interface MeshMaterialAssignment {
  mesh: AbstractMesh;
  /** toon 开时挂到 mesh 上的材质（多材质 mesh 为 MultiMaterial）。 */
  toon: Material;
  /** toon 关时挂到 mesh 上的扁平 Standard 材质。 */
  standard: Material;
}

interface AnimePipelineState {
  container: AssetContainer | null;
  meshes: AbstractMesh[];
  skeletons: Skeleton[];
  meshMaterials: MeshMaterialAssignment[];
  /** 本场景创建、需要自己 dispose 的材质（container 不持有它们）。 */
  ownedMaterials: Material[];
  fallbackTexture: BaseTexture | null;
  animationGroups: AnimationGroup[];
  proceduralAnimations: Animation[];
  activeAnimation: string | null;
  animationSource: AnimationSource;
  source: CharacterSource;
  toonEnabled: boolean;
  outlineEnabled: boolean;
  gradingEnabled: boolean;
  pipeline: DefaultRenderingPipeline | null;
  hiddenEntities: Array<{ mesh: AbstractMesh; isEnabled: boolean }>;
  assetBytes: number;
  scene: Scene | null;
}

const state: AnimePipelineState = {
  container: null,
  meshes: [],
  skeletons: [],
  meshMaterials: [],
  ownedMaterials: [],
  fallbackTexture: null,
  animationGroups: [],
  proceduralAnimations: [],
  activeAnimation: null,
  animationSource: "none",
  source: "placeholder",
  toonEnabled: true,
  outlineEnabled: true,
  gradingEnabled: true,
  pipeline: null,
  hiddenEntities: [],
  assetBytes: 0,
  scene: null,
};

interface AnimePipelineDebugApi {
  setToonEnabled(enabled: boolean): void;
  setOutlineEnabled(enabled: boolean): void;
  setGradingEnabled(enabled: boolean): void;
  setAnimation(name: "walk" | "run"): void;
  setCameraSpan(span: number): void;
  getState(): Record<string, unknown>;
}

declare global {
  interface Window {
    __animePipeline?: AnimePipelineDebugApi;
    /** 截图模式：measure() 等待该函数调用后再结束。 */
    __animePipelineRelease?: () => void;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function countTriangles(meshes: AbstractMesh[]): number {
  return meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0);
}

function countMorphTargets(meshes: AbstractMesh[]): number {
  return meshes.reduce(
    (sum, mesh) => sum + (mesh.morphTargetManager?.numTargets ?? 0),
    0,
  );
}

async function fetchGlb(
  url: string,
  fileName: string,
): Promise<{ bytes: ArrayBuffer; file: File }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载角色资产失败：HTTP ${response.status} (${fileName})`);
  }
  const bytes = await response.arrayBuffer();
  return {
    bytes,
    file: new File([bytes], fileName, { type: "model/gltf-binary" }),
  };
}

/** 从单个材质取 baseColor 贴图，保留每个 mesh 自己的纹理。 */
function baseTextureOf(material: Material | null): BaseTexture | null {
  if (!material) {
    return null;
  }
  if (material instanceof PBRMaterial && material.albedoTexture) {
    return material.albedoTexture;
  }
  if (material instanceof StandardMaterial && material.diffuseTexture) {
    return material.diffuseTexture;
  }
  const active = material.getActiveTextures();
  return active[0] ?? null;
}

function createWhiteFallbackTexture(scene: Scene): BaseTexture {
  const texture = new DynamicTexture(
    "texture_anime_fallback_white",
    { width: 2, height: 2 },
    scene,
    false,
  );
  const context = texture.getContext();
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 2, 2);
  texture.update();
  return texture;
}

/** 所有无贴图材质共用一张白色兜底贴图。 */
function ensureFallbackTexture(scene: Scene): BaseTexture {
  if (!state.fallbackTexture) {
    state.fallbackTexture = createWhiteFallbackTexture(scene);
  }
  return state.fallbackTexture;
}

function createMaterialPair(
  scene: Scene,
  nameSuffix: string,
  texture: BaseTexture | null,
  useVertexColors: boolean,
): { toon: ShaderMaterial; standard: StandardMaterial } {
  const toon = createToonMaterial(
    scene,
    `material_toon_${nameSuffix}`,
    texture,
    { useVertexColors },
  );
  const standard = new StandardMaterial(`material_flat_${nameSuffix}`, scene);
  standard.diffuseColor = Color3.White();
  standard.specularColor = Color3.Black();
  standard.diffuseTexture = texture;
  return { toon, standard };
}

/** 在缺少 glTF 动画时，用 Babylon 程序化骨骼动画模拟走/跑循环。 */
function installProceduralFallback(scene: Scene, skeleton: Skeleton | null): Animation[] {
  if (!skeleton) {
    return [];
  }
  const findBone = (patterns: RegExp[]): Bone | null =>
    skeleton.bones.find((bone) => patterns.some((pattern) => pattern.test(bone.name))) ??
    null;

  const targets: Array<{ bone: Bone | null; axis: Vector3; amplitude: number }> = [
    {
      bone: findBone([
        /left.*(up|upper).*leg/i,
        /l[_:].*upperleg/i,
        /upperleg.*_l$/i,
        /upleg.*_l$/i,
      ]),
      axis: new Vector3(1, 0, 0),
      amplitude: 0.55,
    },
    {
      bone: findBone([
        /right.*(up|upper).*leg/i,
        /r[_:].*upperleg/i,
        /upperleg.*_r$/i,
        /upleg.*_r$/i,
      ]),
      axis: new Vector3(1, 0, 0),
      amplitude: -0.55,
    },
    {
      bone: findBone([
        /left.*(up|upper).*arm/i,
        /l[_:].*upperarm/i,
        /upperarm.*_l$/i,
      ]),
      axis: new Vector3(1, 0, 0),
      amplitude: -0.4,
    },
    {
      bone: findBone([
        /right.*(up|upper).*arm/i,
        /r[_:].*upperarm/i,
        /upperarm.*_r$/i,
      ]),
      axis: new Vector3(1, 0, 0),
      amplitude: 0.4,
    },
  ];

  const animations: Animation[] = [];
  for (const [index, target] of targets.entries()) {
    const bone = target.bone;
    if (!bone) {
      continue;
    }
    const animation = new Animation(
      `anim_anime_fallback_${index}`,
      "rotationQuaternion",
      30,
      Animation.ANIMATIONTYPE_QUATERNION,
      Animation.ANIMATIONLOOPMODE_CYCLE,
    );
    animation.setKeys([
      {
        frame: 0,
        value: Quaternion.RotationAxis(target.axis, -target.amplitude),
      },
      {
        frame: 15,
        value: Quaternion.RotationAxis(target.axis, target.amplitude),
      },
      {
        frame: 30,
        value: Quaternion.RotationAxis(target.axis, -target.amplitude),
      },
    ]);
    bone.animations = [animation];
    animations.push(animation);
  }

  if (animations.length > 0) {
    scene.beginAnimation(skeleton, 0, 30, true);
  }
  return animations;
}

function refreshMaterials(): void {
  for (const { mesh, toon, standard } of state.meshMaterials) {
    mesh.material = state.toonEnabled ? toon : standard;
    mesh.renderOutline = state.toonEnabled && state.outlineEnabled;
  }
  if (state.pipeline) {
    state.pipeline.imageProcessingEnabled = state.gradingEnabled;
  }
}

/** 开关恢复默认值：按票 17 截图后重跑场景时不能继承上一轮的关断状态。 */
function resetSwitches(): void {
  state.toonEnabled = true;
  state.outlineEnabled = true;
  state.gradingEnabled = true;
}

function playAnimation(name: "walk" | "run"): void {
  const matches = state.animationGroups.filter((group) =>
    new RegExp(name, "i").test(group.name),
  );
  if (matches.length === 0) {
    // 程序化 fallback 只有一条循环，不区分走/跑。
    return;
  }
  for (const group of state.animationGroups) {
    group.stop();
  }
  const target = matches[0];
  target.start(true, name === "run" ? 1.1 : 1.0);
  state.activeAnimation = target.name;
}

function hideDecorativeEntities(scene: Scene): void {
  for (const name of HIDDEN_ENTITY_NAMES) {
    const mesh = scene.getMeshByName(name);
    if (!mesh) {
      continue;
    }
    state.hiddenEntities.push({ mesh, isEnabled: mesh.isEnabled() });
    mesh.setEnabled(false);
  }
}

function restoreDecorativeEntities(): void {
  for (const { mesh, isEnabled } of state.hiddenEntities) {
    mesh.setEnabled(isEnabled);
  }
  state.hiddenEntities = [];
}

function configureCamera(scene: Scene, span: number): void {
  const camera = scene.activeCamera;
  if (!(camera instanceof ArcRotateCamera)) {
    return;
  }
  camera.alpha = CAMERA_ALPHA;
  camera.setTarget(new Vector3(0, CAMERA_TARGET_Y, 0));
  const engine: AbstractEngine = scene.getEngine();
  const aspect =
    engine.getRenderHeight() > 0
      ? engine.getRenderWidth() / engine.getRenderHeight()
      : 1;
  updateOrthographicFrustum(camera, aspect, span);
}

function restoreCamera(scene: Scene): void {
  const camera = scene.activeCamera;
  if (!(camera instanceof ArcRotateCamera)) {
    return;
  }
  camera.alpha = -Math.PI / 4;
  camera.setTarget(Vector3.Zero());
  const engine = scene.getEngine();
  const aspect =
    engine.getRenderHeight() > 0
      ? engine.getRenderWidth() / engine.getRenderHeight()
      : 1;
  updateOrthographicFrustum(camera, aspect, 20);
}

function createGradingPipeline(scene: Scene): DefaultRenderingPipeline {
  const camera = scene.activeCamera;
  if (!camera) {
    throw new Error("anime-pipeline 需要 activeCamera");
  }
  const pipeline = new DefaultRenderingPipeline(
    "pipeline.anime-grading",
    true,
    scene,
    [camera],
  );
  pipeline.fxaaEnabled = true;
  pipeline.samples = 1;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.contrast = 1.18;
  pipeline.imageProcessing.exposure = 1.05;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType =
    ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 1.1;
  pipeline.imageProcessing.vignetteColor = new Color4(0.02, 0.02, 0.05, 0);

  const curves = new ColorCurves();
  curves.globalSaturation = 18;
  curves.shadowsHue = 225;
  curves.shadowsDensity = 18;
  curves.highlightsHue = 42;
  curves.highlightsDensity = 14;
  pipeline.imageProcessing.colorCurves = curves;
  pipeline.imageProcessing.colorCurvesEnabled = true;

  return pipeline;
}

interface MotionSample {
  rangeRad: number;
  fps: number;
  frames: number;
}

/** 采样一只腿骨的旋转范围与帧率，证明骨骼动画确实在推进。 */
function sampleMotion(
  scene: Scene,
  skeleton: Skeleton | null,
  durationMs = 450,
): Promise<MotionSample> {
  const bone =
    skeleton?.bones.find((candidate) =>
      /upperleg|upleg|thigh/i.test(candidate.name),
    ) ??
    skeleton?.bones.find((candidate) => /spine|chest/i.test(candidate.name)) ??
    skeleton?.bones[0] ??
    null;

  return new Promise((resolve) => {
    const values: number[] = [];
    const startedAt = performance.now();
    let lastFrameAt = startedAt;
    let elapsedMs = 0;
    let frames = 0;

    const observer = scene.onAfterRenderObservable.add(() => {
      const now = performance.now();
      if (frames > 0) {
        elapsedMs += now - lastFrameAt;
      }
      lastFrameAt = now;
      frames += 1;

      if (bone) {
        const quaternion = bone.rotationQuaternion;
        const angle = quaternion
          ? 2 * Math.acos(Math.min(1, Math.abs(quaternion.w)))
          : Math.abs(bone.rotation.x) +
            Math.abs(bone.rotation.y) +
            Math.abs(bone.rotation.z);
        values.push(angle);
      }

      if (now - startedAt >= durationMs) {
        scene.onAfterRenderObservable.remove(observer);
        const min = values.reduce(
          (current, value) => Math.min(current, value),
          Number.POSITIVE_INFINITY,
        );
        const max = values.reduce(
          (current, value) => Math.max(current, value),
          Number.NEGATIVE_INFINITY,
        );
        resolve({
          rangeRad: values.length > 0 ? max - min : 0,
          // elapsedMs 只累计 frames-1 个帧间隔，帧率必须用实际间隔数计算，
          // 否则会系统性高估约 1/N。
          fps: frames > 1 && elapsedMs > 0 ? ((frames - 1) * 1000) / elapsedMs : 0,
          frames,
        });
      }
    });
  });
}

function disposeCharacter(): void {
  for (const group of state.animationGroups) {
    group.stop();
    group.dispose();
  }
  state.animationGroups = [];
  state.proceduralAnimations = [];
  state.activeAnimation = null;

  state.pipeline?.dispose();
  state.pipeline = null;

  for (const material of state.ownedMaterials) {
    material.dispose();
  }
  state.ownedMaterials = [];
  state.meshMaterials = [];

  state.fallbackTexture?.dispose();
  state.fallbackTexture = null;

  state.container?.dispose();
  state.container = null;
  state.meshes = [];
  state.skeletons = [];
  state.scene = null;

  // dispose 后恢复默认开关，避免下一轮场景继承关断状态。
  resetSwitches();
}

export const animePipelineScenario: ScenarioDefinition = {
  name: ANIME_PIPELINE_SCENARIO_NAME,
  description:
    "二次元链路验证：VRoid/占位角色 + 骨骼动画 + 自定义 Toon Shader + 描边 + 色彩分级（可开关）",
  interactive: true,

  async setup(context) {
    const { scene } = context;
    disposeCharacter();
    // 强制回到默认开关状态（toon / outline / grading 全开）。
    resetSwitches();
    configureRuntimeDecoders();

    state.scene = scene;
    state.source = VRM_URL ? "vroid" : "placeholder";
    const assetUrl = VRM_URL ?? PLACEHOLDER_URL;
    if (!assetUrl) {
      throw new Error(
        "缺少角色资产：先运行 `npm run assets:anime` 生成占位角色，" +
          "或用 `npm run assets:vrm` 转换真实 VRoid 资产为 assets/character_vroid_lod0.glb",
      );
    }
    const fileName =
      state.source === "vroid"
        ? "character_vroid_lod0.glb"
        : "character_anime_placeholder.glb";

    hideDecorativeEntities(scene);
    configureCamera(scene, CAMERA_VERTICAL_SPAN);

    const { bytes, file } = await fetchGlb(assetUrl, fileName);
    state.assetBytes = bytes.byteLength;
    const container = await SceneLoader.LoadAssetContainerAsync("", file, scene);
    container.addAllToScene();
    state.container = container;

    state.meshes = container.meshes.filter(
      (mesh) => mesh.getTotalVertices() > 0,
    );
    if (state.meshes.length === 0) {
      throw new Error("角色资产没有可渲染网格");
    }
    state.skeletons = container.skeletons;

    // 材质：每个 mesh（多材质时为每个 subMesh）保留自己的 baseColor 贴图，
    // 在各自贴图上叠加 toon 逻辑；VRoid 的脸/发/身/衣不能统一换成同一张图。
    for (const mesh of state.meshes) {
      const useVertexColors = mesh.isVerticesDataPresent("color");
      const source = mesh.material;
      let toon: Material;
      let standard: Material;

      if (source instanceof MultiMaterial) {
        const toonMulti = new MultiMaterial(
          `material_toon_multi_${mesh.name}`,
          scene,
        );
        const standardMulti = new MultiMaterial(
          `material_flat_multi_${mesh.name}`,
          scene,
        );
        const toonSubs: Material[] = [];
        const standardSubs: Material[] = [];
        source.subMaterials.forEach((subMaterial, index) => {
          const texture = baseTextureOf(subMaterial) ?? ensureFallbackTexture(scene);
          const pair = createMaterialPair(
            scene,
            `${mesh.name}_${index}`,
            texture,
            useVertexColors,
          );
          toonSubs.push(pair.toon);
          standardSubs.push(pair.standard);
          state.ownedMaterials.push(pair.toon, pair.standard);
        });
        toonMulti.subMaterials = toonSubs;
        standardMulti.subMaterials = standardSubs;
        state.ownedMaterials.push(toonMulti, standardMulti);
        toon = toonMulti;
        standard = standardMulti;
      } else {
        const texture = baseTextureOf(source) ?? ensureFallbackTexture(scene);
        const pair = createMaterialPair(
          scene,
          mesh.name,
          texture,
          useVertexColors,
        );
        state.ownedMaterials.push(pair.toon, pair.standard);
        toon = pair.toon;
        standard = pair.standard;
      }

      state.meshMaterials.push({ mesh, toon, standard });
      mesh.isPickable = false;
      mesh.useVertexColors = useVertexColors;
      mesh.material = toon;
      mesh.renderOutline = true;
      mesh.outlineWidth = OUTLINE_WIDTH;
      mesh.outlineColor = new Color3(0.05, 0.04, 0.08);
    }

    // 动画：优先播放 glTF 内的 walk / run；缺失时用程序化骨骼循环兜底。
    state.animationGroups = container.animationGroups;
    for (const group of state.animationGroups) {
      group.stop();
    }
    const walk =
      state.animationGroups.find((group) => /walk/i.test(group.name)) ??
      state.animationGroups.find((group) => /idle/i.test(group.name)) ??
      state.animationGroups[0] ??
      null;
    if (walk) {
      walk.start(true);
      state.activeAnimation = walk.name;
      state.animationSource = "gltf";
    } else {
      state.proceduralAnimations = installProceduralFallback(
        scene,
        state.skeletons[0] ?? null,
      );
      state.animationSource =
        state.proceduralAnimations.length > 0 ? "procedural-fallback" : "none";
      state.activeAnimation =
        state.animationSource === "procedural-fallback"
          ? "procedural-fallback-walk"
          : null;
    }

    state.pipeline = createGradingPipeline(scene);
    refreshMaterials();

    context.registerRegion(GREYBOX_REGION_ID);
    for (const mesh of state.meshes) {
      context.registerEntity(mesh.name);
    }

    await scene.whenReadyAsync();
    await nextFrame();
    await nextFrame();

    const api: AnimePipelineDebugApi = {
      setToonEnabled(enabled) {
        state.toonEnabled = enabled;
        refreshMaterials();
      },
      setOutlineEnabled(enabled) {
        state.outlineEnabled = enabled;
        refreshMaterials();
      },
      setGradingEnabled(enabled) {
        state.gradingEnabled = enabled;
        refreshMaterials();
      },
      setAnimation(name) {
        playAnimation(name);
      },
      setCameraSpan(span) {
        configureCamera(scene, span);
      },
      getState() {
        return {
          source: state.source,
          assetBytes: state.assetBytes,
          toonEnabled: state.toonEnabled,
          outlineEnabled: state.outlineEnabled,
          gradingEnabled: state.gradingEnabled,
          animationSource: state.animationSource,
          activeAnimation: state.activeAnimation,
          meshCount: state.meshes.length,
          bones: state.skeletons.reduce(
            (sum, skeleton) => sum + skeleton.bones.length,
            0,
          ),
          morphTargets: countMorphTargets(state.meshes),
          triangles: countTriangles(state.meshes),
          animations: state.animationGroups.map((group) => ({
            name: group.name,
            isPlaying: group.isPlaying,
          })),
        };
      },
    };
    window.__animePipeline = api;

    // ?holdAnimePipeline=1 时等外部截图完成再返回报告。
    if (new URLSearchParams(window.location.search).get("holdAnimePipeline") === "1") {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, MAX_SCREENSHOT_HOLD_MS);
        window.__animePipelineRelease = () => {
          window.clearTimeout(timer);
          resolve();
        };
      });
    }
  },

  async measure(context) {
    const motion = await sampleMotion(
      context.scene,
      state.skeletons[0] ?? null,
      450,
    );
    const activeGroup = state.animationGroups.find(
      (group) => group.name === state.activeAnimation,
    );
    const animationPlaying =
      state.animationSource === "procedural-fallback"
        ? state.proceduralAnimations.length > 0
        : activeGroup?.isPlaying === true;

    const metrics: Metric[] = [
      {
        name: "characterLoaded",
        value: state.meshes.length > 0 ? 1 : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "vroidAssetLoaded",
        value: state.source === "vroid" ? 1 : 0,
        unit: "boolean",
      },
      {
        name: "mixamoAnimationLoaded",
        value:
          state.source === "vroid" &&
          state.animationGroups.some((group) => /mixamo/i.test(group.name))
            ? 1
            : 0,
        unit: "boolean",
      },
      {
        name: "triangleCount",
        value: countTriangles(state.meshes),
        unit: "triangles",
        threshold: 15000,
        comparison: "lte",
      },
      {
        name: "boneCount",
        value: state.skeletons.reduce(
          (sum, skeleton) => sum + skeleton.bones.length,
          0,
        ),
        unit: "bones",
        threshold: 20,
        comparison: "gte",
      },
      {
        name: "morphTargetCount",
        value: countMorphTargets(state.meshes),
        unit: "targets",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "animationCount",
        value:
          state.animationGroups.length > 0
            ? state.animationGroups.length
            : state.proceduralAnimations.length > 0
              ? 1
              : 0,
        unit: "animations",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "animationPlaying",
        value: animationPlaying ? 1 : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "boneMotionRangeRad",
        value: round(motion.rangeRad, 3),
        unit: "rad",
        threshold: 0.2,
        comparison: "gte",
      },
      {
        name: "toonMaterialActive",
        value:
          state.toonEnabled &&
          state.meshMaterials.length === state.meshes.length &&
          state.meshMaterials.every(({ mesh, toon }) => mesh.material === toon)
            ? 1
            : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "outlineEnabled",
        value:
          state.outlineEnabled && state.meshes.every((mesh) => mesh.renderOutline)
            ? 1
            : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "imageProcessingEnabled",
        value: state.pipeline?.imageProcessingEnabled ? 1 : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "textureCount",
        value: state.container?.textures.length ?? 0,
        unit: "textures",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "materialCount",
        value: state.container?.materials.length ?? 0,
        unit: "materials",
      },
      {
        name: "assetBytes",
        value: state.assetBytes,
        unit: "bytes",
      },
      {
        name: "fps",
        value: round(motion.fps),
        unit: "fps",
      },
      {
        name: "sampledFrames",
        value: motion.frames,
        unit: "frames",
      },
    ];

    return metrics;
  },

  teardown(context) {
    disposeCharacter();
    restoreDecorativeEntities();
    restoreCamera(context.scene);
    delete window.__animePipeline;
    delete window.__animePipelineRelease;
  },
};
