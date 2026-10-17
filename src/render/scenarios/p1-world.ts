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
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
import type { Material } from "@babylonjs/core/Materials/material";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { Scene } from "@babylonjs/core/scene";
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
  type IntentResult,
} from "../../logic/game-session";
import { summarizeFrameTimes } from "../../logic/perf";
import type { Metric } from "../../logic/report";
import { GameSaveService } from "../../logic/save";
import { GameSaveSlotService, type SaveSlotId } from "../../logic/save-slots";
import { GameSaveAutoSaver } from "../../logic/save-autosave";
import { slotLabel } from "../../logic/save-slot-view";
import { createSaveSlotPanel, type SaveSlotPanel } from "../ui/save-slot-panel";
import {
  DEFAULT_CAMERA_VERTICAL_SPAN,
  cameraVerticalSpan,
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
import {
  createGreenHollowNavigation,
  type GreenHollowNavigation,
} from "../presentation/green-hollow-navigation";
import {
  createLandscapeRing,
  installLandscapeFog,
  installUnifiedKeyLight,
  type LandscapeVisuals,
} from "../presentation/landscape-ring";
import { NpcIdleController } from "../presentation/npc-idle";
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
import {
  createCombatFeedbackLayer,
  type CombatFeedbackLayer,
} from "../presentation/combat-feedback";
import { CombatAudio } from "../presentation/combat-audio";
import { createWhiteTexture } from "../presentation/textures";
import {
  bushAlphaForOcclusion,
  bushOcclusionAt,
  buildPropColliders,
  isBlockedByCollider,
  keyLightAzimuthDegrees,
  keyLightElevationDegrees,
  resolveMoveWithColliders,
  validateKeyLight,
  validateLandscape,
  type PropCollider,
} from "../presentation/world-physics";

const SCENARIO_NAME = "p1-world";
const PLAYER_ID = "entity:player";
/**
 * 占位 glb 的模型朝向偏移。逻辑层约定 rotation.y=0 朝 +Z（atan2(dx, dz)）；
 * 资产本身也朝 +Z，因此偏移为 0。若换资产后角色倒着走，只改这个常量。
 */
const PLAYER_MODEL_YAW_OFFSET = 0;
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

/**
 * 真实 VRM 角色（票 30）：`npm run assets:real-character` 产出后自动优先于
 * 占位角色。与 anime-pipeline 的 character_vroid_lod0.glb 约定一致。
 */
const REAL_CHARACTER_URLS = import.meta.glob(
  "../../../assets/character_vroid_lod0.glb",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;
const REAL_CHARACTER_URL = Object.values(REAL_CHARACTER_URLS)[0] ?? null;

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
  /** 受击闪白要还原的原始 tint（敌人/NPC 才有）。 */
  baseTint: Color3 | null;
}

interface P1WorldState {
  root: TransformNode;
  session: GameSession;
  visuals: Map<string, EntityVisual>;
  deadEnemies: Set<string>;
  player: PlayerCharacter;
  whiteTexture: BaseTexture;
  environment: EnvironmentVisuals;
  /** 边界景观环带 + 渐暗雾（票 28）。 */
  landscape: LandscapeVisuals;
  /** 全场唯一主光（票 28；main.ts 的默认双光源已关闭）。 */
  keyLight: DirectionalLight | null;
  /** 硬碰撞体（树/墙/桶/箱；灌木可穿）。 */
  colliders: PropCollider[];
  /** NPC 待机演出（呼吸/踱步）。 */
  npcIdle: Map<string, NpcIdleController>;
  materials: Material[];
  layer: HighlightLayer;
  occlusion: OcclusionOutlineController;
  pipeline: DefaultRenderingPipeline;
  ui: QuestLoopUi;
  saveService: GameSaveService;
  /** 票 31：多槽服务（auto + slot-1..3）与自动存档策略。 */
  slotService: GameSaveSlotService;
  autoSaver: GameSaveAutoSaver;
  unsubscribeSessionEvents: () => void;
  saveSlotPanel: SaveSlotPanel | null;
  saveAvailable: boolean;
  navigation: GreenHollowNavigation;
  /** 点击移动经 navmesh 拆出的剩余路点；空表示没有排队中的路径。 */
  waypoints: Array<{ x: number; z: number }>;
  observer: Observer<Scene> | null;
  /** draw call 计数在帧结束后才有效，单独用 after-render 观察者采集。 */
  afterRenderObserver: Observer<Scene> | null;
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
    /** 网格化零件网格数（树/墙/桶/箱的全部零件）。 */
    meshedPartCount: number;
    /** 硬碰撞体数量。 */
    colliderCount: number;
  };
  /** 玩家当前所在灌木的遮挡强度（0–1）；ego-browser 断言用。 */
  bushOcclusion: { bushId: string | null; occlusion: number };
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
  /** 票 27：战斗反馈层（飘字/血条/顿帧/震屏/闪红），只消费订阅事件。 */
  feedback: CombatFeedbackLayer;
  /** 票 27：事件驱动的 CC0 音效；首次交互后解锁。 */
  audio: CombatAudio;
  /** 票 27：当前选中目标（目标圈常显的来源）。 */
  selectedEnemyId: string | null;
  /** 票 27：正在播放消散动画的敌人（id → 开始时刻）。 */
  dyingEnemies: Map<string, number>;
  /** 票 27：受击抖动（id → 结束时刻 + 方向）。 */
  hitReacts: Map<string, { until: number; dirX: number; dirZ: number }>;
  /** 票 27：选中目标并同步反馈层的目标圈常显。 */
  selectEnemy: (enemyId: string | null) => void;
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
  /** 票 31：四个槽位（含空槽）与展示用元数据。 */
  listSlots(): Promise<Array<{
    slotId: SaveSlotId;
    label: string;
    meta: { slotId: SaveSlotId; savedAtMs: number; playTimeMs: number; playerLevel: number } | null;
    snapshot: GameSessionSnapshot | null;
  }>>;
  saveToSlot(slotId: SaveSlotId): Promise<boolean>;
  loadFromSlot(slotId: SaveSlotId): Promise<boolean>;
  deleteSlot(slotId: SaveSlotId): Promise<void>;
  /** 票 31：手动触发一次「区域切换」自动存档路径。 */
  saveToAuto(): Promise<void>;
  getMeshPosition(entityId: string): { x: number; y: number; z: number } | null;
  /** 票 27：重击意图（1.5 倍伤害、8 秒冷却）。 */
  heavyAttackEnemy(enemyId: string): IntentResult;
  /** 票 27：反馈层状态（飘字/血条/顿帧/震屏/闪红）。 */
  getFeedback(): {
    activeNumbers: number;
    activeBars: number;
    hitStopRemainingMs: number;
    shakeRemainingMs: number;
    flashOpacity: number;
    selectedTargetId: string | null;
  };
  /** 票 27：当前选中目标（目标圈常显的来源）。 */
  setSelectedTarget(enemyId: string | null): void;
  /** 票 27：音效是否已解锁（首次交互后为 true）。 */
  isAudioUnlocked(): boolean;
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
  /** 世界质感证据（票 28）：网格化/碰撞/雾/景观/主光/NPC 待机/灌木可穿。 */
  getWorldEvidence(): {
    meshedPartCount: number;
    colliderCount: number;
    colliderKinds: string[];
    /** 灌木数量（保持 billboard 可穿）。 */
    bushCount: number;
    fogEnabled: boolean;
    fogStart: number;
    fogEnd: number;
    landscapeMeshCount: number;
    /** 场景中唯一启用的光源名与方向。 */
    keyLight: { name: string; direction: [number, number, number]; enabled: boolean } | null;
    enabledLightCount: number;
    keyLightElevationDegrees: number;
    keyLightAzimuthDegrees: number;
    npcIdleCount: number;
    npcPacingCount: number;
    bushOcclusion: { bushId: string | null; occlusion: number };
    playerAlpha: number;
  };
  /** 世界碰撞探针：把玩家视觉移到目标点并返回实际落点（撞树被挡）。 */
  probeCollision(x: number, z: number): {
    requested: { x: number; z: number };
    resolved: { x: number; z: number };
    blocked: boolean;
    blockedBy: string | null;
    /** 该点是否被硬碰撞体覆盖（灌木除外）。 */
    insideCollider: boolean;
  };
  /** 灌木可穿性探针：返回该点是否可通行（灌木不阻挡）。 */
  probePassable(x: number, z: number): { passable: boolean; blockedBy: string | null };
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
    meshedPartCount: number;
    colliderCount: number;
    landscapeMeshCount: number;
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
      cameraVerticalSpan(camera, CAMERA_VERTICAL_SPAN),
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
  // 票 28：暗角权重从 1.1 降到 0.35。原值在屏幕角落把景观剪影压成近黑，
  // 与「四方向无黑色虚无」的票面要求冲突（ego-browser 截图可见 V 形黑块）。
  pipeline.imageProcessing.vignetteWeight = 0.35;
  pipeline.imageProcessing.vignetteColor = new Color4(0.1, 0.11, 0.15, 0);

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
      baseTint: Color3.FromHexString(tint),
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
      baseTint: Color3.FromHexString(tint),
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
      (!entity.combat.alive || state.deadEnemies.has(entity.id)) &&
      !state.dyingEnemies.has(entity.id)
    ) {
      visual.node.setEnabled(false);
      continue;
    }
    if (state.dyingEnemies.has(entity.id)) {
      continue; // 消散动画接管位置/缩放。
    }
    visual.node.setEnabled(true);
    if (entity.identity.type === "enemy") {
      visual.node.position.set(entity.position.x, 0.45, entity.position.z);
    } else if (entity.identity.type === "npc") {
      // NPC：逻辑位置不变，视觉位置由 NpcIdleController 每帧叠加（呼吸/踱步）。
      // 这里只同步 Y 与朝向，避免覆盖待机演出的位移。
      visual.node.position.y = entity.position.y;
    } else {
      visual.node.position.set(
        entity.position.x,
        entity.position.y,
        entity.position.z,
      );
      // 玩家 glb 与程序化角色都要面向移动方向。glb 根节点可能带
      // rotationQuaternion（此时 rotation 不生效），先清掉再写 yaw。
      if (visual.node.rotationQuaternion !== null) {
        visual.node.rotationQuaternion = null;
      }
      visual.node.rotation.y =
        entity.rotation.y +
        (entity.identity.type === "player" ? PLAYER_MODEL_YAW_OFFSET : 0);
    }
  }
}

function clearWaypoints(state: P1WorldState): void {
  state.waypoints.length = 0;
}

/** 把下一个路点提交给逻辑层；到达后由 beforeRender 继续推进。 */
function advanceWaypoint(state: P1WorldState): void {
  const player = playerSnapshot(state.session);
  if (player === null || !player.combat.alive) {
    clearWaypoints(state);
    return;
  }
  while (state.waypoints.length > 0) {
    const next = state.waypoints.shift();
    if (next === undefined) {
      return;
    }
    if (Math.hypot(next.x - player.position.x, next.z - player.position.z) < 0.15) {
      continue;
    }
    state.session.moveTo(PLAYER_ID, { x: next.x, y: 0, z: next.z });
    return;
  }
}

/**
 * 点击移动入口：先用 navmesh 求路点，再逐个提交 moveTo。
 * 逻辑层快照仍是直线推进，但路点足够密/贴边，实际轨迹沿可行走面绕开障碍。
 */
function moveAlongNavMesh(
  state: P1WorldState,
  target: { x: number; z: number },
): void {
  const player = playerSnapshot(state.session);
  if (player === null || !player.combat.alive) {
    state.ui.setSaveStatus("角色倒下中，等待重生", "idle");
    return;
  }
  // 新点击总是取消旧路线；即使新目标不可达，也不继续沿旧路径走。
  clearWaypoints(state);
  const path = state.navigation.findPath(player.position, target);
  if (path === null || path.length === 0) {
    state.ui.setSaveStatus("无法到达该位置", "idle");
    return;
  }
  state.waypoints.push(...path);
  advanceWaypoint(state);
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
    clearWaypoints(state);
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

// ---------------------------------------------------------------------------
// 票 31：多槽读写删 + 选槽面板
// ---------------------------------------------------------------------------

/** 把某个槽的快照灌回当前会话（含视觉与死亡实体同步）。 */
async function restoreSlot(state: P1WorldState, slotId: SaveSlotId): Promise<boolean> {
  try {
    const contents = await state.slotService.readSlot(slotId);
    if (contents === null) {
      state.ui.setSaveStatus(`${slotLabel(slotId)} 是空槽`, "idle");
      return false;
    }
    state.session.restoreSnapshot(contents.snapshot);
    clearWaypoints(state);
    state.deadEnemies.clear();
    for (const entity of contents.snapshot.entities) {
      if (entity.identity.type === "enemy" && !entity.combat.alive) {
        state.deadEnemies.add(entity.id);
      }
    }
    syncVisualToSnapshot(state, state.session.snapshot());
    state.saveAvailable = true;
    state.ui.setSaveStatus(
      `已读取 ${slotLabel(slotId)} · Lv.${contents.meta.playerLevel} · 游玩 ${Math.round(
        contents.meta.playTimeMs / 1000,
      )}s`,
      "ok",
    );
    return true;
  } catch (error) {
    state.ui.setSaveStatus(`读档失败：${errorMessage(error)}`, "error");
    return false;
  }
}

async function writeSlot(state: P1WorldState, slotId: SaveSlotId): Promise<boolean> {
  try {
    const meta = await state.slotService.writeSlot(slotId, state.session.snapshot());
    state.saveAvailable = true;
    state.ui.setSaveStatus(
      `已写入 ${slotLabel(slotId)} · Lv.${meta.playerLevel}`,
      "ok",
    );
    return true;
  } catch (error) {
    state.ui.setSaveStatus(`存档失败：${errorMessage(error)}`, "error");
    return false;
  }
}

async function deleteSlot(state: P1WorldState, slotId: SaveSlotId): Promise<void> {
  try {
    await state.slotService.deleteSlot(slotId);
    state.ui.setSaveStatus(`${slotLabel(slotId)} 已删除`, "idle");
  } catch (error) {
    state.ui.setSaveStatus(`删除失败：${errorMessage(error)}`, "error");
  }
}

/** 选槽面板的数据源：四个槽位（含空槽）+ 展示用元数据。 */
async function slotEntries(state: P1WorldState) {
  const entries = await state.slotService.listSlots();
  return entries.map((entry) => ({
    slotId: entry.slotId,
    label: slotLabel(entry.slotId),
    meta: entry.meta,
    snapshot: entry.snapshot,
  }));
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
    if (event.type === "enemy-killed") {
      if (!state.deadEnemies.has(event.enemyId)) {
        // 消散动画：300ms 缩到 0 并微微上浮，结束后再彻底隐藏。
        state.dyingEnemies.set(event.enemyId, performance.now());
      }
      return;
    }
    if (event.type === "damage-dealt" && event.targetId !== PLAYER_ID) {
      const visual = state.visuals.get(event.targetId);
      if (visual === undefined || visual.baseTint === null) {
        return;
      }
      // 受击闪白：临时把 tint 拉到接近白色，160ms 后还原。
      const material = visual.procedural?.material;
      if (material !== undefined && material instanceof ShaderMaterial) {
        const toon = material;
        toon.setColor3("tintColor", Color3.White());
        window.setTimeout(() => {
          toon.setColor3("tintColor", visual.baseTint ?? Color3.White());
        }, 110);
      }
      // 轻微击退抖动：沿「攻击者 → 目标」方向偏移，160ms 内衰减。
      const attacker = state.visuals.get(event.attackerId);
      const dx = visual.node.position.x - (attacker?.node.position.x ?? visual.node.position.x);
      const dz = visual.node.position.z - (attacker?.node.position.z ?? visual.node.position.z);
      const length = Math.hypot(dx, dz) || 1;
      state.hitReacts.set(event.targetId, {
        until: performance.now() + 160,
        dirX: dx / length,
        dirZ: dz / length,
      });
    }
  });

  window.P1WorldDebug = {
    scenario: SCENARIO_NAME,
    getSnapshot: () => state.session.snapshot(),
    moveTo: (x, z) => moveAlongNavMesh(state, { x, z }),
    talkTo: (npcId) => {
      const result = state.session.tryTalkTo(npcId);
      if (!result.ok) {
        state.ui.setSaveStatus(`无法对话：${result.message ?? "未知原因"}`, "idle");
      }
    },
    chooseDialogueOption: (index) => state.session.chooseDialogueOption(index),
    attackEnemy: (enemyId) => {
      const result = state.session.tryAttack(PLAYER_ID, enemyId);
      if (!result.ok) {
        state.ui.setSaveStatus(`无法攻击：${result.message ?? "未知原因"}`, "idle");
      }
    },
    heavyAttackEnemy: (enemyId) => {
      // 前摇音效由 attack-windup-started 事件驱动（反馈层统一消费）。
      const result = state.session.tryHeavyAttack(PLAYER_ID, enemyId);
      if (!result.ok) {
        state.ui.setSaveStatus(`无法重击：${result.message ?? "未知原因"}`, "idle");
      }
      return result;
    },
    getFeedback: () => ({
      ...state.feedback.debugState(),
      selectedTargetId: state.selectedEnemyId,
    }),
    setSelectedTarget: (enemyId) => state.selectEnemy(enemyId),
    isAudioUnlocked: () => state.audio.isUnlocked,
    useItem: (instanceId) => state.session.tryUseItem(PLAYER_ID, instanceId),
    equipItem: (instanceId) => state.session.tryEquip(PLAYER_ID, instanceId),
    unequipItem: (instanceId) => state.session.tryUnequip(PLAYER_ID, instanceId),
    getPlayer: () => playerSnapshot(state.session),
    save: () => saveToStorage(state),
    load: () => loadFromStorage(state),
    clearSave: () => clearStoredSave(state),
    hasSave: () => state.saveService.hasSave(),
    listSlots: () => slotEntries(state),
    saveToSlot: (slotId) => writeSlot(state, slotId),
    loadFromSlot: (slotId) => restoreSlot(state, slotId),
    deleteSlot: (slotId) => deleteSlot(state, slotId),
    saveToAuto: () => state.autoSaver.notifyRegionChanged(),
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
    getWorldEvidence: () => {
      const enabledLights = scene.lights.filter((light) => light.isEnabled());
      const light = enabledLights[0] ?? null;
      // 只有 DirectionalLight 有 direction；HemisphericLight 没有。
      const direction =
        light instanceof DirectionalLight ? light.direction.normalize() : null;
      let npcPacingCount = 0;
      for (const controller of state.npcIdle.values()) {
        if (controller.isPacing) {
          npcPacingCount += 1;
        }
      }
      return {
        meshedPartCount: state.environment.meshedParts.length,
        colliderCount: state.colliders.length,
        colliderKinds: [...new Set(state.colliders.map((collider) => collider.kind))].sort(),
        bushCount: PROPS.filter((prop) => prop.kind === "bush").length,
        fogEnabled: scene.fogEnabled,
        fogStart: scene.fogStart,
        fogEnd: scene.fogEnd,
        landscapeMeshCount: state.landscape.meshes.length,
        keyLight:
          light === null
            ? null
            : {
                name: light.name,
                direction: direction
                  ? [round(direction.x, 4), round(direction.y, 4), round(direction.z, 4)]
                  : [0, 0, 0],
                enabled: light.isEnabled(),
              },
        enabledLightCount: enabledLights.length,
        keyLightElevationDegrees: round(keyLightElevationDegrees(), 2),
        keyLightAzimuthDegrees: round(keyLightAzimuthDegrees(), 2),
        npcIdleCount: state.npcIdle.size,
        npcPacingCount,
        bushOcclusion: {
          bushId: state.bushOcclusion.bushId,
          occlusion: round(state.bushOcclusion.occlusion, 4),
        },
        playerAlpha: round(state.player.meshes[0]?.visibility ?? 1, 4),
      };
    },
    probeCollision: (x, z) => {
      const from = {
        x: state.player.rootNode.position.x,
        z: state.player.rootNode.position.z,
      };
      const resolved = resolveMoveWithColliders(from, { x, z }, state.colliders);
      const inside = state.colliders.some((collider) =>
        isBlockedByCollider(collider, x, z),
      );
      return {
        requested: { x: round(x, 3), z: round(z, 3) },
        resolved: { x: round(resolved.x, 3), z: round(resolved.z, 3) },
        blocked: resolved.blocked,
        blockedBy: resolved.blockedBy,
        insideCollider: inside,
      };
    },
    probePassable: (x, z) => {
      const blocker = state.colliders.find((collider) => isBlockedByCollider(collider, x, z));
      return { passable: blocker === undefined, blockedBy: blocker?.id ?? null };
    },
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
      meshedPartCount: state.environmentMetrics.meshedPartCount,
      colliderCount: state.environmentMetrics.colliderCount,
      landscapeMeshCount: state.landscape.meshes.length,
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

    // 票 28：景观环带与主光同样是自检项——四方向无内容或光照方向错误直接失败，
    // 避免「黑色虚无/错误方向」这类只能靠截图发现的问题进入 L4。
    const landscapeIssues = validateLandscape();
    if (landscapeIssues.length > 0) {
      throw new Error(
        `边界景观自检失败：${landscapeIssues
          .map((issue) => `${issue.id}: ${issue.message}`)
          .join("；")}`,
      );
    }
    const lightIssues = validateKeyLight();
    if (lightIssues.length > 0) {
      throw new Error(
        `主光自检失败：${lightIssues
          .map((issue) => `${issue.id}: ${issue.message}`)
          .join("；")}`,
      );
    }

    // 票 30：真实 VRM 角色优先于占位角色。
    const playerCharacterUrl = REAL_CHARACTER_URL ?? PLACEHOLDER_URL;
    if (!playerCharacterUrl) {
      throw new Error(
        "缺少角色资产 assets/character_vroid_lod0.glb（npm run assets:real-character）" +
          "或 assets/character_anime_placeholder.glb（npm run assets:anime）",
      );
    }

    const root = new TransformNode("scenario.p1-world", scene);
    const camera = scene.activeCamera;
    const forward = camera
      ? camera.getDirection(new Vector3(0, 0, 1)).normalize()
      : new Vector3(-0.408, -0.816, 0.408).normalize();

    const environment = await createGreenHollowEnvironment(scene, root, forward);
    // 边界景观环带 + 渐暗雾 + 全场唯一主光（票 28）。
    const landscape = createLandscapeRing(scene, root);
    const keyLight = installUnifiedKeyLight(scene);
    installLandscapeFog(scene);
    // 硬碰撞体：树/石墙/木桶/木箱（灌木可穿，见 world-physics）。
    const colliders = buildPropColliders();
    const pipeline = createGradingPipeline(scene);
    const whiteTexture = createWhiteTexture(scene);

    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(CONTENT_BUNDLE, GREEN_HOLLOW_REGION_ID);
    const navigation = await createGreenHollowNavigation();

    const player = await loadPlayerCharacter(
      scene,
      playerCharacterUrl,
      playerCharacterUrl === REAL_CHARACTER_URL
        ? "character_vroid_lod0.glb"
        : "character_anime_placeholder.glb",
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
      baseTint: null,
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

    // NPC 待机演出：呼吸摆动 + 偶尔踱步（表现层，不写逻辑快照）。
    const npcIdle = new Map<string, NpcIdleController>();
    initialSnapshot.entities.forEach((entity, index) => {
      if (entity.identity.type !== "npc") {
        return;
      }
      const visual = visuals.get(entity.id);
      if (!visual) {
        return;
      }
      npcIdle.set(
        entity.id,
        new NpcIdleController({
          scene,
          node: visual.node,
          home: { x: entity.position.x, z: entity.position.z },
          seed: 1000 + index * 37,
        }),
      );
    });

    const layer = new HighlightLayer("layer.p1-world-occlusion", scene);
    // 环境 billboard 与网格件都是自绘 alpha-test / unlit 的 ShaderMaterial；
    // 把它们排除出高亮层，避免它们参与 glow 的深度/模板路径
    // （实测会导致高亮色被渲染成黑色）。
    for (const mesh of [
      ...environment.groundMeshes,
      ...environment.propMeshes,
      ...environment.meshedParts,
    ]) {
      layer.addExcludedMesh(mesh);
    }
    const occlusion = new OcclusionOutlineController(
      layer,
      environment.occluders.map((occluder) => occluder.box),
      forward,
    );

    const keyRatios = environment.keyStats.map((stats) => stats.transparentRatio);
    // 自动存档器在 state 构造期间就要拿到 slotService（闭包里晚调用即可），
    // 用 holder 打破这处循环引用。
    const holder: { state: P1WorldState } = {
      state: undefined as unknown as P1WorldState,
    };

    const state: P1WorldState = {
      root,
      session,
      visuals,
      deadEnemies: new Set<string>(),
      player,
      whiteTexture,
      environment,
      landscape,
      keyLight,
      colliders,
      npcIdle,
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
      slotService: new GameSaveSlotService(new IndexedDbSaveStorage()),
      autoSaver: new GameSaveAutoSaver({
        getSnapshot: () => session.snapshot(),
        writeAutoSlot: (slotId, snap) => holder.state.slotService.writeSlot(slotId, snap),
        onError: (error) => {
          // 自动存档失败不打断游戏，只在 HUD 状态行提示一次。
          holder.state.ui.setSaveStatus(`自动存档失败：${errorMessage(error)}`, "error");
        },
      }),
      unsubscribeSessionEvents: () => undefined,
      saveSlotPanel: null,
      saveAvailable: false,
      navigation,
      waypoints: [],
      observer: null,
      afterRenderObserver: null,
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
        meshedPartCount: environment.meshedParts.length,
        colliderCount: colliders.length,
      },
      bushOcclusion: { bushId: null, occlusion: 0 },
      instrumentation: new SceneInstrumentation(scene),
      lastDrawCalls: 0,
      occlusionTargets: [],
      probeHoldUntil: 0,
      previousHardwareScaling: engine.getHardwareScalingLevel(),
      feedback: null as unknown as CombatFeedbackLayer,
      audio: new CombatAudio(),
      selectedEnemyId: null,
      selectEnemy: () => undefined,
      dyingEnemies: new Map(),
      hitReacts: new Map(),
    };
    states.set(context, state);
    holder.state = state;

    // 票 27：反馈层与音效。音效预加载失败不阻断场景（视觉反馈仍可用）。
    state.audio = new CombatAudio();
    state.feedback = createCombatFeedbackLayer(session, {
      mount: document.body,
      audio: state.audio,
      resolveItemName: (itemId) =>
        CONTENT_BUNDLE.items.find((item) => item.id === itemId)?.displayName ?? itemId,
    });
    void state.audio.preloadAll();
    // 选中目标变化时同步到反馈层（目标圈常显）。
    state.selectEnemy = (enemyId: string | null): void => {
      state.selectedEnemyId = enemyId;
      state.feedback.setSelected(enemyId);
    };

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

    /** 重击按钮：对当前选中目标（或最近的活敌人）发起重击意图。 */
    const heavyAttack = (): IntentResult => {
      const entities = state.session.snapshot().entities;
      const targetId =
        state.selectedEnemyId ??
        entities.find(
          (entity) =>
            entity.identity.type === "enemy" &&
            entity.combat.alive &&
            !state.deadEnemies.has(entity.id),
        )?.id;
      if (targetId === undefined) {
        state.ui.setSaveStatus("周围没有可攻击的敌人", "idle");
        return { ok: false, message: "没有可攻击的敌人" };
      }
      const result = state.session.tryHeavyAttack(PLAYER_ID, targetId);
      if (result.ok) {
        state.ui.setSaveStatus(`重击 ${targetId}`, "ok");
      } else {
        state.ui.setSaveStatus(`无法重击：${result.message ?? "未知原因"}`, "idle");
      }
      return result;
    };

    state.ui = createQuestLoopUi({
      mount: document.body,
      bundle: CONTENT_BUNDLE,
      onChoose: (index) => session.chooseDialogueOption(index),
      onUseItem: (instanceId) => session.tryUseItem(PLAYER_ID, instanceId),
      onEquipItem: (instanceId) => session.tryEquip(PLAYER_ID, instanceId),
      onUnequipItem: (instanceId) => session.tryUnequip(PLAYER_ID, instanceId),
      onDebugKill: killNextEnemy,
      onHeavyAttack: () => heavyAttack(),
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

    // 票 31：会话事件 → 自动存档（任务状态变化 / 获得重要物品），
    // plus 区域切换与卸载兜底。
    state.unsubscribeSessionEvents = session.subscribe((event) => {
      void state.autoSaver.handleEvent(event);
    });
    state.autoSaver.attachBeforeUnload((handler) => {
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    });
    // 场景构建完成 = 区域已就绪，写一次自动槽作为初始进度点。
    await state.autoSaver.notifyRegionChanged();

    // 选槽面板：票 31 挂在 HUD，票 32 的主菜单复用同一数据源。
    state.saveSlotPanel = createSaveSlotPanel({
      mount: document.body,
      refresh: () => slotEntries(state),
      onLoad: async (slotId) => {
        await restoreSlot(state, slotId);
      },
      onSave: async (slotId) => {
        await writeSlot(state, slotId);
      },
      onDelete: async (slotId) => {
        await deleteSlot(state, slotId);
      },
      setStatus: (text, kind) => state.ui.setSaveStatus(text, kind),
    });

    // 画质档位：?quality=high|medium|low|auto（默认 auto = 动态分辨率）。
    const requestedQuality = parseQualityLevel(
      new URLSearchParams(window.location.search).get("quality"),
    );
    configureQuality(scene, state, requestedQuality);

    // 点击 NPC = 对话；点击敌人 = 发起攻击（GameSession 自动接近）；
    // 点击其他实体/地面 = 走过去。
    const pointerObserver = scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) {
        return;
      }
      // 浏览器自动播放策略：首次用户交互后才允许 AudioContext 发声。
      if (!state.audio.isUnlocked) {
        void state.audio.unlock();
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
          if (!session.canTalkTo(pickedId)) {
            state.ui.setSaveStatus(
              `${picked.identity.displayName} 现在没有可进行的对话`,
              "idle",
            );
            return;
          }
          const result = session.tryTalkTo(pickedId);
          if (!result.ok) {
            state.ui.setSaveStatus(`无法对话：${result.message ?? "未知原因"}`, "idle");
          }
          return;
        }
        if (picked?.identity.type === "enemy") {
          if (!picked.combat.alive) {
            state.selectEnemy(null);
            return;
          }
          const player = playerSnapshot(session);
          if (player === null || !player.combat.alive) {
            state.ui.setSaveStatus("角色倒下中，等待重生", "idle");
            return;
          }
          // 选中 = 目标圈常显；普攻是默认意图（重击走 HUD 按钮）。
          state.selectEnemy(pickedId);
          const result = session.tryAttack(PLAYER_ID, pickedId);
          if (!result.ok) {
            state.ui.setSaveStatus(`无法攻击：${result.message ?? "未知原因"}`, "idle");
          }
          return;
        }
        // 点到地面/其它实体：取消目标圈（走 A 由 moveTo 打断攻击意图）。
        state.selectEnemy(null);
        if (picked !== undefined) {
          moveAlongNavMesh(state, {
            x: picked.position.x,
            z: picked.position.z + 1.5,
          });
        }
        return;
      }
      const point = groundPoint(scene);
      if (point !== null) {
        moveAlongNavMesh(state, { x: point.x, z: point.z });
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

    // 票 27：把实体视觉注册为反馈层的投影锚点（只读位置，不写回）。
    for (const [id, visual] of visuals) {
      state.feedback.trackEntity(id, visual.node, visual.targetY + 0.35);
    }

    let lastFrameAt = performance.now();
    let lastUiUpdateAt = 0;
    let previousX = player.rootNode.position.x;
    let previousZ = player.rootNode.position.z;
    const observer = scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const deltaMs = Math.min(Math.max(now - lastFrameAt, 0), 100);
      lastFrameAt = now;

      // 反馈层先消费：顿帧会削减本帧实际推进给逻辑层的时间。
      const effectiveDelta = state.feedback.update(scene, deltaMs, now);
      session.advance(effectiveDelta);
      const snapshot = session.snapshot();
      // 路点队列：上一个 moveTo 到达（movement=null）后继续下一个。
      if (state.waypoints.length > 0) {
        const playerState = snapshot.entities.find(
          (entity) => entity.id === PLAYER_ID,
        );
        if (
          playerState === undefined ||
          !playerState.combat.alive ||
          playerState.movement === null
        ) {
          advanceWaypoint(state);
        }
      }
      syncVisualToSnapshot(
        state,
        snapshot,
        now < state.probeHoldUntil ? PLAYER_ID : null,
      );

      // 票 27：受击抖动（衰减位移）与击杀消散（缩小上浮）。
      for (const [entityId, react] of state.hitReacts) {
        const visual = state.visuals.get(entityId);
        if (visual === undefined || now >= react.until) {
          state.hitReacts.delete(entityId);
          continue;
        }
        const remaining = (react.until - now) / 160;
        const offset = 0.16 * remaining;
        visual.node.position.x += react.dirX * offset;
        visual.node.position.z += react.dirZ * offset;
      }
      for (const [entityId, startedAt] of state.dyingEnemies) {
        const visual = state.visuals.get(entityId);
        const progress = Math.min(1, (now - startedAt) / 300);
        if (visual !== undefined) {
          const scale = Math.max(0, 1 - progress);
          visual.node.scaling.set(scale, scale, scale);
          visual.node.position.y += progress * 0.35;
        }
        if (progress >= 1) {
          visual?.node.setEnabled(false);
          state.dyingEnemies.delete(entityId);
          state.deadEnemies.add(entityId);
        }
      }

      // 票 28：玩家视觉位置再过一遍硬碰撞求解。navmesh 已排除障碍，
      // 但逻辑层是直线推进，逐帧 moveTo 的插值可能切过障碍角；
      // 这里保证「玩家/敌人均不可穿」在渲染层也成立（灌木不在此列）。
      const playerState = snapshot.entities.find(
        (entity) => entity.id === PLAYER_ID,
      );
      if (playerState !== undefined && playerState.combat.alive) {
        const resolved = resolveMoveWithColliders(
          { x: previousX, z: previousZ },
          { x: player.rootNode.position.x, z: player.rootNode.position.z },
          state.colliders,
        );
        if (resolved.x !== player.rootNode.position.x) {
          player.rootNode.position.x = resolved.x;
        }
        if (resolved.z !== player.rootNode.position.z) {
          player.rootNode.position.z = resolved.z;
        }
      }

      // NPC 待机演出：呼吸摆动 + 偶尔踱步（只动视觉节点）。
      for (const [npcId, controller] of state.npcIdle) {
        const npc = snapshot.entities.find((entity) => entity.id === npcId);
        if (!npc) {
          continue;
        }
        controller.update(deltaMs, {
          x: npc.position.x,
          z: npc.position.z,
        });
      }

      // 灌木进入反馈：玩家在灌木内时轻微半透明（草丛机制视觉预留）。
      const bushes = PROPS.filter((prop) => prop.kind === "bush").map((prop) => ({
        id: prop.id,
        x: prop.x,
        z: prop.z,
      }));
      const proximity = bushOcclusionAt(
        player.rootNode.position.x,
        player.rootNode.position.z,
        bushes,
      );
      state.bushOcclusion = proximity;
      const alpha = bushAlphaForOcclusion(proximity.occlusion);
      for (const mesh of player.meshes) {
        mesh.visibility = alpha;
      }

      const dx = player.rootNode.position.x - previousX;
      const dz = player.rootNode.position.z - previousZ;
      previousX = player.rootNode.position.x;
      previousZ = player.rootNode.position.z;
      player.setMoving(Math.hypot(dx, dz) > 0.0005);
      player.update(deltaMs);

      state.occlusion.update(targets);

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
    state.afterRenderObserver = scene.onAfterRenderObservable.add(() => {
      state.lastDrawCalls = state.instrumentation.drawCallsCounter.current;
    });

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

    // 画质档位决定描边/分级是否开启；measure 的断言必须跟随当前档位，
    // 否则 ?quality=low 会把「功能按预期关闭」误判成 failed。
    const preset =
      state.quality.level === "auto" ? null : QUALITY_PRESETS[state.quality.level];
    const outlineExpected = preset === null || preset.outline;
    const gradingExpected = preset === null || preset.grading;

    // 1) 遮挡探针：把玩家视觉移到树后一帧，确认新区域的射线-OBB → HighlightLayer 通路。
    const probe = outlineExpected
      ? (window.P1WorldDebug?.probeOcclusion(0) ?? null)
      : null;

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
        // 票 28：网格化零件的零件网格数（树 4 + 墙 1 + 桶 4 + 箱 2 = 11 件/实例）。
        name: "meshedPartCount",
        value: state.environmentMetrics.meshedPartCount,
        unit: "meshes",
        threshold: 1,
        comparison: "gte",
      },
      {
        // 硬碰撞体数量 = 布局里树/墙/桶/箱的总数（当前 8 树 + 4 墙 + 2 桶 + 2 箱 = 16~17）；
        // 灌木不在此列。阈值取下界，防回归（某类件漏挂碰撞）。
        name: "colliderCount",
        value: state.environmentMetrics.colliderCount,
        unit: "colliders",
        threshold: 15,
        comparison: "gte",
      },
      {
        // 环带 = 1 块地面 + 8 座山丘 + 20 棵远景树 ×（树干 + 树冠）= 49 个网格。
        name: "landscapeMeshCount",
        value: state.landscape.meshes.length,
        unit: "meshes",
        threshold: 45,
        comparison: "gte",
      },
      {
        // 全场唯一主光：多于 1 说明有遗漏的默认光源没关掉。
        name: "enabledLightCount",
        value: scene.lights.filter((light) => light.isEnabled()).length,
        unit: "lights",
        threshold: 1,
        comparison: "eq",
      },
      {
        // 渐暗雾开启：四个方向不再出现黑色虚无。
        name: "fogEnabled",
        value: scene.fogEnabled ? 1 : 0,
        unit: "boolean",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "keyLightElevationDegrees",
        value: round(keyLightElevationDegrees(), 2),
        unit: "degrees",
      },
      {
        name: "keyLightAzimuthDegrees",
        value: round(keyLightAzimuthDegrees(), 2),
        unit: "degrees",
      },
      {
        name: "npcIdleCount",
        value: state.npcIdle.size,
        unit: "npcs",
        threshold: 2,
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
        // 平均仍是主判据（≤0.05ms）。performance.now() 在 Chrome 量化约 0.1ms，
        // 单帧 max 会随机测到 0.1/0.2ms；旧阈值 0.1ms 等于测量下限，验收时会偶发失败。
        // max 放宽到 0.5ms，只拦截数量级回归。
        name: "occlusionDetectionMsMax",
        value: round(detectionMax, 4),
        unit: "ms",
        threshold: 0.5,
        comparison: "lte",
      },
      {
        name: "occlusionProbeOutlined",
        value: probe?.outlined ?? 0,
        unit: "meshes",
        // low 档按设计关闭描边：只报告，不断言。
        ...(outlineExpected
          ? { threshold: 1, comparison: "gte" as const }
          : {}),
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
        // low 档关闭色彩分级：只报告，不断言。
        ...(gradingExpected
          ? { threshold: 1, comparison: "eq" as const }
          : {}),
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
    if (state.afterRenderObserver) {
      context.scene.onAfterRenderObservable.remove(state.afterRenderObserver);
    }
    state.ui.dispose();

    // 票 31：先摘掉卸载兜底与事件订阅，避免场景销毁过程中再写一次盘。
    state.autoSaver.detachBeforeUnload();
    state.unsubscribeSessionEvents();
    state.saveSlotPanel?.dispose();

    state.feedback.dispose();
    state.audio.dispose();

    state.occlusion.dispose();
    state.layer.dispose();

    for (const controller of state.npcIdle.values()) {
      controller.dispose();
    }
    for (const visual of state.visuals.values()) {
      visual.procedural?.dispose();
    }
    for (const material of state.materials) {
      material.dispose();
    }
    state.player.dispose();
    state.navigation.dispose();
    state.environment.dispose();
    // 票 28：景观环带 + 唯一主光 + 雾效清理；雾与光照恢复默认，
    // 否则会影响后续 scenario（共享 scene）。
    state.landscape.dispose();
    state.keyLight?.dispose();
    context.scene.fogEnabled = false;
    context.scene.fogMode = Scene.FOGMODE_NONE;
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
