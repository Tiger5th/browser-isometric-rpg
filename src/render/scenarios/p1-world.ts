/**
 * 正式表现层场景（票 25）：p1-world。
 *
 * 在 green_hollow 区域把 P1 闭环放进正式观感里：
 * - 地面 = Gemini 环境贴图平铺（草地/石板/泥土路/水面）
 * - 环境物件 = 白底贴图抠白后的 billboard（树/石墙/灌木/木桶/木箱）
 * - 角色 = 占位角色 glb（玩家）+ P0 程序化工厂（NPC/敌人），统一 toon + 描边
 * - 遮挡描边 = P0 零分配射线-OBB 方案，作用于正式布局的树/墙/灌木
 * - 色彩分级 = DefaultRenderingPipeline（复用 anime-pipeline 参数）
 * - 动态分辨率 = 默认 auto，可用 ?quality=high|medium|low|auto 覆盖
 *
 * 玩法闭环与 dialogue-quest 相同：点击移动/攻击 → 对话 → 任务 → 奖励 → 存读档。
 */

import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { HighlightLayer } from "@babylonjs/core/Layers/highlightLayer";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import type { Scene } from "@babylonjs/core/scene";

import cullSlimesData from "../../../content/quests/cull_slimes.json";
import elderMaCompiled from "../../../content/dialogues/elder_ma.ink?ink";
import slimeTemplateData from "../../../content/enemy-templates/slime.json";
import slimeBlueData from "../../../content/enemies/slime_blue.json";
import slimeElderData from "../../../content/enemies/slime_elder.json";
import slimeMeadowData from "../../../content/enemies/slime_meadow.json";
import healingHerbData from "../../../content/items/healing_herb.json";
import oldCoinData from "../../../content/items/old_coin.json";
import slimeGelData from "../../../content/items/slime_gel.json";
import travelerSwordData from "../../../content/items/traveler_sword.json";
import npcElderData from "../../../content/npcs/elder_ma.json";
import npcScoutData from "../../../content/npcs/scout_lin.json";
import regionData from "../../../content/regions/green_hollow.json";
import type { ContentBundle } from "../../logic/content/types";
import {
  GameSession,
  type EntitySnapshot,
  type GameSessionSnapshot,
} from "../../logic/game-session";
import { summarizeFrameTimes } from "../../logic/perf";
import type { Metric } from "../../logic/report";
import { GameSaveService } from "../../logic/save";
import {
  DEFAULT_CAMERA_VERTICAL_SPAN,
  updateOrthographicFrustum,
} from "../camera";
import type { ScenarioContext, ScenarioDefinition } from "../harness";
import { setCameraSpan, setGreyboxEnabled } from "../navmesh-scene";
import { IndexedDbSaveStorage } from "../persistence/indexed-db-save-storage";
import { createQuestLoopUi, type QuestLoopUi } from "../ui/quest-loop-ui";
import {
  createProceduralNpc,
  createSlimeEnemy,
  loadPlayerCharacter,
  type PlayerCharacter,
  type ProceduralCharacter,
} from "../presentation/character-visuals";
import {
  createGreenHollowEnvironment,
  type EnvironmentVisuals,
} from "../presentation/environment-visuals";
import {
  GREEN_HOLLOW_REGION_ID,
  PROPS,
  validateLayout,
} from "../presentation/green-hollow-layout";
import { OcclusionOutlineController } from "../presentation/occlusion-controller";
import {
  DynamicResolutionController,
  QUALITY_PRESETS,
  maxScaleForPixels,
  parseQualityLevel,
  renderScaleToHardwareScaling,
  resolvePresetRenderScale,
  type QualityLevel,
} from "../presentation/quality";
import { createWhiteTexture } from "../presentation/textures";

const SCENARIO_NAME = "p1-world";
const PLAYER_ID = "entity:player";
const CAMERA_VERTICAL_SPAN = 30;
const SAMPLE_DURATION_MS = 4_000;
/** 07 修正预算：基础 ≤300 + 描边/VFX ≤50。 */
const DRAW_CALL_BUDGET = 350;
const JS_HEAP_BUDGET_MB = 1500;

const PLACEHOLDER_URLS = import.meta.glob(
  "../../../assets/character_anime_placeholder.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;
const PLACEHOLDER_URL = Object.values(PLACEHOLDER_URLS)[0] ?? null;

const CONTENT_BUNDLE = {
  regions: [regionData],
  npcs: [npcElderData, npcScoutData],
  enemyTemplates: [slimeTemplateData],
  enemies: [slimeMeadowData, slimeBlueData, slimeElderData],
  items: [healingHerbData, oldCoinData, slimeGelData, travelerSwordData],
  quests: [cullSlimesData],
} as unknown as ContentBundle;

interface EntityVisual {
  node: TransformNode;
  /** 用于点击/遮挡描边的网格。 */
  mesh: AbstractMesh;
  targetY: number;
  procedural: ProceduralCharacter | null;
}

interface P1WorldState {
  root: TransformNode;
  session: GameSession;
  visuals: Map<string, EntityVisual>;
  deadEnemies: Set<string>;
  player: PlayerCharacter;
  whiteTexture: BaseTexture;
  environment: EnvironmentVisuals;
  materials: Material[];
  layer: HighlightLayer;
  occlusion: OcclusionOutlineController;
  pipeline: DefaultRenderingPipeline;
  ui: QuestLoopUi;
  saveService: GameSaveService;
  saveAvailable: boolean;
  observer: Observer<Scene> | null;
  detachPointer: () => void;
  quality: {
    level: QualityLevel;
    renderScale: number;
    controller: DynamicResolutionController | null;
    adjustments: number;
  };
  environmentMetrics: {
    textureCount: number;
    keyedTransparentRatio: number;
    occluderCount: number;
  };
  instrumentation: SceneInstrumentation;
  lastDrawCalls: number;
  occlusionTargets: Array<{
    id: string;
    mesh: Mesh;
    anchor: { x: number; y: number; z: number };
    targetY: number;
  }>;
  probeHoldUntil: number;
  previousHardwareScaling: number;
}

/** ego-browser 验证入口：只经 snapshot 读取、只经意图写入。 */
export interface P1WorldDebugApi {
  scenario: string;
  getSnapshot(): GameSessionSnapshot;
  moveTo(x: number, z: number): void;
  talkTo(npcId: string): void;
  chooseDialogueOption(index: number): void;
  attackEnemy(enemyId: string): void;
  useItem(instanceId: string): void;
  equipItem(instanceId: string): void;
  unequipItem(instanceId: string): void;
  getPlayer(): EntitySnapshot | null;
  save(): Promise<{ version: number; elapsedMs: number } | null>;
  load(): Promise<boolean>;
  clearSave(): Promise<void>;
  hasSave(): Promise<boolean>;
  getMeshPosition(entityId: string): { x: number; y: number; z: number } | null;
  /** 画质档位：运行时切换，返回最终 renderScale。 */
  setQuality(level: QualityLevel): number;
  getQuality(): {
    level: QualityLevel;
    renderScale: number;
    auto: boolean;
    adjustments: number;
    renderWidth: number;
    renderHeight: number;
    devicePixelRatio: number;
  };
  /** 遮挡描边当前状态。 */
  getOcclusion(): { occluded: string[]; outlined: number; detectionMs: number };
  /**
   * 遮挡探针：把玩家视觉临时移到一棵树后面做射线-OBB 判定，
   * holdMs > 0 时保持位置便于截图，过期后下一帧自动回到快照位置。
   */
  probeOcclusion(holdMs?: number): {
    occluded: string[];
    outlined: number;
    position: { x: number; z: number };
  };
  /** 保持眯眼/眨眼 ms，便于截图（默认 500ms）。 */
  blink(holdMs?: number): void;
  /** toon/morph/环境贴图证据。 */
  getRenderEvidence(): {
    morphTargetCount: number;
    morphTargetNames: string[];
    morphInfluence: number;
    morphShaderReady: boolean;
    playerToonActive: boolean;
    outlineMeshes: number;
    environmentTextureCount: number;
    environmentKeyedRatio: number;
    occluderCount: number;
    drawCalls: number;
  };
}

declare global {
  interface Window {
    P1WorldDebug?: P1WorldDebugApi;
  }
}

const states = new WeakMap<ScenarioContext, P1WorldState>();

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function playerSnapshot(session: GameSession): EntitySnapshot | null {
  return (
    session.snapshot().entities.find((entity) => entity.id === PLAYER_ID) ?? null
  );
}

function entityIdOf(mesh: AbstractMesh | null): string | null {
  let node: AbstractMesh | null = mesh;
  while (node !== null) {
    const metadata = node.metadata as { entityId?: unknown } | null;
    if (typeof metadata?.entityId === "string") {
      return metadata.entityId;
    }
    node = node.parent as AbstractMesh | null;
  }
  return null;
}

function applyRenderScale(
  scene: Scene,
  renderScale: number,
  devicePixelRatio: number,
): void {
  const engine = scene.getEngine();
  engine.setHardwareScalingLevel(
    renderScaleToHardwareScaling(renderScale, devicePixelRatio),
  );
  engine.resize();
  const camera = scene.activeCamera;
  const height = engine.getRenderHeight();
  if (camera) {
    updateOrthographicFrustum(
      camera,
      height > 0 ? engine.getRenderWidth() / height : 1,
      CAMERA_VERTICAL_SPAN,
    );
  }
}

function viewportInfo(scene: Scene): {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
} {
  const canvas = scene.getEngine().getRenderingCanvas();
  return {
    cssWidth: canvas?.clientWidth ?? 1920,
    cssHeight: canvas?.clientHeight ?? 1080,
    devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
  };
}

function configureQuality(
  scene: Scene,
  state: P1WorldState,
  level: QualityLevel,
): number {
  const viewport = viewportInfo(scene);
  state.quality.level = level;
  if (level === "auto") {
    const cap = maxScaleForPixels(
      viewport.cssWidth,
      viewport.cssHeight,
      viewport.devicePixelRatio,
    );
    state.quality.renderScale = cap;
    state.quality.controller = new DynamicResolutionController(cap, {
      maxScale: cap,
      minScale: Math.min(cap, 0.5),
    });
    state.occlusion.setEnabled(true);
    state.pipeline.imageProcessingEnabled = true;
  } else {
    const preset = QUALITY_PRESETS[level];
    state.quality.renderScale = resolvePresetRenderScale(
      level,
      viewport.cssWidth,
      viewport.cssHeight,
      viewport.devicePixelRatio,
    );
    state.quality.controller = null;
    state.occlusion.setEnabled(preset.outline);
    state.pipeline.imageProcessingEnabled = preset.grading;
  }
  applyRenderScale(scene, state.quality.renderScale, viewport.devicePixelRatio);
  return state.quality.renderScale;
}

function createGradingPipeline(scene: Scene): DefaultRenderingPipeline {
  const camera = scene.activeCamera;
  if (!camera) {
    throw new Error("p1-world 需要 activeCamera");
  }
  const pipeline = new DefaultRenderingPipeline(
    "pipeline.p1-world-grading",
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

function createEntityVisual(
  scene: Scene,
  root: TransformNode,
  state: Pick<P1WorldState, "whiteTexture" | "materials">,
  entity: EntitySnapshot,
): EntityVisual {
  const id = entity.id;
  let visual: EntityVisual;
  if (entity.identity.type === "player") {
    throw new Error("玩家视觉必须在会话初始化后单独创建");
  }

  if (entity.identity.type === "npc") {
    const tint = entity.identity.displayName === "马婆婆" ? "#f0abfc" : "#a3e635";
    const procedural = createProceduralNpc(
      scene,
      root,
      `${id}.`,
      Color3.FromHexString(tint),
      state.whiteTexture,
    );
    state.materials.push(procedural.material);
    procedural.mesh.metadata = { entityId: id };
    visual = {
      node: procedural.mesh,
      mesh: procedural.mesh,
      targetY: 0.55,
      procedural,
    };
  } else {
    const tint = entity.identity.displayName.includes("蓝") ? "#60a5fa" : "#86efac";
    const procedural = createSlimeEnemy(
      scene,
      root,
      `${id}.`,
      Color3.FromHexString(tint),
      state.whiteTexture,
    );
    state.materials.push(procedural.material);
    procedural.mesh.metadata = { entityId: id };
    visual = {
      node: procedural.mesh,
      mesh: procedural.mesh,
      targetY: 0.45,
      procedural,
    };
  }

  return visual;
}

function syncVisualToSnapshot(
  state: P1WorldState,
  snapshot: GameSessionSnapshot,
  skipEntityId: string | null = null,
): void {
  for (const entity of snapshot.entities) {
    const visual = state.visuals.get(entity.id);
    if (!visual || entity.id === skipEntityId) {
      continue;
    }
    if (
      entity.identity.type === "enemy" &&
      (!entity.combat.alive || state.deadEnemies.has(entity.id))
    ) {
      visual.node.setEnabled(false);
      continue;
    }
    visual.node.setEnabled(true);
    if (entity.identity.type === "enemy") {
      visual.node.position.set(entity.position.x, 0.45, entity.position.z);
    } else {
      visual.node.position.set(
        entity.position.x,
        entity.position.y,
        entity.position.z,
      );
      // 程序化角色没有旋转四元数；玩家 glb 由 loader 写入四元数，保持不动。
      if (entity.identity.type !== "player") {
        visual.node.rotation.y = entity.rotation.y;
      }
    }
  }
}

async function saveToStorage(
  state: P1WorldState,
): Promise<{ version: number; elapsedMs: number } | null> {
  try {
    const snapshot = state.session.snapshot();
    const file = await state.saveService.save(snapshot);
    state.saveAvailable = true;
    state.ui.setSaveStatus(`已存档 · v${file.version} · ${snapshot.elapsedMs}ms`, "ok");
    return { version: file.version, elapsedMs: snapshot.elapsedMs };
  } catch (error) {
    state.ui.setSaveStatus(`存档失败：${errorMessage(error)}`, "error");
    return null;
  }
}

async function loadFromStorage(state: P1WorldState): Promise<boolean> {
  try {
    const snapshot = await state.saveService.load();
    if (snapshot === null) {
      state.saveAvailable = false;
      state.ui.setSaveStatus("无存档：先点「存档」再刷新页面", "idle");
      return false;
    }
    state.session.restoreSnapshot(snapshot);
    const restored = state.session.snapshot();
    state.deadEnemies.clear();
    for (const entity of restored.entities) {
      if (entity.identity.type === "enemy" && !entity.combat.alive) {
        state.deadEnemies.add(entity.id);
      }
    }
    syncVisualToSnapshot(state, restored);
    state.saveAvailable = true;
    state.ui.update(restored);
    state.ui.setSaveStatus(
      `已从存档恢复 · v${snapshot.version} · ${snapshot.elapsedMs}ms`,
      "ok",
    );
    return true;
  } catch (error) {
    state.saveAvailable = false;
    state.ui.setSaveStatus(`读档失败：${errorMessage(error)}`, "error");
    return false;
  }
}

async function clearStoredSave(state: P1WorldState): Promise<void> {
  try {
    await state.saveService.clear();
    state.saveAvailable = false;
    state.ui.setSaveStatus("存档已删除", "idle");
  } catch (error) {
    state.ui.setSaveStatus(`删除存档失败：${errorMessage(error)}`, "error");
  }
}

function groundPoint(scene: Scene): Vector3 | null {
  const camera = scene.activeCamera;
  if (!camera) {
    return null;
  }
  const ray = scene.createPickingRay(
    scene.pointerX,
    scene.pointerY,
    Matrix.Identity(),
    camera,
  );
  if (Math.abs(ray.direction.y) < 1e-6) {
    return null;
  }
  const distance = -ray.origin.y / ray.direction.y;
  if (distance <= 0) {
    return null;
  }
  return ray.origin.add(ray.direction.scale(distance));
}

interface FrameSample {
  dtMs: number;
  drawCalls: number;
  morphInfluence: number;
  detectionMs: number;
}

function collectFrames(
  scene: Scene,
  state: P1WorldState,
  durationMs: number,
): Promise<FrameSample[]> {
  const instrumentation = state.instrumentation;
  const samples: FrameSample[] = [];
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let lastFrameAt = startedAt;
    const observer = scene.onAfterRenderObservable.add(() => {
      const now = performance.now();
      samples.push({
        dtMs: now - lastFrameAt,
        drawCalls: instrumentation.drawCallsCounter.current,
        morphInfluence: state.player.getMorphInfluence(),
        detectionMs: state.occlusion.detectionMs,
      });
      lastFrameAt = now;
      if (now - startedAt >= durationMs) {
        scene.onAfterRenderObservable.remove(observer);
        resolve(samples);
      }
    });
  });
}

/** 预热：让动态分辨率在同一画质下收敛，再开始正式采样。 */
function settleFrames(scene: Scene, durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const observer = scene.onAfterRenderObservable.add(() => {
      if (performance.now() - startedAt >= durationMs) {
        scene.onAfterRenderObservable.remove(observer);
        resolve();
      }
    });
  });
}

function installDebugApi(scene: Scene, state: P1WorldState): void {
  state.session.subscribe((event) => {
    if (event.type === "enemy-killed" && !state.deadEnemies.has(event.enemyId)) {
      state.deadEnemies.add(event.enemyId);
      state.visuals.get(event.enemyId)?.node.setEnabled(false);
    }
  });

  window.P1WorldDebug = {
    scenario: SCENARIO_NAME,
    getSnapshot: () => state.session.snapshot(),
    moveTo: (x, z) => state.session.moveTo(PLAYER_ID, { x, y: 0, z }),
    talkTo: (npcId) => state.session.talkTo(npcId),
    chooseDialogueOption: (index) => state.session.chooseDialogueOption(index),
    attackEnemy: (enemyId) => state.session.attack(PLAYER_ID, enemyId),
    useItem: (instanceId) => state.session.useItem(PLAYER_ID, instanceId),
    equipItem: (instanceId) => state.session.equip(PLAYER_ID, instanceId),
    unequipItem: (instanceId) => state.session.unequip(PLAYER_ID, instanceId),
    getPlayer: () => playerSnapshot(state.session),
    save: () => saveToStorage(state),
    load: () => loadFromStorage(state),
    clearSave: () => clearStoredSave(state),
    hasSave: () => state.saveService.hasSave(),
    getMeshPosition: (entityId) => {
      const visual = state.visuals.get(entityId);
      if (!visual) {
        return null;
      }
      return {
        x: visual.node.position.x,
        y: visual.node.position.y,
        z: visual.node.position.z,
      };
    },
    setQuality: (level) => configureQuality(scene, state, level),
    getQuality: () => {
      const engine = scene.getEngine();
      return {
        level: state.quality.level,
        renderScale: state.quality.renderScale,
        auto: state.quality.controller !== null,
        adjustments: state.quality.adjustments,
        renderWidth: engine.getRenderWidth(),
        renderHeight: engine.getRenderHeight(),
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    },
    getOcclusion: () => ({
      occluded: [...state.occlusion.occludedIds],
      outlined: state.occlusion.outlinedCount,
      detectionMs: round(state.occlusion.detectionMs, 3),
    }),
    probeOcclusion: (holdMs = 0) => {
      // 用低矮石墙做探针：角色上半身可见，描边高亮在截图里更清楚。
      const occluder = PROPS.find(
        (prop) => prop.id === "prop.wall.north-west",
      );
      if (!occluder) {
        throw new Error("布局缺少可用于遮挡探针的石墙");
      }
      const forward = scene.activeCamera
        ? scene.activeCamera.getDirection(new Vector3(0, 0, 1)).normalize()
        : new Vector3(0.577, 0.577, -0.577);
      const horizontalLength = Math.hypot(forward.x, forward.z) || 1;
      const dirX = forward.x / horizontalLength;
      const dirZ = forward.z / horizontalLength;
      // 站在墙背离相机的一侧 1.2m：相机→玩家的射线正好穿过墙体遮挡盒。
      // forward 是相机→场景方向，因此玩家位置 = 墙 + forward * 1.2。
      const position = {
        x: round(occluder.x + dirX * 1.2, 3),
        z: round(occluder.z + dirZ * 1.2, 3),
      };
      state.player.rootNode.position.set(position.x, 0, position.z);
      state.probeHoldUntil =
        holdMs > 0 ? performance.now() + holdMs : 0;
      state.occlusion.update(state.occlusionTargets);
      const outlined = [...state.occlusion.occludedIds];
      if (holdMs <= 0) {
        syncVisualToSnapshot(state, state.session.snapshot());
      }
      return {
        occluded: outlined,
        outlined: state.occlusion.outlinedCount,
        position,
      };
    },
    blink: (holdMs = 500) => state.player.triggerBlink(holdMs),
    getRenderEvidence: () => ({
      morphTargetCount: state.player.morphTargetCount,
      morphTargetNames: [...state.player.morphTargetNames],
      morphInfluence: round(state.player.getMorphInfluence(), 3),
      morphShaderReady: state.player.isMorphShaderReady(),
      playerToonActive: state.player.meshes.every(
        (mesh) => mesh.material !== null && mesh.material.name.startsWith("material.player."),
      ),
      outlineMeshes: state.player.meshes.filter((mesh) => mesh.renderOutline).length,
      environmentTextureCount: state.environmentMetrics.textureCount,
      environmentKeyedRatio: round(state.environmentMetrics.keyedTransparentRatio, 4),
      occluderCount: state.environmentMetrics.occluderCount,
      drawCalls: state.lastDrawCalls,
    }),
  };
}

export const p1WorldScenario: ScenarioDefinition = {
  name: SCENARIO_NAME,
  description:
    "P1 正式表现层：贴图环境 + 占位角色 toon + 遮挡描边 + 动态分辨率，完整玩法闭环",
  interactive: true,

  async setup(context) {
    const { scene, engine } = context;
    setGreyboxEnabled(scene, false);
    setCameraSpan(scene, CAMERA_VERTICAL_SPAN);

    const layoutIssues = validateLayout();
    if (layoutIssues.length > 0) {
      throw new Error(
        `green_hollow 布局自检失败：${layoutIssues
          .map((issue) => `${issue.id}: ${issue.message}`)
          .join("；")}`,
      );
    }

    if (!PLACEHOLDER_URL) {
      throw new Error(
        "缺少占位角色资产 assets/character_anime_placeholder.glb（先运行 npm run assets:anime）",
      );
    }

    const root = new TransformNode("scenario.p1-world", scene);
    const camera = scene.activeCamera;
    const forward = camera
      ? camera.getDirection(new Vector3(0, 0, 1)).normalize()
      : new Vector3(-0.408, -0.816, 0.408).normalize();

    const environment = await createGreenHollowEnvironment(scene, root, forward);
    const pipeline = createGradingPipeline(scene);
    const whiteTexture = createWhiteTexture(scene);

    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(CONTENT_BUNDLE, GREEN_HOLLOW_REGION_ID);

    const player = await loadPlayerCharacter(
      scene,
      PLACEHOLDER_URL,
      "character_anime_placeholder.glb",
    );
    player.rootNode.metadata = { entityId: PLAYER_ID };
    if (player.rootNode.parent === null) {
      player.rootNode.parent = root;
    }

    const materials: Material[] = [];
    const visuals = new Map<string, EntityVisual>();
    visuals.set(PLAYER_ID, {
      node: player.rootNode,
      mesh: player.meshes[0],
      targetY: 0.55,
      procedural: null,
    });

    const initialSnapshot = session.snapshot();
    for (const entity of initialSnapshot.entities) {
      if (entity.identity.type === "player") {
        continue;
      }
      visuals.set(
        entity.id,
        createEntityVisual(scene, root, { whiteTexture, materials }, entity),
      );
    }

    const layer = new HighlightLayer("layer.p1-world-occlusion", scene);
    // 环境 billboard 是自绘 alpha-test ShaderMaterial；把它们排除出高亮层，
    // 避免它们参与 glow 的深度/模板路径（实测会导致高亮色被渲染成黑色）。
    for (const mesh of [
      ...environment.groundMeshes,
      ...environment.propMeshes,
    ]) {
      layer.addExcludedMesh(mesh);
    }
    const occlusion = new OcclusionOutlineController(
      layer,
      environment.occluders.map((occluder) => occluder.box),
      forward,
    );

    const keyRatios = environment.keyStats.map((stats) => stats.transparentRatio);
    const state: P1WorldState = {
      root,
      session,
      visuals,
      deadEnemies: new Set<string>(),
      player,
      whiteTexture,
      environment,
      materials,
      layer,
      occlusion,
      pipeline,
      ui: {
        update: () => undefined,
        setSaveStatus: () => undefined,
        dispose: () => undefined,
      },
      saveService: new GameSaveService(new IndexedDbSaveStorage()),
      saveAvailable: false,
      observer: null,
      detachPointer: () => undefined,
      quality: {
        level: "auto",
        renderScale: 1,
        controller: null,
        adjustments: 0,
      },
      environmentMetrics: {
        textureCount: environment.textures.textures.length,
        keyedTransparentRatio:
          keyRatios.reduce((sum, value) => sum + value, 0) / Math.max(1, keyRatios.length),
        occluderCount: environment.occluders.length,
      },
      instrumentation: new SceneInstrumentation(scene),
      lastDrawCalls: 0,
      occlusionTargets: [],
      probeHoldUntil: 0,
      previousHardwareScaling: engine.getHardwareScalingLevel(),
    };
    states.set(context, state);

    syncVisualToSnapshot(state, initialSnapshot);

    const killNextEnemy = (): void => {
      const next = state.session
        .snapshot()
        .entities.find(
          (entity) =>
            entity.identity.type === "enemy" &&
            entity.combat.alive &&
            !state.deadEnemies.has(entity.id),
        );
      if (next) {
        window.P1WorldDebug?.attackEnemy(next.id);
      }
    };

    state.ui = createQuestLoopUi({
      mount: document.body,
      bundle: CONTENT_BUNDLE,
      onChoose: (index) => session.chooseDialogueOption(index),
      onUseItem: (instanceId) => session.useItem(PLAYER_ID, instanceId),
      onEquipItem: (instanceId) => session.equip(PLAYER_ID, instanceId),
      onUnequipItem: (instanceId) => session.unequip(PLAYER_ID, instanceId),
      onDebugKill: killNextEnemy,
      onSave: () => {
        void saveToStorage(state);
      },
      onLoad: () => {
        void loadFromStorage(state);
      },
      onClearSave: () => {
        void clearStoredSave(state);
      },
    });

    // 画质档位：?quality=high|medium|low|auto（默认 auto = 动态分辨率）。
    const requestedQuality = parseQualityLevel(
      new URLSearchParams(window.location.search).get("quality"),
    );
    configureQuality(scene, state, requestedQuality);

    // 点击 NPC = 对话；点击其他实体 = 走近；点击地面 = 移动。
    const pointerObserver = scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) {
        return;
      }
      if (session.snapshot().dialogue !== null) {
        return;
      }
      const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) =>
        mesh.isPickable && mesh.isEnabled(),
      );
      const pickedId = entityIdOf(pick?.pickedMesh ?? null);
      if (pickedId !== null) {
        const picked = session
          .snapshot()
          .entities.find((entity) => entity.id === pickedId);
        if (picked?.identity.type === "npc") {
          session.talkTo(pickedId);
          return;
        }
        if (picked !== undefined) {
          session.moveTo(PLAYER_ID, {
            x: picked.position.x,
            y: 0,
            z: picked.position.z + 1.5,
          });
        }
        return;
      }
      const point = groundPoint(scene);
      if (point !== null) {
        session.moveTo(PLAYER_ID, { x: point.x, y: 0, z: point.z });
      }
    });
    state.detachPointer = () => {
      scene.onPointerObservable.remove(pointerObserver);
    };

    const targets = [...visuals.entries()].map(([id, visual]) => ({
      id,
      mesh: visual.mesh as Mesh,
      anchor: visual.node.position,
      targetY: visual.targetY,
    }));
    state.occlusionTargets = targets;

    let lastFrameAt = performance.now();
    let lastUiUpdateAt = 0;
    let previousX = player.rootNode.position.x;
    let previousZ = player.rootNode.position.z;
    const observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const deltaMs = Math.min(Math.max(now - lastFrameAt, 0), 100);
      lastFrameAt = now;

      session.advance(deltaMs);
      const snapshot = session.snapshot();
      syncVisualToSnapshot(
        state,
        snapshot,
        now < state.probeHoldUntil ? PLAYER_ID : null,
      );

      const dx = player.rootNode.position.x - previousX;
      const dz = player.rootNode.position.z - previousZ;
      previousX = player.rootNode.position.x;
      previousZ = player.rootNode.position.z;
      player.setMoving(Math.hypot(dx, dz) > 0.0005);
      player.update(deltaMs);

      state.occlusion.update(targets);
      state.lastDrawCalls = state.instrumentation.drawCallsCounter.current;

      const controller = state.quality.controller;
      if (controller) {
        const nextScale = controller.sample(deltaMs);
        if (nextScale !== null) {
          state.quality.renderScale = nextScale;
          state.quality.adjustments = controller.adjustmentCount;
          const viewport = viewportInfo(scene);
          applyRenderScale(scene, nextScale, viewport.devicePixelRatio);
        }
      }

      // HUD 只显示属性/任务/背包，10Hz 足够；避免每帧重写 DOM 拉高 p95。
      if (now - lastUiUpdateAt >= 100) {
        lastUiUpdateAt = now;
        state.ui.update(snapshot);
      }
    });
    state.observer = observer;

    context.registerRegion(GREEN_HOLLOW_REGION_ID);
    for (const entity of snapshotEntities(session)) {
      context.registerEntity(entity);
    }
    installDebugApi(scene, state);

    await scene.whenReadyAsync();
    await nextFrame();
    await nextFrame();

    try {
      if (await state.saveService.hasSave()) {
        await loadFromStorage(state);
      } else {
        state.ui.setSaveStatus("无存档：点击「存档」创建", "idle");
      }
    } catch (error) {
      state.ui.setSaveStatus(`存档不可用：${errorMessage(error)}`, "error");
    }

    // 首帧渲染后触发一次眨眼，确保 morph shader 已编译。
    player.triggerBlink(400);
    await nextFrame();
  },

  async measure(context) {
    const state = states.get(context);
    if (!state) {
      throw new Error("p1-world state 未初始化");
    }
    const scene = context.scene;

    // 1) 遮挡探针：把玩家视觉移到树后一帧，确认新区域的射线-OBB → HighlightLayer 通路。
    const probe = window.P1WorldDebug?.probeOcclusion(0) ?? null;

    // 2) 预热让动态分辨率收敛（不把首帧 shader 编译/降档过程算进 fpsAverage）。
    await settleFrames(scene, 2_500);

    // 3) 固定收敛后的分辨率采样；采样期间暂停自动降档（SAMPLE_DURATION_MS）。
    const wasAuto = state.quality.level === "auto";
    const controller = state.quality.controller;
    state.quality.controller = null;

    state.player.triggerBlink(1_200);
    const frames = await collectFrames(scene, state, SAMPLE_DURATION_MS);
    state.quality.controller = controller;
    const summary = summarizeFrameTimes(frames.map((frame) => frame.dtMs));
    const fpsMin = summary.maxMs > 0 ? 1_000 / summary.maxMs : 0;
    const drawCalls = frames.map((frame) => frame.drawCalls);
    const drawCallsAverage =
      drawCalls.reduce((sum, value) => sum + value, 0) / Math.max(1, drawCalls.length);
    const drawCallsMax = drawCalls.reduce((max, value) => Math.max(max, value), 0);
    const morphInfluenceMax = frames.reduce(
      (max, frame) => Math.max(max, frame.morphInfluence),
      0,
    );
    const detectionAverage =
      frames.reduce((sum, frame) => sum + frame.detectionMs, 0) /
      Math.max(1, frames.length);
    const detectionMax = frames.reduce(
      (max, frame) => Math.max(max, frame.detectionMs),
      0,
    );

    const engine = scene.getEngine();
    const snapshot = state.session.snapshot();
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
      }
    ).memory;

    const metrics: Metric[] = [
      {
        // P0 最终报告（ticket 18）修正：60fps 下帧间隔四舍五入会让平均值在
        // 59.9–60.0 间抖动，主判据改为 >= 59.5，避免状态抖动。
        name: "fpsAverage",
        value: round(summary.fps),
        unit: "fps",
        threshold: 59.5,
        comparison: "gte",
      },
      // fpsMin / p95 是 L5 夜间固定协议的判据；ego-browser 共享浏览器
      // 存在其他会话负载（P0 报告已记录 fps 方差），这里只报告不阻塞。
      {
        name: "fpsMin",
        value: round(fpsMin),
        unit: "fps",
      },
      {
        name: "frameTimeP95Ms",
        value: round(summary.p95Ms),
        unit: "ms",
      },
      {
        name: "drawCallsAverage",
        value: round(drawCallsAverage),
        unit: "calls",
      },
      {
        name: "drawCallsMax",
        value: drawCallsMax,
        unit: "calls",
        threshold: DRAW_CALL_BUDGET,
        comparison: "lte",
      },
      {
        name: "renderWidth",
        value: engine.getRenderWidth(),
        unit: "px",
      },
      {
        name: "renderHeight",
        value: engine.getRenderHeight(),
        unit: "px",
      },
      {
        name: "renderPixelsMP",
        value: round(
          (engine.getRenderWidth() * engine.getRenderHeight()) / 1_000_000,
        ),
        unit: "MP",
      },
      {
        name: "renderScale",
        value: round(state.quality.renderScale, 3),
        unit: "ratio",
      },
      {
        name: "dynamicResolutionAuto",
        value: wasAuto ? 1 : 0,
        unit: "boolean",
      },
      {
        name: "dynamicResolutionAdjustments",
        value: state.quality.adjustments,
        unit: "adjustments",
      },
      {
        name: "gameSession.entityCount",
        value: snapshot.entities.length,
        unit: "entities",
        threshold: 6,
        comparison: "eq",
      },
      {
        name: "quest.total",
        value: snapshot.quests.length,
        unit: "quests",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "toonCharacterCount",
        value: state.visuals.size,
        unit: "characters",
        threshold: 6,
        comparison: "eq",
      },
      {
        name: "environmentTextureCount",
        value: state.environmentMetrics.textureCount,
        unit: "textures",
        threshold: 9,
        comparison: "eq",
      },
      {
        name: "environmentKeyedTransparentRatio",
        value: round(state.environmentMetrics.keyedTransparentRatio, 4),
        unit: "ratio",
        threshold: 0.3,
        comparison: "gte",
      },
      {
        name: "occluderCount",
        value: state.environmentMetrics.occluderCount,
        unit: "occluders",
        threshold: 20,
        comparison: "gte",
      },
      {
        name: "occlusionOutlined",
        value: state.occlusion.outlinedCount,
        unit: "meshes",
      },
      {
        name: "occlusionDetectionMsAverage",
        value: round(detectionAverage, 4),
        unit: "ms/frame",
        threshold: 0.05,
        comparison: "lte",
      },
      {
        name: "occlusionDetectionMsMax",
        value: round(detectionMax, 4),
        unit: "ms",
        threshold: 0.1,
        comparison: "lte",
      },
      {
        name: "occlusionProbeOutlined",
        value: probe?.outlined ?? 0,
        unit: "meshes",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "morphTargetCount",
        value: state.player.morphTargetCount,
        unit: "targets",
        threshold: 1,
        comparison: "gte",
      },
      {
        name: "morphInfluenceMax",
        value: round(morphInfluenceMax, 3),
        unit: "influence",
        threshold: 0.9,
        comparison: "gte",
      },
      {
        name: "morphShaderReady",
        value: state.player.isMorphShaderReady() ? 1 : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "toonPlayerMaterialActive",
        value: state.player.meshes.every(
          (mesh) =>
            mesh.material !== null &&
            mesh.material.name.startsWith("material.player."),
        )
          ? 1
          : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "imageProcessingEnabled",
        value: state.pipeline.imageProcessingEnabled ? 1 : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "sampledFrames",
        value: summary.count,
        unit: "frames",
      },
      {
        name: "longFrames",
        value: summary.longFrames,
        unit: "frames",
      },
    ];

    if (memory) {
      metrics.push({
        name: "jsHeapUsedMB",
        value: round(memory.usedJSHeapSize / (1024 * 1024)),
        unit: "MB",
        threshold: JS_HEAP_BUDGET_MB,
        comparison: "lte",
      });
    }

    return metrics;
  },

  teardown(context) {
    const state = states.get(context);
    if (!state) {
      return;
    }
    states.delete(context);

    state.detachPointer();
    if (state.observer) {
      context.scene.onBeforeRenderObservable.remove(state.observer);
    }
    state.ui.dispose();

    state.occlusion.dispose();
    state.layer.dispose();

    for (const visual of state.visuals.values()) {
      visual.procedural?.dispose();
    }
    for (const material of state.materials) {
      material.dispose();
    }
    state.player.dispose();
    state.environment.dispose();
    state.whiteTexture.dispose();
    state.pipeline.dispose();
    state.root.dispose(false, true);

    state.instrumentation.dispose();
    setGreyboxEnabled(context.scene, true);
    setCameraSpan(context.scene, DEFAULT_CAMERA_VERTICAL_SPAN);
    const engine = context.scene.getEngine();
    engine.setHardwareScalingLevel(state.previousHardwareScaling);
    engine.resize();
    delete window.P1WorldDebug;
  },
};

function snapshotEntities(session: GameSession): string[] {
  return session.snapshot().entities.map((entity) => entity.id);
}
