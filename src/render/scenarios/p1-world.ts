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
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
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
import elderMaCompiled from "../../../content/dialogues/elder_ma.ink?ink";
import merchantBoCompiled from "../../../content/dialogues/merchant_bo.ink?ink";
import scoutLinCompiled from "../../../content/dialogues/scout_lin.ink?ink";
import smithQiCompiled from "../../../content/dialogues/smith_qi.ink?ink";
import levelCurveData from "../../../content/level-curves/standard.json";
import {
  GREEN_HOLLOW_REGION,
  SAMPLE_CONTENT_BUNDLE,
} from "../../logic/content/sample-content";
import type { ContentBundle } from "../../logic/content/types";
import type { CollectProgress } from "../../logic/exploration";
import type { LevelCurveDefinition } from "../../logic/leveling";
import {
  GameSession,
  type EntitySnapshot,
  type GameSessionSnapshot,
  type IntentResult,
} from "../../logic/game-session";
import {
  activateBubble,
  createInteractionState,
  interactionTarget,
  npcHoldFor,
  requestMove,
  selectNpc,
  setInteractionPhase,
  updateInteraction,
  type InteractionAction,
  type InteractionState,
  type InteractableInfo,
  type InteractableIndex,
} from "../../logic/interaction";
import { summarizeFrameTimes } from "../../logic/perf";
import type { Metric } from "../../logic/report";
import { GameSaveService } from "../../logic/save";
import { GameSaveSlotService, type SaveSlotId } from "../../logic/save-slots";
import { GameSaveAutoSaver } from "../../logic/save-autosave";
import { slotLabel } from "../../logic/save-slot-view";
import { createSaveSlotPanel, type SaveSlotPanel } from "../ui/save-slot-panel";
import {
  DEFAULT_CAMERA_VERTICAL_SPAN,
  advanceCameraFollow,
  applyCameraFollow,
  cameraVerticalSpan,
  createCameraFollow,
  snapCameraFollow,
  updateOrthographicFrustum,
  type CameraFollowState,
} from "../camera";
import type { ScenarioContext, ScenarioDefinition } from "../harness";
import { setCameraSpan, setGreyboxEnabled } from "../navmesh-scene";
import { IndexedDbSaveStorage } from "../persistence/indexed-db-save-storage";
import { createCollectHud, type CollectHud } from "../ui/collect-hud";
import { createQuestLoopUi, type QuestLoopUi } from "../ui/quest-loop-ui";
import {
  ISOMETRIC_PRESET,
  type CameraResetStart,
  advanceCameraReset,
  beginCameraReset,
  type CameraPreset,
  applyCameraRotate,
  applyCameraZoom,
} from "../camera-presets";
import {
  advanceChestVisual,
  animateCollectibleVisual,
  createChestVisual,
  createCollectibleVisual,
  type ChestVisual,
  type CollectibleVisual,
} from "../presentation/exploration-visuals";
import {
  loadExplorationTexture,
  type ExplorationTextureKind,
} from "../presentation/exploration-textures";
import { createDialogueUi, type DialogueUi } from "../ui/dialogue-portrait";
import { createTradeUi, type TradeUi } from "../ui/trade-panel";
import { takeTitleEntryIntent } from "../title-entry";
import {
  createProceduralNpc,
  createSlimeEnemy,
  createSpriteEnemy,
  loadPlayerCharacter,
  type PlayerCharacter,
  type ProceduralCharacter,
} from "../presentation/character-visuals";
import { getLoadingGate } from "../loadingGate";
import {
  createRegionRuntime,
  type RegionRuntime,
  type RegionRuntimeLayout,
} from "../presentation/region-runtime";
import {
  GREEN_HOLLOW_BOUNDS,
  GREEN_HOLLOW_REGION_ID,
  GROUND_PATCHES,
  PROPS,
  validateLayout,
  type PropPlacement,
} from "../presentation/green-hollow-layout";
import {
  SLIME_DEN_BOUNDS,
  SLIME_DEN_EXITS,
  SLIME_DEN_GROUND_PATCHES,
  SLIME_DEN_HILLS,
  SLIME_DEN_LANDSCAPE_BOUNDS,
  SLIME_DEN_PROPS,
  SLIME_DEN_REGION_ID,
  SLIME_DEN_TINT,
  SLIME_DEN_TREES,
  slimeDenTextureCoverage,
  slimeDenWaterPatch,
  validateSlimeDenLandscape,
  validateSlimeDenLayout,
} from "../presentation/slime-den-layout";
import {
  EXIT_TRIGGER_RADIUS,
  findTriggeredExit,
  type RegionLinkageExit,
} from "../../logic/region-linkage";
import {
  LANDSCAPE_BOUNDS as HOLLOW_LANDSCAPE_BOUNDS,
  LANDSCAPE_GROUND_COLOR,
  LANDSCAPE_HILL_COLOR,
  LANDSCAPE_HILLS as HOLLOW_HILLS,
  LANDSCAPE_TREE_COLOR,
  LANDSCAPE_TREES as HOLLOW_TREES,
} from "../presentation/world-physics";
import type { GreenHollowNavigation } from "../presentation/green-hollow-navigation";
import {
  createLandscapeRing,
  installLandscapeFog,
  installUnifiedKeyLight,
  type LandscapeVisuals,
} from "../presentation/landscape-ring";
import { NpcIdleController } from "../presentation/npc-idle";
import {
  projectWorldToCss,
  projectionViewportOf,
} from "../presentation/screen-projection";
import {
  advancePortalVisual,
  createPortalVisual,
  portalLabelFor,
  type PortalVisual,
} from "../presentation/portal-visuals";
import {
  bushesOf,
  planEntityVisualRebuild,
  type RegionContext,
} from "../presentation/region-context";
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
  DIALOGUE_ZOOM_DURATION_MS,
  dialogueDimStrength,
  dialogueZoomSpan,
} from "../ui/portrait-layout";
import {
  createCombatFeedbackLayer,
  type CombatFeedbackLayer,
} from "../presentation/combat-feedback";
import { CombatAudio } from "../presentation/combat-audio";
import { createToonMaterial } from "../anime/toonMaterial";
import { createWhiteTexture } from "../presentation/textures";
import { paletteOf, portraitUrlOf } from "../presentation/character-palettes";
import {
  loadEnemySprite,
  type EnemySpriteKind,
} from "../presentation/enemy-textures";
import {
  bushAlphaForOcclusion,
  bushOcclusionAt,
  isBlockedByCollider,
  keyLightAzimuthDegrees,
  keyLightElevationDegrees,
  resolveMoveWithColliders,
  validateKeyLight,
  validateLandscape,
} from "../presentation/world-physics";

const SCENARIO_NAME = "p1-world";
const PLAYER_ID = "entity:player";
/**
 * 占位 glb 的模型朝向偏移。逻辑层约定 rotation.y=0 朝 +Z（atan2(dx, dz)）；
 * 资产本身也朝 +Z，因此偏移为 0。若换资产后角色倒着走，只改这个常量。
 */
const PLAYER_MODEL_YAW_OFFSET = 0;
const CAMERA_VERTICAL_SPAN = 30;
/** 气泡锚点高出 NPC 视觉原点的高度（米）：在模型头顶之上留一点空隙。 */
const NPC_BUBBLE_HEAD_OFFSET_M = 0.6;
/**
 * 本场景的出厂等距预设（票 37）：几何沿用 camera.ts 的等距常量，
 * 可视高度沿用场景自己的 30m（p1-world 比 P0 灰盒看得更远）。
 * 复位按钮与 R 键都回这一位。
 */
const P1_WORLD_PRESET: CameraPreset = {
  ...ISOMETRIC_PRESET,
  id: "isometric-p1-world",
  verticalSpan: CAMERA_VERTICAL_SPAN,
};
const SAMPLE_DURATION_MS = 4_000;
/**
 * 区域切换黑场时长（毫秒）。淡入淡出各一次：正好盖住新区域的贴图抠白、
 * navmesh 构建与首帧上传，切换本身不会看到中间态。
 */
const REGION_FADE_MS = 420;
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

const CONTENT_BUNDLE: ContentBundle = SAMPLE_CONTENT_BUNDLE;

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
  scene: Scene;
  root: TransformNode;
  session: GameSession;
  visuals: Map<string, EntityVisual>;
  deadEnemies: Set<string>;
  player: PlayerCharacter;
  whiteTexture: BaseTexture;
  /** 当前区域的可视部分（票 35）：环境网格 + 硬碰撞体 + navmesh。 */
  runtime: RegionRuntime;
  /** 边界景观环带 + 渐暗雾（票 28）。 */
  landscape: LandscapeVisuals;
  /** 区域切换进行中（黑场期间为 true，输入意图被忽略）。 */
  traveling: boolean;
  /** 全场唯一主光（票 28；main.ts 的默认双光源已关闭）。 */
  keyLight: DirectionalLight | null;
  /**
   * 区域上下文（code-review 收敛项）：regionId + bounds + colliders + 灌木缓存。
   * 切区时整体替换，区域相关判定不再各自引用翠谷常量。
   */
  regionContext: RegionContext;
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
  /** 两段式对话交互状态（纯逻辑，见 src/logic/interaction.ts）。 */
  interaction: InteractionState;
  /** 当前被交互冻结的 NPC（approaching/ready）；null = 无。 */
  heldNpcId: string | null;
  /** galgame 立绘 + 气泡 UI（纯 DOM）。 */
  dialogueUi: DialogueUi;
  /** 票 33：商人交易面板（纯 DOM，独立于 quest-loop-ui）。 */
  tradeUi: TradeUi;
  /** 票 33：当前打开摊位的商人 NPC id；null = 摊位没开。 */
  tradeNpcId: string | null;
  /** 最近一次对话的 NPC（ink 走完时快照里的 dialogue 已是 null，靠它开摊位）。 */
  lastTalkedNpcId: string | null;
  /** 票 33：安全区地面色块（敌人拒止区的可视化）。 */
  safeZoneMarks: Mesh[];
  /** 对话镜头推近进度 0–1；0 = 常规全景。 */
  zoomProgress: number;
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
  /** 票 36：逻辑层投射物的渲染节点（id → 网格）；位置每次从快照同步。 */
  projectileVisuals: Map<string, Mesh>;
  projectileMaterial: Material;
  /** 票 36：敌人精灵贴图的抠白透明占比，写入场景证据。 */
  enemySpriteRatio: number;
  /** 票 36：敌人精灵贴图（按 AI 档案种类索引），创建视觉时传入。 */
  enemySprites: Map<EnemySpriteKind, BaseTexture>;
  /** 票 37：宝箱视觉（id → 视觉）。开启状态由会话判定。 */
  chestVisuals: Map<string, ChestVisual>;
  /** 票 37：收集品视觉（id → 视觉）；已捡的节点整组关闭。 */
  collectibleVisuals: Map<string, CollectibleVisual>;
  /** 票 37：探索件精灵贴图的抠白透明占比，写入场景报告。 */
  explorationSpriteRatio: number;
  /** 票 37：收集计数 HUD。 */
  collectHud: CollectHud | null;
  /** code-review #32：收集进度缓存（结构性开销大，事件后置脏再算）。 */
  collectProgressCache: CollectProgress[] | null;
  /** 票 37：相机复位插值的起点；null 表示当前不在复位动画中。 */
  cameraReset: CameraResetStart | null;
  /** 票 37：复位动画已推进的时长（毫秒）。 */
  cameraResetElapsedMs: number;
  /** 票 37：相机拖拽旋转的按键（右键/中键）；按住期间不触发点击交互。 */
  cameraDragButton: number | null;
  cameraDragLastX: number;
  cameraDragLastY: number;
  /** 票 37：解除拖拽与快捷键绑定的清理函数。 */
  detachCameraInput: () => void;
  /**
   * 票 37 验收修复：相机跟随。正交相机下 target 平移 = 视野平移，
   * alpha/beta/radius（缩放/旋转/复位）与震屏都原样保留。
   */
  cameraFollow: CameraFollowState;
  /**
   * 票 37 验收修复：区域出口的视觉标记（洞口几何/地面圈/头顶标记/光环）。
   * 按出口 id 索引，切区时整体重建。
   */
  portalVisuals: Map<string, PortalVisual>;
}

/**
 * 探索进度证据（L4 冒烟断言用；window.P1WorldDebug 的返回结构，
 * 仓库内无 TS 引用，故不导出——code-review #34）。
 */
interface ExplorationEvidence {
  chests: Array<{
    id: string;
    opened: boolean;
    loot: Array<{ itemId: string; quantity: number }>;
  }>;
  collectibles: Array<{ id: string; collected: boolean; itemId: string }>;
  progress: Array<{
    setId: string;
    collected: number;
    total: number;
    complete: boolean;
    rewardGranted: boolean;
  }>;
  rewardInBag: boolean;
}

/** 相机机位证据（同上，不导出）。 */
interface CameraFramingEvidence {
  alpha: number;
  beta: number;
  radius: number;
  verticalSpan: number;
}

/** ego-browser 验证入口：只经 snapshot 读取、只经意图写入（不导出）。 */
interface P1WorldDebugApi {
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
  /** 票 34：等级进度（等级/累计经验/距下一级）。 */
  getLevelProgress(): { level: number; cumulativeXp: number; xpToNext: number | null };
  /** 票 34：发放经验（走击杀奖励同一条结算路径），L4 冒烟用来补足曲线阈值。 */
  grantExperience(amount: number): void;
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
  /**
   * 票 35：当前区域 id；走到路口时逐帧自动触发区域切换。
   * `tryTravel` 是显式触发（ego-browser 冒烟用，等价于走到路口）。
   */
  getRegion(): { regionId: string | null; traveling: boolean; exits: Array<{ id: string; targetRegionId: string; x: number; z: number }> };
  /**
   * 票 37 验收修复：出口视觉与相机跟随的证据（L4 冒烟断言用）。
   *
   * `portalMeshCount > 0` 即证明当前区域的出口不是「零视觉」；
   * `playerInView` 用相机 target 与玩家距离 + 半屏宽高判断玩家是否在画面内。
   */
  getPortalEvidence(): {
    portalCount: number;
    portals: Array<{
      id: string;
      meshCount: number;
      label: string;
      position: { x: number; z: number };
      markerAboveLintel: boolean;
    }>;
    /** 南边土路是否铺到洞口（判断路是否与视觉连通）。 */
    southPathReachesExit: boolean;
    cameraFollow: { x: number; z: number };
    playerInView: boolean;
  };
  /** 相机跟随是否已收敛到玩家（误差 <0.5m）。 */
  isCameraOnPlayer(tolerance?: number): boolean;
  /** 显式触发一次区域切换（x/z 缺省用玩家当前逻辑位置）。 */
  tryTravel(x?: number, z?: number): Promise<string | null>;
  /** 传送到指定区域（按该区域某个出口的坐标触发，L4 双向冒烟用）。 */
  travelToExit(targetRegionId: string): Promise<string | null>;
  /** 区域相关证据：两区域的网格/碰撞/出口规模与自动存档后的区域 id。 */
  getRegionEvidence(): Promise<{
    regionId: string | null;
    landscapeMeshCount: number;
    meshedPartCount: number;
    colliderCount: number;
    exitCount: number;
    gateMasked: boolean;
    autoSaveRegionId: string | null;
  }>;
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
  /**
   * 票 33：村庄安全区证据。
   * zones = 逻辑层的安全区定义；playerSheltered = 玩家当前是否在区内；
   * 敌人位置用于断言「区内时敌人不追入」。
   */
  getVillageEvidence(): {
    zones: Array<{
      id: string;
      center: { x: number; z: number };
      halfExtents: { x: number; z: number };
    }>;
    /** 地面标记网格数（每个安全区 = 1 块填充 + 4 条边界）。 */
    markCount: number;
    playerSheltered: boolean;
    playerPosition: { x: number; z: number };
    enemyPositions: Array<{ id: string; x: number; z: number }>;
    /** 每个 NPC 的逻辑位置与巡逻进度（快照字段 patrolIndex）。 */
    npcPositions: Array<{
      id: string;
      x: number;
      z: number;
      patrolIndex: number | null;
    }>;
    /** NPC 的巡逻采样（表现层演出状态）。 */
    patrolSamples: Array<{ id: string; moving: boolean; yaw: number }>;
  };
  /** 票 33：交易面板当前状态与报价（供 L4 断言买卖闭环）。 */
  getTradeEvidence(): {
    open: boolean;
    npcId: string | null;
    coins: number;
    lastMessage: string;
    rows: Array<{
      itemId: string;
      displayName: string;
      kind: "sell" | "buy";
      unitPrice: number;
      maxSellQuantity: number;
      maxBuyQuantity: number;
      broke: boolean;
      atMaxStack: boolean;
    }>;
  };
  /** 票 33：直接走一次买卖（等价于点面板上的「全卖」/「买 1」）。 */
  trade(kind: "sell" | "buy", itemId: string, quantity: number): {
    ok: boolean;
    quantity?: number;
    coinDelta?: number;
    message?: string;
  };
  /** 直接打开某 NPC 的摊位（等价于与商人对话走完后自动开摊）。 */
  openStall(npcId: string): boolean;
  /**
   * 票 33：完成任务（接取 → 击杀推进 → 复命）走真实对话路径。
   * L4 用它验证换锚点：换锚点必须在真实任务流程里发生，不给后门。
   */
  completeQuestThroughDialogue(): boolean;
  /**
   * 票 33：直接发物品（L4 造战利品/铜币走这个正式入口）。
   * 等价于掉落/任务奖励的同一个 addItem 通道，不绕过结算。
   */
  grantItem(itemId: string, quantity: number): string[];
  closeStall(): void;
  /** 票 36：两种新敌人的 AI 状态 + 投射物 + 死亡惩罚证据。 */
  getEnemyAiEvidence(): {
    enemies: Array<{
      id: string;
      templateId: string;
      aiState: string | null;
      hp: number;
      position: { x: number; z: number };
    }>;
    projectiles: Array<{ id: string; ownerId: string; position: { x: number; z: number } }>;
    enemySpriteTransparentRatio: number;
    enemySpriteTextures: string[];
    colliderCount: number;
    coins: number;
  };
  /* ---- 探索回报（票 37）---- */
  /** 调试传送：把玩家直接放到 (x, z)，推进逻辑层到位（只给 L4 冒烟用）。 */
  teleportTo(x: number, z: number): void;
  /** 开箱；chestId 缺省用第一个宝箱。返回是否真的开了（已开/距离不够为 false）。 */
  openChest(chestId?: string): boolean;
  /** 拾取收集品；collectibleId 缺省用第一个未捡的。 */
  collect(collectibleId?: string): boolean;
  /** 探索进度证据（ego-browser 断言用）：开箱数、收集计数、全收集奖励。 */
  getExploration(): ExplorationEvidence;
  /** 相机机位（ego-browser 断言缩放/旋转/复位）。 */
  getCamera(): CameraFramingEvidence;
  /** 缩放/旋转相机（notches>0 拉远，deltaPixels 为拖拽位移）。 */
  zoomCamera(notches: number): void;
  rotateCamera(deltaPixelsX: number, deltaPixelsY: number): void;
  /** 一键复位回出厂等距预设（平滑插值，返回是否已经开始复位）。 */
  resetCamera(): boolean;
  /** 两段式交互：点击远处 NPC（只靠近不出气泡）。 */
  interactNpc(npcId: string): void;
  /** 第二段：点击头顶气泡，开对话（双方互转面对面 + 立绘）。 */
  activateBubble(): void;
  /** 当前交互阶段与气泡内容（ego-browser 断言两段式流程）。 */
  getInteraction(): {
    phase: string;
    npcId: string | null;
    bubble: "talk" | "quest" | null;
    dialogueOpen: boolean;
    portraitSides: Array<{ entityId: string; speaking: boolean; brightness: number }>;
    cameraSpan: number;
    dimStrength: number;
  };
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
  /**
   * 票 32：新游戏——回到区域的初始状态（丢弃当前进度）。
   * 旧的自动/手动槽不动；新游戏后的自动存档会覆盖 auto 槽。
   */
  startNewGame(): { playerLevel: number; elapsedMs: number };
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

/** 从网格 metadata 里读一个字符串字段（探索视觉没有逻辑实体 id）。 */
function metadataString(mesh: AbstractMesh | null, key: string): string | null {
  const metadata = mesh?.metadata as Record<string, unknown> | undefined;
  const value = metadata?.[key];
  return typeof value === "string" && value !== "" ? value : null;
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

/**
 * 吐弹型敌人的投射物材质（票 36）：孢子绿球 + 自发光色。
 * 投射物的位置/速度/命中判定全在逻辑层，这里只画一个球。
 */
function createProjectileMaterial(scene: Scene): ShaderMaterial {
  return createToonMaterial(scene, "material.projectile", null, {
    useVertexColors: false,
    tint: Color3.FromHexString("#a6e85a"),
    rimStrength: 1.1,
  });
}

function createEntityVisual(
  scene: Scene,
  root: TransformNode,
  state: Pick<P1WorldState, "whiteTexture" | "materials" | "enemySprites">,
  entity: EntitySnapshot,
): EntityVisual {
  const id = entity.id;
  let visual: EntityVisual;
  if (entity.identity.type === "player") {
    throw new Error("玩家视觉必须在会话初始化后单独创建");
  }

  if (entity.identity.type === "npc") {
    // 票 29：3D tint 取自角色色板卡主色，与立绘/对话框同源。
    const palette = paletteOf(id);
    const procedural = createProceduralNpc(
      scene,
      root,
      `${id}.`,
      Color3.FromHexString(palette.primary),
      state.whiteTexture,
    );
    state.materials.push(procedural.material);
    procedural.mesh.metadata = { entityId: id };
    visual = {
      node: procedural.mesh,
      mesh: procedural.mesh,
      targetY: 0.55,
      procedural,
      // 票 27：基础色调（受击闪白等反馈要恢复到它），同源取色板卡主色。
      baseTint: Color3.FromHexString(palette.primary),
    };
  } else {
    // 票 36：冲锋型/吐弹型走各自的独立精灵贴图；史莱姆仍是程序化球体。
    const spriteKind = ENEMY_SPRITE_KINDS.get(entity.identity.templateId);
    const spriteTexture =
      spriteKind === undefined ? undefined : state.enemySprites.get(spriteKind);
    if (spriteTexture !== undefined) {
      const procedural = createSpriteEnemy(scene, root, `${id}.`, spriteTexture);
      state.materials.push(procedural.material);
      procedural.mesh.metadata = { entityId: id };
      visual = {
        node: procedural.mesh,
        mesh: procedural.mesh,
        targetY: spriteKind === "ranged-kite" ? 0.71 : 0.74,
        procedural,
        baseTint: null,
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
  }

  return visual;
}

/**
 * 敌人精灵路由（票 36）：模板 → AI 档案种类 → 独立贴图。
 * 保持在一处，内容新增同类敌人时只改这张表。
 */
const ENEMY_SPRITE_KINDS = new Map<string, EnemySpriteKind>([
  ["enemy_template:charger", "windup-charge"],
  ["enemy_template:spitter", "ranged-kite"],
]);

/** 投射物节点池：新建/复用/回收，跟随逻辑层快照。 */
function syncProjectileVisuals(state: P1WorldState): void {
  const { scene } = state;
  const alive = new Set<string>();
  for (const projectile of state.session.projectileSnapshots()) {
    alive.add(projectile.id);
    let mesh = state.projectileVisuals.get(projectile.id);
    if (mesh === undefined || mesh.isDisposed()) {
      mesh = MeshBuilder.CreateSphere(
        `projectile.${projectile.id}`,
        { diameter: projectile.radius * 2, segments: 8 },
        scene,
      );
      mesh.material = state.projectileMaterial;
      mesh.parent = state.root;
      mesh.isPickable = false;
      state.projectileVisuals.set(projectile.id, mesh);
    }
    mesh.setEnabled(true);
    mesh.position.set(
      projectile.position.x,
      projectile.position.y + 0.55,
      projectile.position.z,
    );
  }
  for (const [id, mesh] of state.projectileVisuals) {
    if (alive.has(id)) {
      continue;
    }
    mesh.dispose();
    state.projectileVisuals.delete(id);
  }
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
      visual.node.position.set(entity.position.x, visual.targetY, entity.position.z);
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

/** 两段式对话：可交互实体表（是否有对话 / 是否有可接任务）。 */
function interactableIndex(session: GameSession): InteractableIndex {
  const snapshot = session.snapshot();
  const questsByNpc = new Map<string, boolean>();
  for (const quest of snapshot.quests) {
    if (quest.status === "available") {
      questsByNpc.set(quest.giverNpcId, true);
    }
  }
  const index = new Map<string, InteractableInfo>();
  for (const entity of snapshot.entities) {
    if (entity.identity.type !== "npc") {
      continue;
    }
    index.set(entity.id, {
      hasDialogue: session.canTalkTo(entity.id),
      hasQuest: questsByNpc.get(entity.id) ?? false,
    });
  }
  return index;
}

function entityPositions(session: GameSession): Map<string, { x: number; y: number; z: number }> {
  return new Map(
    session.snapshot().entities.map((entity) => [entity.id, entity.position]),
  );
}

/**
 * 把交互状态机的「冻结请求」同步到会话的 NPC 巡逻暂停。
 *
 * 记下当前被冻结的 NPC：状态机每次只带一个 npcId，切换目标时要把上一个
 * 解冻。这里不做引用计数——交互是单目标语义，一个时刻最多冻结一个。
 */
function syncNpcHold(state: P1WorldState): void {
  const hold = npcHoldFor(state.interaction);
  const nextId = hold === null ? null : hold.npcId;
  if (state.heldNpcId === nextId) {
    return;
  }
  if (state.heldNpcId !== null) {
    state.session.setNpcPaused(state.heldNpcId, false);
  }
  if (nextId !== null) {
    state.session.setNpcPaused(nextId, true);
  }
  state.heldNpcId = nextId;
}

/** 执行交互状态机给出的动作（提交意图 + UI 同步）。 */
function applyInteractionAction(
  state: P1WorldState,
  action: InteractionAction,
): void {
  switch (action.kind) {
    case "approach":
      moveAlongNavMesh(state, { x: action.target.x, z: action.target.z });
      break;
    case "arrived":
      state.ui.setSaveStatus("走到面前了：点击头顶气泡开始对话", "idle");
      break;
    case "start-dialogue":
      startDialogue(state, action.npcId);
      break;
    case "end-dialogue":
      state.session.endDialogue();
      break;
    case "none":
      break;
  }
}

/** 票 33：村庄里的商人 NPC id（内容里唯一带 vendor 的那位）。 */
const MERCHANT_NPC_ID = "npc:merchant_bo";

/**
 * 票 33：一次买卖。只经会话的 try* 意图结算，面板自己不碰背包；
 * 结算后用 vendorOffer 刷新（价格/持有量/金币都从同一条报价路径来）。
 */
function trade(
  state: P1WorldState,
  kind: "sell" | "buy",
  itemId: string,
  quantity: number,
): void {
  const npcId = state.tradeNpcId;
  if (npcId === null) {
    return;
  }
  const result =
    kind === "sell"
      ? state.session.trySellToVendor(npcId, itemId, quantity)
      : state.session.tryBuyFromVendor(npcId, itemId, quantity);
  if (!result.ok) {
    state.tradeUi.setMessage(`交易未成：${result.message ?? "未知原因"}`);
    return;
  }
  const delta = result.coinDelta ?? 0;
  const coinText = delta >= 0 ? `+${delta}` : `${delta}`;
  state.tradeUi.setMessage(`${kind === "sell" ? "卖出" : "买入"} ${result.quantity ?? 0} 个 · 铜币 ${coinText}`);
  const offer = state.session.vendorOffer(npcId);
  if (offer !== null) {
    state.tradeUi.refresh(offer);
  }
}

/** 关闭摊位：对话早已结束（摊位是挂在商人旁边的独立面板）。 */
function closeTrade(state: P1WorldState): void {
  state.tradeUi.close();
  state.tradeNpcId = null;
}

/**
 * 票 33：对话对象是商人且对话结束时打开摊位。
 * 这是「对话状态机里商人对话结束后可开交易」的兑现点：ink 走完 → 摊位开。
 */
function openTradeIfVendor(state: P1WorldState, npcId: string): void {
  const offer = state.session.vendorOffer(npcId);
  if (offer === null) {
    return;
  }
  state.tradeNpcId = npcId;
  state.tradeUi.open(offer);
}

/**
 * 票 33：安全区可视化 = 淡色地面填充 + 四条边界线。
 * 只画地面这一层，不做围墙几何：地形是关卡美术的事，这里只把
 * 「敌人拒止的边界在哪」标出来，方便 L4 断言与人工核对。
 */
function createSafeZoneMarks(
  scene: Scene,
  zones: readonly {
    id: string;
    center: { x: number; z: number };
    halfExtents: { x: number; z: number };
  }[],
): Mesh[] {
  const marks: Mesh[] = [];
  const fillMaterial = new StandardMaterial("safezone.fill.material", scene);
  fillMaterial.diffuseColor = Color3.FromHexString("#fde68a");
  fillMaterial.emissiveColor = Color3.FromHexString("#f59e0b").scale(0.25);
  fillMaterial.alpha = 0.1;
  fillMaterial.disableLighting = true;

  const edgeMaterial = new StandardMaterial("safezone.edge.material", scene);
  edgeMaterial.emissiveColor = Color3.FromHexString("#fbbf24");
  edgeMaterial.disableLighting = true;

  const EDGE = 0.18;
  for (const zone of zones) {
    const fill = MeshBuilder.CreateGround(
      `safezone.${zone.id}.fill`,
      { width: zone.halfExtents.x * 2, height: zone.halfExtents.z * 2 },
      scene,
    );
    fill.position.set(zone.center.x, 0.03, zone.center.z);
    fill.isPickable = false;
    fill.material = fillMaterial;
    fill.metadata = { safeZoneId: zone.id };
    marks.push(fill);

    // 四条边界：细长条地面，只在边界线上（内缘贴齐矩形边界）。
    const edges: Array<{ width: number; height: number; dx: number; dz: number }> = [
      {
        width: zone.halfExtents.x * 2 + EDGE,
        height: EDGE,
        dx: 0,
        dz: -zone.halfExtents.z,
      },
      {
        width: zone.halfExtents.x * 2 + EDGE,
        height: EDGE,
        dx: 0,
        dz: zone.halfExtents.z,
      },
      {
        width: EDGE,
        height: zone.halfExtents.z * 2,
        dx: -zone.halfExtents.x,
        dz: 0,
      },
      {
        width: EDGE,
        height: zone.halfExtents.z * 2,
        dx: zone.halfExtents.x,
        dz: 0,
      },
    ];
    edges.forEach((edge, index) => {
      const line = MeshBuilder.CreateGround(
        `safezone.${zone.id}.edge${index}`,
        { width: edge.width, height: edge.height },
        scene,
      );
      line.position.set(
        zone.center.x + edge.dx,
        0.05,
        zone.center.z + edge.dz,
      );
      line.isPickable = false;
      line.material = edgeMaterial;
      line.metadata = { safeZoneId: zone.id };
      marks.push(line);
    });
  }
  return marks;
}

/** 第二段：双方互转面对面 → 开对话 → 立绘 + 镜头推近。 */
function startDialogue(state: P1WorldState, npcId: string): void {
  const result = state.session.tryTalkTo(npcId);
  if (!result.ok) {
    state.ui.setSaveStatus(`无法对话：${result.message ?? "未知原因"}`, "idle");
    return;
  }
  state.session.faceNpc(PLAYER_ID, npcId);
  state.lastTalkedNpcId = npcId;
  const snapshot = state.session.snapshot();
  const dialogue = snapshot.dialogue;
  if (dialogue === null) {
    return;
  }
  state.dialogueUi.openDialogue(dialogue.npcId, PLAYER_ID, dialogue.text, dialogue.choices);
  syncVisualToSnapshot(state, snapshot);
}

/** 对话结束（ink 走完 / 移动打断 / 走开）：恢复镜头与 UI。 */
function closeDialoguePresentation(state: P1WorldState): void {
  // 票 33：商人对话结束 → 顺势开摊位（对话是交易的前置动作，不是替代品）。
  const endedNpcId = state.session.snapshot().dialogue?.npcId ?? state.lastTalkedNpcId;
  state.dialogueUi.closeDialogue();
  if (endedNpcId !== null && endedNpcId !== undefined) {
    openTradeIfVendor(state, endedNpcId);
  }
  // 交互阶段同步复位：对话可能由 ink 自然结束（选完选项后故事走到 END），
  // 此时没有移动意图触发 requestMove，状态机会停在 talking。
  // 不复位会让下一次点击 NPC 被「已有对话」逻辑拒绝。
  setInteractionPhase(state.interaction, createInteractionState());
}

/** 每帧推进交互状态机 + 气泡投影 + 对话镜头。 */
function updateInteractionPresentation(state: P1WorldState, scene: Scene, deltaMs: number): void {
  const session = state.session;
  const interactables = interactableIndex(session);
  const positions = entityPositions(session);
  const action = updateInteraction(
    state.interaction,
    positions,
    interactables,
    PLAYER_ID,
    deltaMs,
  );
  applyInteractionAction(state, action);

  // NPC 冻结（票 37 验收）：approaching / ready 阶段让对方停下等玩家，
  // 否则玩家追不上巡逻中的 NPC，ready 后 NPC 走出 2m 气泡还会直接消失。
  // 复用对话冻结走的那条 setNpcPaused 通路（逻辑层一个真相源）。
  syncNpcHold(state);

  // 气泡投影：NPC 头顶（视觉位置 + 目标高度）→ 屏幕坐标。
  const npcId = state.interaction.npcId;
  const bubbleKind = state.interaction.bubble;
  const bubbleVisual = npcId === null ? undefined : state.visuals.get(npcId);
  const camera = scene.activeCamera;
  const snapshotPosition = npcId === null ? undefined : positions.get(npcId);
  if (
    bubbleKind === null ||
    npcId === null ||
    bubbleVisual === undefined ||
    snapshotPosition === undefined ||
    camera === null
  ) {
    state.dialogueUi.setBubble(null);
  } else {
    // 锚点取**逻辑快照位置**（x/z）而不是 bubbleVisual.node.position：
    // 后者被 NpcIdleController 每帧改写（踱步/呼吸偏移），用它当锚点会
    // 让气泡跟着待机演出抖，与对话判定用的距离对不上。
    // y 与头顶高度仍来自视觉（视觉才知道模型多高）。
    const head = new Vector3(
      snapshotPosition.x,
      snapshotPosition.y + bubbleVisual.targetY + NPC_BUBBLE_HEAD_OFFSET_M,
      snapshotPosition.z,
    );
    // 投影直接用 CSS 像素视口（DOM 气泡是 CSS 像素定位的，
    // 原先按 getRenderWidth 投影会在 dpr=2 时飘出画面，见 screen-projection）。
    const projected = projectWorldToCss(
      head,
      scene.getTransformMatrix(),
      projectionViewportOf(
        scene.getEngine(),
        scene.getEngine().getRenderingCanvas(),
      ),
    );
    state.dialogueUi.setBubble({
      npcId,
      kind: bubbleKind,
      x: projected.x,
      y: projected.y,
    });
  }

  // 对话内容变化（说话方/文本/选项）→ 立绘与对话框刷新。
  const dialogue = session.snapshot().dialogue;
  if (state.dialogueUi.isOpen()) {
    if (dialogue === null) {
      closeDialoguePresentation(state);
    } else {
      state.dialogueUi.updateDialogue(dialogue.text, dialogue.choices, dialogue.npcId);
    }
  }

  // 镜头推近/恢复：对话进行中趋向目标 span，结束后回到常规全景。
  const zoomTarget = session.snapshot().dialogue !== null ? 1 : 0;
  const step = Math.min(1, deltaMs / DIALOGUE_ZOOM_DURATION_MS);
  const next = state.zoomProgress + (zoomTarget - state.zoomProgress) * step;
  if (Math.abs(next - state.zoomProgress) > 1e-4) {
    state.zoomProgress = next;
    const span = dialogueZoomSpan(CAMERA_VERTICAL_SPAN, state.zoomProgress);
    setCameraSpan(scene, span);
  }
}

/* ------------------------------------------------------------------ */
/* 探索回报（票 37）：宝箱 / 收集品 / 相机                              */
/* ------------------------------------------------------------------ */

/** 站到探索件旁边：走到它的交互距离内（宝箱与收集品用同一个距离口径）。 */
function walkToExploration(
  state: P1WorldState,
  position: { x: number; y: number; z: number },
): void {
  const player = playerSnapshot(state.session);
  if (player === null) {
    return;
  }
  const target = interactionTarget(position, player.position);
  applyInteractionAction(state, requestMove(state.interaction));
  moveAlongNavMesh(state, { x: target.x, z: target.z });
}

/** 走到（或直接）开箱：距离内立刻开，否则先走过去。 */
function interactWithChest(state: P1WorldState, chestId: string): void {
  const chest = state.session.chestDefinitions().find((entry) => entry.id === chestId);
  if (chest === undefined) {
    return;
  }
  const player = playerSnapshot(state.session);
  if (player === null || !player.combat.alive) {
    state.ui.setSaveStatus("角色倒下中，等待重生", "idle");
    return;
  }
  if (state.session.isChestOpened(chestId)) {
    state.ui.setSaveStatus(`${chest.displayName} 已经空了`, "idle");
    return;
  }
  const result = state.session.tryOpenChest(PLAYER_ID, chestId);
  if (result.ok) {
    state.ui.setSaveStatus(`打开了 ${chest.displayName}`, "ok");
    return;
  }
  walkToExploration(state, chest.position);
  state.ui.setSaveStatus(`走向 ${chest.displayName}…`, "idle");
}

/** 走到（或直接）拾取收集品。 */
function interactWithCollectible(state: P1WorldState, collectibleId: string): void {
  const collectible = state.session
    .collectibleDefinitions()
    .find((entry) => entry.id === collectibleId);
  if (collectible === undefined) {
    return;
  }
  const player = playerSnapshot(state.session);
  if (player === null || !player.combat.alive) {
    state.ui.setSaveStatus("角色倒下中，等待重生", "idle");
    return;
  }
  const result = state.session.tryCollectCollectible(PLAYER_ID, collectibleId);
  if (result.ok) {
    invalidateCollectProgressCache(state);
    return;
  }
  walkToExploration(state, collectible.position);
  state.ui.setSaveStatus("走向收集品…", "idle");
}

/** 每帧同步探索视觉：宝箱盖子的开合动画 + 收集品的呼吸与拾取后隐藏。 */
function updateExplorationVisuals(state: P1WorldState, elapsedMs: number, dtMs: number): void {
  for (const [chestId, visual] of state.chestVisuals) {
    advanceChestVisual(visual, dtMs, state.session.isChestOpened(chestId) ? 1 : 0);
  }
  for (const [collectibleId, visual] of state.collectibleVisuals) {
    if (state.session.isCollectibleCollected(collectibleId)) {
      visual.root.setEnabled(false);
      continue;
    }
    animateCollectibleVisual(visual, elapsedMs);
  }
}

/**
 * 探索事实签名：worldState 里 chest:/collectible: 条目的摘要。
 * 冒烟脚本用它判断「这次交互是否真的落地了开箱/拾草」。
 */
function explorationSignature(worldState: Record<string, unknown>): string {
  return Object.keys(worldState)
    .filter((key) => key.startsWith("chest:") || key.startsWith("collectible:"))
    .sort()
    .map((key) => `${key}=${JSON.stringify(worldState[key])}`)
    .join("|");
}

/** 收集计数 HUD 的内容包显示名表。 */
/** 会话实体数期望值：玩家 + 内容包里的 NPC/敌人（探索件不是实体，不计入）。 */
const EXPECTED_ENTITY_COUNT =
  1 +
  CONTENT_BUNDLE.npcs.length +
  CONTENT_BUNDLE.enemies.filter((enemy) => enemy.regionId === GREEN_HOLLOW_REGION_ID).length;

const COLLECT_SET_NAMES = new Map(
  (CONTENT_BUNDLE.collectSets ?? []).map((set) => [set.id, set.displayName]),
);

/**
 * 相机自由化（票 37）：滚轮缩放 + 右键/中键拖拽旋转 + 一键复位。
 * 输入全部自己接管（相机的 Babylon inputs 是 clear 掉的），范围夹取在
 * camera-presets.ts；这里只做「把浏览器事件翻译成相机操作」。
 */
function installCameraInput(state: P1WorldState, scene: Scene): () => void {
  const canvas = scene.getEngine().getRenderingCanvas();
  const aspect = () => {
    const engine = scene.getEngine();
    return engine.getRenderHeight() > 0 ? engine.getRenderWidth() / engine.getRenderHeight() : 1;
  };

  const onWheel = (event: WheelEvent): void => {
    const camera = scene.activeCamera as ArcRotateCamera | null;
    if (camera === null) {
      return;
    }
    event.preventDefault();
    applyCameraZoom(camera, Math.sign(event.deltaY), CAMERA_VERTICAL_SPAN, aspect());
    state.cameraReset = null;
    state.feedback.setCameraShakeEnabled(true);
  };

  const onPointerDown = (event: PointerEvent): void => {
    // 只有右键/中键才是相机拖拽；左键仍然留给点击交互。
    if (event.button !== 2 && event.button !== 1) {
      return;
    }
    const camera = scene.activeCamera as ArcRotateCamera | null;
    if (camera === null) {
      return;
    }
    event.preventDefault();
    state.cameraReset = null;
    state.feedback.setCameraShakeEnabled(true);
    state.cameraDragButton = event.button;
    state.cameraDragLastX = event.clientX;
    state.cameraDragLastY = event.clientY;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (state.cameraDragButton === null) {
      return;
    }
    const camera = scene.activeCamera as ArcRotateCamera | null;
    if (camera === null) {
      return;
    }
    applyCameraRotate(camera, event.clientX - state.cameraDragLastX, event.clientY - state.cameraDragLastY);
    state.cameraDragLastX = event.clientX;
    state.cameraDragLastY = event.clientY;
  };

  const onPointerUp = (): void => {
    state.cameraDragButton = null;
  };

  // code-review #12：拖拽中断兜底——pointercancel（触摸被系统接管）
  // 与窗口失焦时把拖拽状态清零，否则相机停在拖拽中、点击交互被永久吞掉。
  const cancelDrag = (): void => {
    state.cameraDragButton = null;
  };

  const onContextMenu = (event: Event): void => {
    // 右键拖拽旋转需要吃掉默认右键菜单，否则每次旋转都弹菜单。
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "r" || event.key === "R") {
      requestCameraReset(state, scene);
    }
  };

  const target = canvas ?? window;
  target.addEventListener("wheel", onWheel as EventListener, { passive: false });
  target.addEventListener("pointerdown", onPointerDown as EventListener);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", cancelDrag);
  window.addEventListener("blur", cancelDrag);
  target.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);

  return () => {
    target.removeEventListener("wheel", onWheel as EventListener);
    target.removeEventListener("pointerdown", onPointerDown as EventListener);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", cancelDrag);
    window.removeEventListener("blur", cancelDrag);
    target.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("keydown", onKeyDown);
  };
}

/** 一键复位：把相机平滑插值回出厂等距预设。 */
function requestCameraReset(state: P1WorldState, scene: Scene): void {
  const camera = scene.activeCamera as ArcRotateCamera | null;
  if (camera === null) {
    return;
  }
  // 复位是**平滑插值**（updateCameraReset 每帧按时长推进），不是瞬移。
  state.cameraReset = beginCameraReset(camera, P1_WORLD_PRESET, CAMERA_VERTICAL_SPAN);
  state.cameraResetElapsedMs = 0;
  // 复位期间关掉震屏：震屏往 camera.alpha 加随机抖动，会让「回到预设值」永远差一点。
  state.feedback.setCameraShakeEnabled(false);
  state.ui.setSaveStatus("视角回到默认等距…", "ok");
}

function aspectRatioOf(scene: Scene): number {
  const engine = scene.getEngine();
  return engine.getRenderHeight() > 0 ? engine.getRenderWidth() / engine.getRenderHeight() : 1;
}

/**
 * 重建当前区域的出口视觉标记（票 37 验收修复）。
 *
 * 洞口几何 + 地面提示圈 + 头顶标记 + 呼吸光环；出口位置来自
 * `exitsForRegion`（content 的 exits 是权威），因此内容加一个出口，
 * 渲染层自动多一处标记，零额外配置。
 */
function rebuildPortalVisuals(state: P1WorldState, scene: Scene): void {
  for (const visual of state.portalVisuals.values()) {
    visual.root.dispose(false, true);
  }
  state.portalVisuals.clear();
  exitsForRegion(state.session.currentRegionId).forEach((exit, index) => {
    state.portalVisuals.set(
      exit.id,
      createPortalVisual(scene, state.root, exit.id, { x: exit.position.x, z: exit.position.z }, index),
    );
  });
}

/** 每帧推进出口标记的呼吸/漂浮动画。 */
function updatePortalVisuals(state: P1WorldState, now: number): void {
  for (const visual of state.portalVisuals.values()) {
    advancePortalVisual(visual, now, 0);
  }
}

/**
 * 每帧推进相机跟随（票 37 验收修复）。
 *
 * target 向玩家阻尼插值（lerp 0.08，60fps 下约 0.3s 收敛），
 * 直接写 camera.target —— 不走 setTarget 的 alpha/beta 反解，
 * 因此票 37 的缩放/旋转/复位与票 27 的震屏都不会被跟随打断。
 */
function updateCameraFollowStep(state: P1WorldState, scene: Scene): void {
  const camera = scene.activeCamera as ArcRotateCamera | null;
  if (camera === null) {
    return;
  }
  const player = playerSnapshot(state.session);
  if (player === null || !player.combat.alive) {
    return;
  }
  advanceCameraFollow(state.cameraFollow, { x: player.position.x, z: player.position.z });
  applyCameraFollow(camera, state.cameraFollow);
}

/** 传送/读档/切区后把相机直接对齐玩家（不留长镜头）。 */
function snapCameraToPlayer(state: P1WorldState): void {
  const player = playerSnapshot(state.session);
  if (player === null) {
    return;
  }
  snapCameraFollow(state.cameraFollow, { x: player.position.x, z: player.position.z });
}

/** 每帧推进相机复位插值。 */
function updateCameraReset(state: P1WorldState, scene: Scene, dtMs: number): void {
  const start = state.cameraReset;
  if (start === null) {
    return;
  }
  const camera = scene.activeCamera as ArcRotateCamera | null;
  if (camera === null) {
    state.cameraReset = null;
    return;
  }
  state.cameraResetElapsedMs += dtMs;
  const settled = advanceCameraReset(
    camera,
    start,
    P1_WORLD_PRESET,
    state.cameraResetElapsedMs,
    aspectRatioOf(scene),
  );
  if (settled) {
    state.cameraReset = null;
    state.cameraResetElapsedMs = 0;
    state.feedback.setCameraShakeEnabled(true);
  }
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
    // 票 35：存档可能来自另一个区域（例如区域 2 的自动存档）。
    // 先把场景切到存档所在区域，再恢复快照——否则 restoreSnapshot 会
    // 因为「快照区域与当前已加载区域不一致」而拒绝。
    if (
      snapshot.regionId !== null &&
      snapshot.regionId !== state.session.currentRegionId
    ) {
      const entered = await enterRegionForSnapshot(state, snapshot.regionId);
      if (entered === null) {
        state.ui.setSaveStatus(
          `存档属于 ${snapshot.regionId}，但该区域没有渲染布局`,
          "error",
        );
        return false;
      }
    }
    state.session.restoreSnapshot(snapshot);
    // 票 37 验收修复：读档后相机直接落到玩家位置（跟随状态从 0 追过去
    // 会变成一段十几秒的长镜头）。
    snapCameraToPlayer(state);
    invalidateCollectProgressCache(state);
    clearWaypoints(state);
    // 读档不保留「靠近中/气泡待点」这类会话内交互阶段；对话本身由
    // ink 快照恢复，下一帧 updateInteraction 会重新判定气泡显隐。
    setInteractionPhase(state.interaction, createInteractionState());
    closeDialoguePresentation(state);
    state.zoomProgress = 0;
    const scene = state.player.rootNode.getScene();
    setCameraSpan(scene, CAMERA_VERTICAL_SPAN);
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
    // 存档中带进行中的对话：恢复 galgame 立绘与镜头（存读档不回归）。
    if (restored.dialogue !== null) {
      state.session.faceNpc(PLAYER_ID, restored.dialogue.npcId);
      state.dialogueUi.openDialogue(
        restored.dialogue.npcId,
        PLAYER_ID,
        restored.dialogue.text,
        restored.dialogue.choices,
      );
      syncVisualToSnapshot(state, state.session.snapshot());
    }
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
    // 票 35：同 loadFromStorage——先切到存档所在区域再恢复。
    if (
      contents.snapshot.regionId !== null &&
      contents.snapshot.regionId !== state.session.currentRegionId
    ) {
      const entered = await enterRegionForSnapshot(state, contents.snapshot.regionId);
      if (entered === null) {
        state.ui.setSaveStatus(`存档属于未配置的区域`, "error");
        return false;
      }
    }
    state.session.restoreSnapshot(contents.snapshot);
    snapCameraToPlayer(state);
    invalidateCollectProgressCache(state);
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

/**
 * 票 32：新游戏 = 把会话恢复到区域的初始状态。
 *
 * 语义上是「丢弃当前进度」而不是「删档」：旧的手动槽原样留着，玩家随时
 * 能从标题画面选回来；auto 槽会在新游戏落定后被下一次自动存档接管
 * （标题画面的二次确认文案已说明这一点）。
 */
function startNewGame(state: P1WorldState): { playerLevel: number; elapsedMs: number } {
  const fresh = new GameSession();
  fresh.registerDialogue("elder_ma", elderMaCompiled);
  fresh.registerDialogue("merchant_bo", merchantBoCompiled);
  fresh.registerDialogue("scout_lin", scoutLinCompiled);
  fresh.registerDialogue("smith_qi", smithQiCompiled);
  fresh.loadRegion(CONTENT_BUNDLE, GREEN_HOLLOW_REGION_ID);
  const snapshot = fresh.snapshot();

  state.session.restoreSnapshot(snapshot);
  // 新游戏重置：相机回到出生点，跟随状态一起归零。
  snapCameraToPlayer(state);
  invalidateCollectProgressCache(state);
  clearWaypoints(state);
  state.deadEnemies.clear();
  state.dyingEnemies.clear();
  state.hitReacts.clear();
  state.selectedEnemyId = null;
  state.selectEnemy(null);
  state.feedback.clearTransient();
  setInteractionPhase(state.interaction, createInteractionState());
  closeDialoguePresentation(state);
  state.zoomProgress = 0;
  const scene = state.player.rootNode.getScene();
  setCameraSpan(scene, CAMERA_VERTICAL_SPAN);
  syncVisualToSnapshot(state, state.session.snapshot());
  state.ui.update(state.session.snapshot());
  state.ui.setSaveStatus("新游戏：进度已重置", "ok");
  const result = state.session.playerLevelProgress();
  return { playerLevel: result.level, elapsedMs: state.session.snapshot().elapsedMs };
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
    teleportTo(x: number, z: number): void {
      // 走「快照往返」而不是几百帧 moveTo：后者会把玩家送进敌人的仇恨范围
      // 打空血后被重生回村落打乱位置。快照往返还顺带保留了 worldState/背包。
      const snapshot = state.session.snapshot();
      const player = snapshot.entities.find((entity) => entity.id === PLAYER_ID);
      if (player === undefined) {
        return;
      }
      player.position = { x, y: 0, z };
      player.movement = null;
      state.session.restoreSnapshot(snapshot);
      // 传送后再把生命拉满：冒烟只验证探索与相机，不该被敌人打死。
      const healed = state.session.snapshot();
      const healedPlayer = healed.entities.find((entity) => entity.id === PLAYER_ID);
      if (healedPlayer !== undefined) {
        healedPlayer.combat.hp = healedPlayer.combat.maxHp;
        state.session.restoreSnapshot(healed);
      }
      // 硬碰撞求解：落点在树/墙旁时吸附到可站立处（渲染层每帧做同一件事）。
      const current = state.session.snapshot();
      const position = current.entities.find((entity) => entity.id === PLAYER_ID)?.position;
      if (position !== undefined) {
        const resolved = resolveMoveWithColliders(position, { x, z }, state.regionContext.colliders, {
          bounds: state.regionContext.bounds,
        });
        const final = state.session.snapshot();
        const finalPlayer = final.entities.find((entity) => entity.id === PLAYER_ID);
        if (finalPlayer !== undefined) {
          finalPlayer.position = { x: resolved.x, y: 0, z: resolved.z };
          finalPlayer.movement = null;
          state.session.restoreSnapshot(final);
        }
      }
      syncVisualToSnapshot(state, state.session.snapshot());
    },
    openChest(chestId?: string): boolean {
      const target =
        chestId ??
        state.session.chestDefinitions().find((chest) => !state.session.isChestOpened(chest.id))?.id;
      if (target === undefined) {
        return false;
      }
      const chest = state.session.chestDefinitions().find((entry) => entry.id === target);
      if (chest !== undefined) {
        // 冒烟直接落位到交互距离内，不走寻路往返（寻路由点击移动用例覆盖）。
        window.P1WorldDebug?.teleportTo(chest.position.x + 1, chest.position.z);
      }
      const before = explorationSignature(state.session.getWorldState());
      interactWithChest(state, target);
      return explorationSignature(state.session.getWorldState()) !== before;
    },
    collect(collectibleId?: string): boolean {
      const target =
        collectibleId ??
        state.session
          .collectibleDefinitions()
          .find((entry) => !state.session.isCollectibleCollected(entry.id))?.id;
      if (target === undefined) {
        return false;
      }
      const collectible = state.session
        .collectibleDefinitions()
        .find((entry) => entry.id === target);
      if (collectible !== undefined) {
        window.P1WorldDebug?.teleportTo(collectible.position.x + 1, collectible.position.z);
      }
      const before = explorationSignature(state.session.getWorldState());
      interactWithCollectible(state, target);
      return explorationSignature(state.session.getWorldState()) !== before;
    },
    getExploration(): ExplorationEvidence {
      const snapshot = state.session.snapshot();
      const player = snapshot.entities.find((entity) => entity.id === PLAYER_ID);
      const rewardItemId = CONTENT_BUNDLE.collectSets?.[0]?.rewardItemId ?? "";
      return {
        chests: state.session.chestDefinitions().map((chest) => ({
          id: chest.id,
          opened: state.session.isChestOpened(chest.id),
          loot: chest.loot,
        })),
        collectibles: state.session.collectibleDefinitions().map((entry) => ({
          id: entry.id,
          collected: state.session.isCollectibleCollected(entry.id),
          itemId: entry.itemId,
        })),
        progress: state.session.allCollectProgress(),
        rewardInBag:
          rewardItemId !== "" &&
          (player?.container.items ?? []).some((item) => item.templateId === rewardItemId),
      };
    },
    getCamera(): CameraFramingEvidence {
      const camera = scene.activeCamera as ArcRotateCamera | null;
      if (camera === null) {
        return { alpha: 0, beta: 0, radius: 0, verticalSpan: CAMERA_VERTICAL_SPAN };
      }
      return {
        alpha: round(camera.alpha, 6),
        beta: round(camera.beta, 6),
        radius: round(camera.radius, 6),
        verticalSpan: round(cameraVerticalSpan(camera, CAMERA_VERTICAL_SPAN), 4),
      };
    },
    zoomCamera(notches: number): void {
      const camera = scene.activeCamera as ArcRotateCamera | null;
      if (camera !== null) {
        applyCameraZoom(camera, notches, CAMERA_VERTICAL_SPAN, aspectRatioOf(scene));
      }
    },
    rotateCamera(deltaPixelsX: number, deltaPixelsY: number): void {
      const camera = scene.activeCamera as ArcRotateCamera | null;
      if (camera !== null) {
        applyCameraRotate(camera, deltaPixelsX, deltaPixelsY);
      }
    },
    resetCamera(): boolean {
      requestCameraReset(state, scene);
      return state.cameraReset !== null;
    },
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
    getLevelProgress: () => state.session.playerLevelProgress(),
    grantExperience: (amount) => state.session.grantExperience(PLAYER_ID, amount),
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
    startNewGame: () => startNewGame(state),
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
    getRegion: () => ({
      regionId: state.session.currentRegionId,
      traveling: state.traveling,
      exits: exitsForRegion(state.session.currentRegionId).map((exit) => ({
        id: exit.id,
        targetRegionId: exit.targetRegionId,
        x: exit.position.x,
        z: exit.position.z,
      })),
    }),
    tryTravel: async (x?: number, z?: number) => {
      const player = playerSnapshot(state.session);
      const target =
        x === undefined || z === undefined
          ? { x: player?.position.x ?? 0, z: player?.position.z ?? 0 }
          : { x, z };
      return travelToRegion(state, scene, target);
    },
    travelToExit: async (targetRegionId) => {
      // 直接用目标区域里指回当前区域的那个出口坐标触发往返。
      const exit = CONTENT_BUNDLE.regions
        .flatMap((region) => region.exits ?? [])
        .find((entry) => entry.targetRegionId === targetRegionId);
      if (exit === undefined) {
        throw new Error(`没有指回 ${targetRegionId} 的出口`);
      }
      return travelToRegion(state, scene, {
        x: exit.position.x,
        z: exit.position.z,
      });
    },
    getRegionEvidence: async () => {
      const entries = await state.slotService.listSlots();
      const auto = entries.find((entry) => entry.slotId === "auto");
      return {
        regionId: state.session.currentRegionId,
        landscapeMeshCount: state.landscape.meshes.length,
        meshedPartCount: state.runtime.environment.meshedParts.length,
        colliderCount: state.runtime.colliders.length,
        exitCount: exitsForRegion(state.session.currentRegionId).length,
        gateMasked: getLoadingGate().isMasked(),
        autoSaveRegionId: auto?.snapshot?.regionId ?? null,
      };
    },
    getOcclusion: () => ({
      occluded: [...state.occlusion.occludedIds],
      outlined: state.occlusion.outlinedCount,
      detectionMs: round(state.occlusion.detectionMs, 3),
    }),
    probeOcclusion: (holdMs = 0) => {
      // 用低矮石墙做探针：角色上半身可见，描边高亮在截图里更清楚。
      const occluder = propsForRegion(state.session.currentRegionId).find(
        (prop) => prop.id === "prop.wall.north-west",
      ) ?? propsForRegion(state.session.currentRegionId).find((prop) => prop.kind === "stone-wall");
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
    getPortalEvidence: () => {
      const portals = [...state.portalVisuals.values()].map((visual) => {
        const marker = visual.marker;
        const lintel = visual.meshes.find((mesh) => mesh.name.includes(".lintel"));
        return {
          id: visual.exitId,
          meshCount: visual.meshes.length,
          label: portalLabelFor(visual.exitId),
          // 零件用世界坐标摆位（parent 节点在原点），直接读 marker 的位置。
          position: {
            x: round(marker?.position.x ?? visual.root.position.x, 3),
            z: round(marker?.position.z ?? visual.root.position.z, 3),
          },
          markerAboveLintel:
            marker !== null && lintel !== undefined
              ? marker.position.y > lintel.position.y
              : false,
        };
      });
      const player = playerSnapshot(state.session);
      const camera = scene.activeCamera as ArcRotateCamera | null;
      let playerInView = false;
      if (camera !== null && player !== null) {
        const span = cameraVerticalSpan(camera, CAMERA_VERTICAL_SPAN);
        const aspect = aspectRatioOf(scene);
        // 正交：target 与玩家在 target 平移方向上的差小于半屏即可见。
        const dx = Math.abs(player.position.x - state.cameraFollow.x);
        const dz = Math.abs(player.position.z - state.cameraFollow.z);
        playerInView = dx < (span * aspect) / 2 && dz < span / 2;
      }
      const southPath = GREEN_HOLLOW_RUNTIME_LAYOUT.groundPatches.find(
        (patch) => patch.id === "ground.dirt.south",
      );
      const caveExit = (GREEN_HOLLOW_REGION.exits ?? []).find(
        (exit) => exit.id === "exit:cave_mouth",
      );
      return {
        portalCount: portals.length,
        portals,
        southPathReachesExit:
          southPath !== undefined &&
          caveExit !== undefined &&
          southPath.z + southPath.depth / 2 >= caveExit.position.z - EXIT_TRIGGER_RADIUS,
        cameraFollow: {
          x: round(state.cameraFollow.x, 3),
          z: round(state.cameraFollow.z, 3),
        },
        playerInView,
      };
    },
    isCameraOnPlayer: (tolerance = 0.5) => {
      const player = playerSnapshot(state.session);
      if (player === null) {
        return false;
      }
      return (
        Math.hypot(
          player.position.x - state.cameraFollow.x,
          player.position.z - state.cameraFollow.z,
        ) <= tolerance
      );
    },
    blink: (holdMs = 500) => state.player.triggerBlink(holdMs),
    getEnemyAiEvidence: () => {
      const snapshot = state.session.snapshot();
      const player = snapshot.entities.find((entity) => entity.id === PLAYER_ID);
      return {
        enemies: snapshot.entities
          .filter((entity) => entity.identity.type === "enemy")
          .map((entity) => ({
            id: entity.id,
            templateId: entity.identity.templateId,
            aiState: entity.combat.aiState,
            hp: entity.combat.hp,
            position: { x: round(entity.position.x, 3), z: round(entity.position.z, 3) },
          })),
        projectiles: state.session.projectileSnapshots().map((projectile) => ({
          id: projectile.id,
          ownerId: projectile.ownerId,
          position: {
            x: round(projectile.position.x, 3),
            z: round(projectile.position.z, 3),
          },
        })),
        enemySpriteTransparentRatio: round(state.enemySpriteRatio, 4),
        enemySpriteTextures: [...state.enemySprites.values()].map((texture) => texture.name),
        colliderCount: state.regionContext.colliders.length,
        coins:
          player?.container.items
            .filter((item) => item.templateId === "item:old_coin")
            .reduce((sum, item) => sum + item.quantity, 0) ?? 0,
      };
    },
    interactNpc: (npcId) => {
      // 两段式第一段：只靠近（远处）或出气泡（距离内），不开对话。
      const player = playerSnapshot(state.session);
      const npc = state.session.snapshot().entities.find((entity) => entity.id === npcId);
      if (player === null || npc === undefined) {
        state.ui.setSaveStatus(`无法交互：${npcId}`, "idle");
        return;
      }
      const action = selectNpc(
        state.interaction,
        npcId,
        interactableIndex(state.session),
        player.position,
        npc.position,
      );
      applyInteractionAction(state, action);
    },
    activateBubble: () => {
      const action = activateBubble(
        state.interaction,
        entityPositions(state.session),
        interactableIndex(state.session),
        PLAYER_ID,
      );
      applyInteractionAction(state, action);
    },
    getInteraction: () => {
      const scene2 = scene;
      const camera = scene2.activeCamera;
      const dialogueOpen = state.session.snapshot().dialogue !== null;
      const visuals: Array<{ entityId: string; speaking: boolean; brightness: number }> = [];
      if (dialogueOpen) {
        const dialogue = state.session.snapshot().dialogue!;
        const npcFrame = document.querySelector<HTMLElement>(
          `[data-testid="dialogue-portrait"][data-entity-id="${dialogue.npcId}"]`,
        );
        const playerFrame = document.querySelector<HTMLElement>(
          `[data-testid="dialogue-portrait"][data-entity-id="${PLAYER_ID}"]`,
        );
        for (const frame of [npcFrame, playerFrame]) {
          if (frame === null) {
            continue;
          }
          visuals.push({
            entityId: frame.dataset.entityId ?? "",
            speaking: frame.dataset.speaking === "true",
            brightness: Number(frame.dataset.brightness ?? "0"),
          });
        }
      }
      return {
        phase: state.interaction.phase,
        npcId: state.interaction.npcId,
        bubble: state.interaction.bubble,
        dialogueOpen,
        portraitSides: visuals,
        cameraSpan:
          camera === null
            ? 0
            : round(cameraVerticalSpan(camera, CAMERA_VERTICAL_SPAN), 3),
        dimStrength: round(dialogueDimStrength(state.zoomProgress), 3),
      };
    },
    getVillageEvidence: () => {
      const snapshot = state.session.snapshot();
      const player = snapshot.entities.find((entity) => entity.id === PLAYER_ID);
      return {
        zones: state.session.getSafeZones().map((zone) => ({
          id: zone.id,
          center: { x: zone.center.x, z: zone.center.z },
          halfExtents: { x: zone.halfExtents.x, z: zone.halfExtents.z },
        })),
        markCount: state.safeZoneMarks.length,
        playerSheltered: state.session.playerIsSheltered(),
        playerPosition: player
          ? { x: round(player.position.x, 3), z: round(player.position.z, 3) }
          : { x: 0, z: 0 },
        enemyPositions: snapshot.entities
          .filter((entity) => entity.identity.type === "enemy" && entity.combat.alive)
          .map((entity) => ({
            id: entity.id,
            x: round(entity.position.x, 3),
            z: round(entity.position.z, 3),
          })),
        npcPositions: snapshot.entities
          .filter((entity) => entity.identity.type === "npc")
          .map((entity) => ({
            id: entity.id,
            x: round(entity.position.x, 3),
            z: round(entity.position.z, 3),
            patrolIndex: entity.patrolIndex ?? null,
          })),
        patrolSamples: snapshot.entities
          .filter((entity) => entity.identity.type === "npc")
          .map((entity) => {
            const sample = state.session.patrolSampleOf(entity.id);
            return {
              id: entity.id,
              moving: sample?.moving ?? false,
              yaw: round(sample?.yaw ?? 0, 4),
            };
          }),
      };
    },
    getTradeEvidence: () => {
      const npcId = state.tradeNpcId;
      const offer = npcId === null ? null : state.session.vendorOffer(npcId);
      return {
        open: state.tradeUi.isOpen(),
        npcId,
        coins: offer?.coins ?? 0,
        lastMessage: state.tradeUi.lastMessage(),
        rows:
          offer?.rows.map((row) => ({
            itemId: row.itemId,
            displayName: row.displayName,
            kind: row.kind,
            unitPrice: row.unitPrice,
            maxSellQuantity: row.maxSellQuantity,
            maxBuyQuantity: row.maxBuyQuantity,
            broke: row.broke,
            atMaxStack: row.atMaxStack,
          })) ?? [],
      };
    },
    trade: (kind, itemId, quantity) => {
      if (state.tradeNpcId === null) {
        return { ok: false, message: "摊位没开" };
      }
      return kind === "sell"
        ? state.session.trySellToVendor(state.tradeNpcId, itemId, quantity)
        : state.session.tryBuyFromVendor(state.tradeNpcId, itemId, quantity);
    },
    openStall: (npcId) => {
      const offer = state.session.vendorOffer(npcId);
      if (offer === null) {
        return false;
      }
      state.tradeNpcId = npcId;
      state.tradeUi.open(offer);
      return true;
    },
    closeStall: () => closeTrade(state),
    grantItem: (itemId, quantity) => state.session.grantItem(PLAYER_ID, itemId, quantity),
    completeQuestThroughDialogue: () => {
      const snapshot = state.session.snapshot();
      const quest = snapshot.quests.find((entry) => entry.status !== "completed");
      if (quest === undefined || state.session.snapshot().dialogue !== null) {
        return false;
      }
      const giver = quest.giverNpcId;
      if (state.session.snapshot().dialogue === null) {
        if (!state.session.tryTalkTo(giver).ok) return false;
      }
      // 1) 接取（或直接进入可交分支）。
      if (quest.status === "available") {
        state.session.chooseDialogueOption(0);
      }
      // 2) 击杀推进：走正式的 emitCombatEvent 通道（与真实战斗同一处理函数）。
      for (const objective of quest.objectives) {
        for (let i = objective.current; i < objective.required; i += 1) {
          state.session.emitCombatEvent({
            type: "enemy-killed",
            enemyId: `enemy:l4_probe_${objective.id}_${i}`,
            enemyTemplateId: objective.enemyTemplateId,
          });
        }
      }
      // 3) 复命交付。
      if (!state.session.tryTalkTo(giver).ok) return false;
      state.session.chooseDialogueOption(0);
      return state.session.snapshot().quests.some((entry) => entry.status === "completed");
    },
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
        meshedPartCount: state.runtime.environment.meshedParts.length,
        colliderCount: state.regionContext.colliders.length,
        colliderKinds: [...new Set(state.regionContext.colliders.map((collider) => collider.kind))].sort(),
        bushCount: propsForRegion(state.session.currentRegionId).filter(
          (prop) => prop.kind === "bush",
        ).length,
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
      const resolved = resolveMoveWithColliders(from, { x, z }, state.regionContext.colliders, {
        bounds: state.regionContext.bounds,
      });
      const inside = state.regionContext.colliders.some((collider) =>
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
      const blocker = state.regionContext.colliders.find((collider) => isBlockedByCollider(collider, x, z));
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

    // 票 35：区域 2 的布局/景观/贴图自检同样在 setup 阶段拦。
    // 巢穴只有走到路口才会被创建，因此自检必须在切区之前跑一次。
    const denLayoutIssues = validateSlimeDenLayout();
    if (denLayoutIssues.length > 0) {
      throw new Error(
        `slime_den 布局自检失败：${denLayoutIssues
          .map((issue) => `${issue.id}: ${issue.message}`)
          .join("；")}`,
      );
    }
    const denLandscapeIssues = validateSlimeDenLandscape();
    if (denLandscapeIssues.length > 0) {
      throw new Error(
        `slime_den 景观自检失败：${denLandscapeIssues
          .map((issue) => `${issue.id}: ${issue.message}`)
          .join("；")}`,
      );
    }
    const denTextureIssues = slimeDenTextureCoverage();
    if (denTextureIssues.length > 0) {
      throw new Error(`slime_den 贴图自检失败：${denTextureIssues.join("；")}`);
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

    // 票 35：翠谷与史莱姆巢穴共用同一个「区域运行时」工厂；
    // 两区域各自的布局/自检/景观摆位由 region-layouts 提供。
    const runtime = await createRegionRuntime(scene, root, forward, GREEN_HOLLOW_RUNTIME_LAYOUT);
    const environment = runtime.environment;
    // 边界景观环带 + 渐暗雾 + 全场唯一主光（票 28）。
    const landscape = createLandscapeRing(scene, root, landscapeOptionsFor(GREEN_HOLLOW_REGION_ID));
    const keyLight = installUnifiedKeyLight(scene);
    installLandscapeFog(scene);
    // 硬碰撞体：树/石墙/木桶/木箱（灌木可穿，见 world-physics）。
    // 区域上下文（code-review 收敛项）：regionId/bounds/colliders/灌木
    // 一起进一个对象，切区时整体替换。
    const regionContext: RegionContext = {
      regionId: runtime.regionId,
      bounds: runtime.bounds,
      colliders: runtime.colliders,
      bushes: bushesOf(REGION_RUNTIME_LAYOUTS[GREEN_HOLLOW_REGION_ID].props),
    };
    const colliders = runtime.colliders;
    const pipeline = createGradingPipeline(scene);
    const whiteTexture = createWhiteTexture(scene);

    // 票 36：两种新敌人的独立精灵贴图（抠白后与 prop 同一套 billboard 基建）。
    const enemySpriteKinds: EnemySpriteKind[] = ["windup-charge", "ranged-kite"];
    const loadedSprites = await Promise.all(
      enemySpriteKinds.map(async (kind) => ({ kind, sprite: await loadEnemySprite(scene, kind) })),
    );
    const enemySprites = new Map<EnemySpriteKind, BaseTexture>();
    let enemySpriteRatio = 0;
    for (const entry of loadedSprites) {
      enemySprites.set(entry.kind, entry.sprite.texture);
      enemySpriteRatio += entry.sprite.transparentRatio;
    }
    enemySpriteRatio /= enemySpriteKinds.length;

    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.registerDialogue("merchant_bo", merchantBoCompiled);
    session.registerDialogue("scout_lin", scoutLinCompiled);
    session.registerDialogue("smith_qi", smithQiCompiled);
    // 票 36：把票 28 的硬碰撞清单交给逻辑层，冲锋挡停与投射物撞墙都用它，
    // navmesh 也从同一份 collider 生成（colliderObstacleSpecs）——单一数据源。
    session.setWorldObstacles(colliders);
    session.loadRegion(CONTENT_BUNDLE, GREEN_HOLLOW_REGION_ID);
    const navigation = runtime.navigation;

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
        createEntityVisual(scene, root, { whiteTexture, materials, enemySprites }, entity),
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
      scene,
      root,
      session,
      visuals,
      deadEnemies: new Set<string>(),
      player,
      whiteTexture,
      runtime,
      landscape,
      traveling: false,
      keyLight,
      regionContext,
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
        // 票 37：场景启动时先读自动槽再决定要不要写，避免空快照盖掉进度。
        readAutoSlot: async () => {
          const contents = await holder.state.slotService.readSlot("auto");
          return contents?.snapshot ?? null;
        },
        restoreSnapshot: (snap) => holder.state.session.restoreSnapshot(snap),
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
      interaction: createInteractionState(),
      heldNpcId: null,
      // 票 37 验收：相机跟随 + 出口视觉标记。
      cameraFollow: createCameraFollow(
        initialSnapshot.entities.find((entity) => entity.id === PLAYER_ID)?.position.x ?? 0,
        initialSnapshot.entities.find((entity) => entity.id === PLAYER_ID)?.position.z ?? 0,
      ),
      portalVisuals: new Map(),
      dialogueUi: {
        update: () => undefined,
        setSaveStatus: () => undefined,
        dispose: () => undefined,
      } as unknown as DialogueUi,
      tradeUi: {
        open: () => undefined,
        refresh: () => undefined,
        close: () => undefined,
        isOpen: () => false,
        lastMessage: () => "",
        setMessage: () => undefined,
        dispose: () => undefined,
      } as unknown as TradeUi,
      tradeNpcId: null,
      lastTalkedNpcId: null,
      safeZoneMarks: [],
      zoomProgress: 0,
      feedback: null as unknown as CombatFeedbackLayer,
      audio: new CombatAudio(),
      selectedEnemyId: null,
      selectEnemy: () => undefined,
      dyingEnemies: new Map(),
      hitReacts: new Map(),
      projectileVisuals: new Map(),
      projectileMaterial: createProjectileMaterial(scene),
      enemySpriteRatio,
      enemySprites,
      chestVisuals: new Map(),
      collectibleVisuals: new Map(),
      explorationSpriteRatio: 0,
      collectHud: null,
      collectProgressCache: null,
      cameraReset: null,
      cameraResetElapsedMs: 0,
      cameraDragButton: null,
      cameraDragLastX: 0,
      cameraDragLastY: 0,
      detachCameraInput: () => undefined,
    };

    // 票 37：宝箱与萤光草视觉。贴图来自资产 agent 的产出（assets/exploration/），
    // 加载失败就落回程序化占位——场景不因为一张 PNG 缺失而起不来。
    let explorationSpriteRatio = 0;
    const explorationTextureKinds: ExplorationTextureKind[] = [
      "chest-closed",
      "chest-open",
      "glow-grass",
    ];
    const explorationTextures = new Map<ExplorationTextureKind, BaseTexture | null>();
    const loadedExplorationTextures = await Promise.all(
      explorationTextureKinds.map(async (kind) => {
        try {
          const loaded = await loadExplorationTexture(scene, kind);
          explorationSpriteRatio += loaded.transparentRatio;
          return { kind, texture: loaded.texture as BaseTexture };
        } catch (error) {
          state.ui.setSaveStatus(`探索件贴图缺失，用占位：${errorMessage(error)}`, "idle");
          return { kind, texture: null };
        }
      }),
    );
    for (const entry of loadedExplorationTextures) {
      explorationTextures.set(entry.kind, entry.texture);
    }
    explorationSpriteRatio /= explorationTextureKinds.length;
    state.explorationSpriteRatio = explorationSpriteRatio;

    for (const chest of session.chestDefinitions()) {
      const visual = createChestVisual(scene, root, chest, {
        closed: explorationTextures.get("chest-closed") ?? null,
        open: explorationTextures.get("chest-open") ?? null,
      });
      state.chestVisuals.set(chest.id, visual);
      advanceChestVisual(visual, 260, session.isChestOpened(chest.id) ? 1 : 0);
    }
    session.collectibleDefinitions().forEach((collectible, index) => {
      const visual = createCollectibleVisual(
        scene,
        root,
        collectible,
        index,
        explorationTextures.get("glow-grass") ?? null,
      );
      visual.root.setEnabled(!session.isCollectibleCollected(collectible.id));
      state.collectibleVisuals.set(collectible.id, visual);
    });
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
      // 票 34：HUD 只拿曲线做等级/经验条换算，不持有任何逻辑状态。
      levelCurve: levelCurveData as unknown as LevelCurveDefinition,
      onChoose: (index) => session.chooseDialogueOption(index),
      onUseItem: (instanceId) => session.tryUseItem(PLAYER_ID, instanceId),
      onEquipItem: (instanceId) => session.tryEquip(PLAYER_ID, instanceId),
      onUnequipItem: (instanceId) => session.tryUnequip(PLAYER_ID, instanceId),
      onDebugKill: killNextEnemy,
      usePortraitDialogue: true,
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
      // 票 32：返回标题。标题流程由 main.ts 挂在 window 上（未挂时按钮无效）。
      onBackToTitle: () => {
        window.dispatchEvent(new CustomEvent("game:back-to-title"));
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
    // 场景构建完成 = 区域已就绪，先把「自动槽里已有的进度」读回来，
    // 再写一次自动槽作为初始进度点。
    //
    // 顺序很重要（票 37 发现的回归）：自动槽与手动槽共用同一个存储键，
    // 如果先 notifyRegionChanged 再读档，就会用**刚写的空快照**覆盖掉
    // 玩家上次的世界事实（宝箱/收集计数全部回退）。
    let restoredFromAuto = false;
    try {
      restoredFromAuto = await state.autoSaver.hasAutoSnapshot();
      // code-review #15：自动槽快照可能属于另一个区域（票 35 之后）。
      // 与 loadFromStorage/restoreSlot 一样先切区域再恢复，否则 restoreSnapshot
      // 会因「快照区域与当前已加载区域不一致」而拒绝。
      let autoSnapshot: GameSessionSnapshot | null = null;
      if (restoredFromAuto) {
        autoSnapshot = await state.slotService
          .readSlot("auto")
          .then((contents) => contents?.snapshot ?? null);
        if (
          autoSnapshot !== null &&
          autoSnapshot.regionId !== null &&
          autoSnapshot.regionId !== state.session.currentRegionId
        ) {
          const entered = await enterRegionForSnapshot(state, autoSnapshot.regionId);
          if (entered === null) {
            state.ui.setSaveStatus(
              `自动存档属于 ${autoSnapshot.regionId}，但该区域没有渲染布局`,
              "error",
            );
            autoSnapshot = null;
            restoredFromAuto = false;
          }
        }
      }
      // code-review #15：恢复失败（快照损坏等）不得让 autoSaver 用空快照覆盖
      // auto 槽——直接放弃 restoreAuto，保持 auto 槽原样等下一次关键节点。
      if (restoredFromAuto && autoSnapshot !== null && !(await safeRestoreAuto(state, autoSnapshot))) {
        restoredFromAuto = false;
      }
      if (restoredFromAuto) {
        // 自动槽恢复后视觉要跟上：宝箱盖子按 worldState 决定开合，
        // 已捡的萤光草整组隐藏，HUD 计数立刻反映进度。
        clearWaypoints(state);
        setInteractionPhase(state.interaction, createInteractionState());
        closeDialoguePresentation(state);
        state.zoomProgress = 0;
        setCameraSpan(scene, CAMERA_VERTICAL_SPAN);
        const restored = state.session.snapshot();
        state.deadEnemies.clear();
        for (const entity of restored.entities) {
          if (entity.identity.type === "enemy" && !entity.combat.alive) {
            state.deadEnemies.add(entity.id);
          }
        }
        syncVisualToSnapshot(state, restored);
        state.ui.update(restored);
        invalidateCollectProgressCache(state);
        state.collectHud?.update({
          displayNames: COLLECT_SET_NAMES,
          progress: allCollectProgressCached(state),
        });
        state.ui.setSaveStatus("已恢复自动存档进度", "ok");
      } else {
        restoredFromAuto = false;
      }
    } catch (error) {
      state.ui.setSaveStatus(`自动存档不可用：${errorMessage(error)}`, "error");
      restoredFromAuto = false;
    }
    if (!restoredFromAuto) {
      await state.autoSaver.notifyRegionChanged();
    }

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

    state.dialogueUi = createDialogueUi({
      mount: document.body,
      characters: [
        {
          id: PLAYER_ID,
          displayName:
            initialSnapshot.entities.find((entity) => entity.id === PLAYER_ID)?.identity
              .displayName ?? "旅人",
          primaryColor: paletteOf(PLAYER_ID).primary,
          portraitUrl: portraitUrlOf(PLAYER_ID),
        },
        ...initialSnapshot.entities
          .filter((entity) => entity.identity.type === "npc")
          .map((entity) => ({
            id: entity.id,
            displayName: entity.identity.displayName,
            primaryColor: paletteOf(entity.id).primary,
            portraitUrl: portraitUrlOf(entity.id),
          })),
      ],
      onActivateBubble: () => {
        // 气泡只对当前交互目标有效；目标由交互状态机持有。
        const action = activateBubble(
          state.interaction,
          entityPositions(session),
          interactableIndex(session),
          PLAYER_ID,
        );
        applyInteractionAction(state, action);
      },
      onChoose: (index) => {
        state.session.chooseDialogueOption(index);
      },
    });

    // 票 37：收集计数 HUD + 相机复位按钮（独立文件，不动 quest-loop-ui.ts）。
    state.collectHud = createCollectHud({
      mount: document.body,
      onResetCamera: () => requestCameraReset(state, scene),
    });
    state.collectHud.update({
      displayNames: COLLECT_SET_NAMES,
      progress: allCollectProgressCached(state),
    });
    state.detachCameraInput = installCameraInput(state, scene);

    // 票 33：交易面板。与对话面板同风格但独立文件——quest-loop-ui 被多票同时动。
    state.tradeUi = createTradeUi({
      mount: document.body,
      primaryColor: paletteOf(MERCHANT_NPC_ID).primary,
      onSell: (itemId, quantity) => trade(state, "sell", itemId, quantity),
      onBuy: (itemId, quantity) => trade(state, "buy", itemId, quantity),
      onClose: () => closeTrade(state),
    });
    // 票 33：安全区可视化。逻辑层拒止才是行为，这里只让「安全区在哪」可读。
    state.safeZoneMarks = createSafeZoneMarks(scene, session.getSafeZones());

    // 画质档位：?quality=high|medium|low|auto（默认 auto = 动态分辨率）。
    const requestedQuality = parseQualityLevel(
      new URLSearchParams(window.location.search).get("quality"),
    );
    configureQuality(scene, state, requestedQuality);

    // 点击 NPC = 两段式第一段（靠近，不弹对话）；点击敌人 = 攻击；
    // 点击其他实体/地面 = 走过去（同时取消靠近/结束对话）。
    const pointerObserver = scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) {
        return;
      }

      // 相机拖拽旋转期间（左键之外的按键）不做点击交互。
      if (state.cameraDragButton !== null) {
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
      const pickedMesh = pick?.pickedMesh ?? null;

      // 票 37：先问宝箱/收集品——它们不是逻辑实体，只能靠 metadata 识别。
      const chestId = pick?.hit ? metadataString(pickedMesh, "chestId") : null;
      if (chestId !== null) {
        interactWithChest(state, chestId);
        return;
      }
      const collectibleId = pick?.hit ? metadataString(pickedMesh, "collectibleId") : null;
      if (collectibleId !== null) {
        interactWithCollectible(state, collectibleId);
        return;
      }

      const pickedId = entityIdOf(pickedMesh);
      if (pickedId !== null) {
        const picked = session
          .snapshot()
          .entities.find((entity) => entity.id === pickedId);
        if (picked?.identity.type === "npc") {
          const interactables = interactableIndex(session);
          const info = interactables.get(pickedId);
          if (info === undefined || (!info.hasDialogue && !info.hasQuest)) {
            state.ui.setSaveStatus(
              `${picked.identity.displayName} 现在没有可进行的对话`,
              "idle",
            );
            return;
          }
          const player = playerSnapshot(session);
          if (player === null || !player.combat.alive) {
            state.ui.setSaveStatus("角色倒下中，等待重生", "idle");
            return;
          }
          // 两段式：远处点击只寻路靠近；距离内直接出气泡。
          const action = selectNpc(
            state.interaction,
            pickedId,
            interactables,
            player.position,
            picked.position,
          );
          applyInteractionAction(state, action);
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
          applyInteractionAction(state, requestMove(state.interaction));
          moveAlongNavMesh(state, {
            x: picked.position.x,
            z: picked.position.z + 1.5,
          });
        }
        return;
      }
      // 点击地面：移动意图（会取消靠近/结束对话）。
      const point = groundPoint(scene);
      if (point !== null) {
        applyInteractionAction(state, requestMove(state.interaction));
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
      // 跨区复活（票 36 死亡轻惩罚）：respawn 事件走 drainEvents 通道，
      // respawnRegionId 非 null 表示要回村——表现层负责切区。
      for (const event of session.drainEvents()) {
        if (event.type !== "respawn" || event.respawnRegionId === null) {
          continue;
        }
        void enterRegionForSnapshot(state, event.respawnRegionId).then((entered) => {
          if (entered !== null) {
            invalidateCollectProgressCache(state);
            syncVisualToSnapshot(state, state.session.snapshot());
          }
        });
      }
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

      // 两段式对话交互 + 气泡投影 + 立绘/镜头（票 29）。
      updateInteractionPresentation(state, scene, deltaMs);
      // 票 37：宝箱盖子开合 + 收集品呼吸 + 相机复位插值。
      updateExplorationVisuals(state, now, deltaMs);
      updateCameraReset(state, scene, deltaMs);
      // 票 37 验收修复：出口标记动画 + 相机跟随玩家。
      // 跟随放在复位之后：复位只改 alpha/beta/span，不碰 target，
      // 所以两者叠加时复位结束后相机继续平滑跟着玩家走。
      updatePortalVisuals(state, now);
      updateCameraFollowStep(state, scene);
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

      // 票 35：走到路口 → 黑场切区。判定用逻辑层位置（比视觉更早，
      // 因为 navmesh 路点与视觉插值可能差半米）；同一次判定只在
      // traveling=false 时发起，切换期间不重复触发。
      if (!state.traveling && state.session.currentRegionId !== null) {
        const playerLogic = snapshot.entities.find((entity) => entity.id === PLAYER_ID);
        if (playerLogic !== undefined && playerLogic.combat.alive) {
          const hit = findTriggeredExit(
            exitsForRegion(state.session.currentRegionId),
            playerLogic.position,
          );
          if (hit !== null) {
            void travelToRegion(state, scene, {
              x: playerLogic.position.x,
              z: playerLogic.position.z,
            });
          }
        }
      }

      // 票 36：投射物渲染。每帧从逻辑层的 projectileSnapshots() 同步位置——
      // 命中判定与消失都在逻辑层，表现层只是把球画在它说的地方。
      syncProjectileVisuals(state);

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
          state.regionContext.colliders,
          { bounds: state.regionContext.bounds },
        );
        if (resolved.x !== player.rootNode.position.x) {
          player.rootNode.position.x = resolved.x;
        }
        if (resolved.z !== player.rootNode.position.z) {
          player.rootNode.position.z = resolved.z;
        }
      }

      // NPC 待机演出：呼吸摆动 + 偶尔踱步（只动视觉节点）。
      // 玩家靠近时禁用踱步（NPC_PACE_PLAYER_DISABLE_RADIUS，票 37 验收）：
      // 巡逻与踱步两个真相源叠加会让 NPC 在你面前每几秒挪一步。
      const playerForIdle = playerSnapshot(session);
      for (const [npcId, controller] of state.npcIdle) {
        const npc = snapshot.entities.find((entity) => entity.id === npcId);
        if (!npc) {
          continue;
        }
        controller.update(
          deltaMs,
          { x: npc.position.x, z: npc.position.z },
          playerForIdle === null
            ? null
            : { x: playerForIdle.position.x, z: playerForIdle.position.z },
        );
      }

      // 灌木进入反馈（code-review #31：灌木列表在切区时缓存进 regionContext，
      // 帧内不再每次 filter/map 重建）。
      const proximity = bushOcclusionAt(
        player.rootNode.position.x,
        player.rootNode.position.z,
        state.regionContext.bushes,
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
        // 票 37：收集计数 HUD 与任务 HUD 同步刷新（同样 10Hz）。
        state.collectHud?.update({
          displayNames: COLLECT_SET_NAMES,
          progress: allCollectProgressCached(state),
        });
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
      // 票 32：入场意图决定开局读哪个槽。缺省（harness / L4 直入）沿用旧行为：
      // 有默认档就读，没有就全新开始。
      const intent = takeTitleEntryIntent();
      if (intent.kind === "continue") {
        if (!(await restoreSlot(state, intent.slotId))) {
          await loadFromStorage(state);
        }
      } else if (intent.kind === "new-game") {
        startNewGame(state);
      } else if (await state.saveService.hasSave()) {
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
        // 阈值从内容包现算，而不是写死 6：敌人/NPC 增删后（票 36 加了冲锋型与
        // 吐弹型）这个断言曾经一直红着，写死数字会让人以为是探索内容引入了回归。
        name: "gameSession.entityCount",
        value: snapshot.entities.length,
        unit: "entities",
        threshold: EXPECTED_ENTITY_COUNT,
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
        threshold: EXPECTED_ENTITY_COUNT,
        comparison: "eq",
      },
      {
        // 票 37：探索件精灵贴图（宝箱关闭/开启 + 萤光草）的抠白透明占比。
        // 值落在合理区间说明贴图真的抠掉了白底，而不是整张白板贴在场景里。
        name: "explorationSpriteTransparentRatio",
        value: round(state.explorationSpriteRatio, 4),
        unit: "ratio",
        threshold: 0.3,
        comparison: "gte",
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
        // 票 35：区域联动证据。当前区域 + 出口数 + 两区域共有的运行时规模。
        name: "region.exitCount",
        value: exitsForRegion(state.session.currentRegionId).length,
        unit: "exits",
        threshold: 1,
        comparison: "eq",
      },
      {
        name: "region.landscapeMeshCount",
        value: state.landscape.meshes.length,
        unit: "meshes",
        threshold: 30,
        comparison: "gte",
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
    state.detachCameraInput();
    state.collectHud?.dispose();
    state.ui.dispose();
    state.dialogueUi.dispose();
    state.tradeUi.dispose();
    for (const mark of state.safeZoneMarks) {
      mark.dispose(false, true);
    }
    state.safeZoneMarks.length = 0;

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
    for (const visual of state.portalVisuals.values()) {
      visual.root.dispose(false, true);
    }
    for (const visual of state.visuals.values()) {
      visual.procedural?.dispose();
    }
    for (const material of state.materials) {
      material.dispose();
    }
    state.player.dispose();
    // runtime 自己持有并释放 navmesh（state.navigation 只是同一个实例的别名，
    // 切区后指向新区；这里不能重复 dispose）。
    state.runtime.dispose();
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

// ---------------------------------------------------------------------------
// 票 35：区域注册表与切换
// ---------------------------------------------------------------------------

/**
 * 每个区域的「运行时布局」。这是渲染层唯一的区域差异点：
 * 贴片、道具摆位、暗色调、出口。翠谷用原色，巢穴压暗（资产 agent
 * 产出 artifacts/region2/ 暗色瓦片后，把 namePrefix/tint 换成真资产即可）。
 */
const REGION_RUNTIME_LAYOUTS: Record<string, RegionRuntimeLayout> = {
  [GREEN_HOLLOW_REGION_ID]: {
    regionId: GREEN_HOLLOW_REGION_ID,
    bounds: GREEN_HOLLOW_BOUNDS,
    groundPatches: GROUND_PATCHES,
    props: PROPS,
    // content 的 exits 是区域联动的权威；渲染层只读位置用于提前判定与地形留空。
    exits: greenHollowExits(),
    namePrefix: "environment",
  },
  [SLIME_DEN_REGION_ID]: {
    regionId: SLIME_DEN_REGION_ID,
    bounds: SLIME_DEN_BOUNDS,
    groundPatches: SLIME_DEN_GROUND_PATCHES,
    props: SLIME_DEN_PROPS,
    exits: SLIME_DEN_EXITS,
    tint: SLIME_DEN_TINT,
    namePrefix: "den",
    ...(slimeDenWaterPatch() ? { waterPatch: slimeDenWaterPatch() } : {}),
  },
};

const GREEN_HOLLOW_RUNTIME_LAYOUT = REGION_RUNTIME_LAYOUTS[GREEN_HOLLOW_REGION_ID];

/** 翠谷的出口（content 是权威；这里转成联动模块的形状）。 */
function greenHollowExits(): readonly RegionLinkageExit[] {
  return (GREEN_HOLLOW_REGION.exits ?? []).map((exit) => ({
    id: exit.id,
    targetRegionId: exit.targetRegionId,
    position: exit.position,
  }));
}

/** 区域景观（环带山丘/远景枯木/配色）：巢穴更暗、山丘更矮。 */
function landscapeOptionsFor(regionId: string): {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  hills: typeof SLIME_DEN_HILLS;
  trees: typeof SLIME_DEN_TREES;
  colors: { ground: { r: number; g: number; b: number }; hill: { r: number; g: number; b: number }; tree: { r: number; g: number; b: number } };
  namePrefix: string;
} {
  if (regionId === SLIME_DEN_REGION_ID) {
    return {
      bounds: SLIME_DEN_LANDSCAPE_BOUNDS,
      hills: SLIME_DEN_HILLS,
      trees: SLIME_DEN_TREES,
      colors: {
        ground: { r: 0.2, g: 0.21, b: 0.26 },
        hill: { r: 0.22, g: 0.24, b: 0.32 },
        tree: { r: 0.16, g: 0.2, b: 0.24 },
      },
      namePrefix: "den.landscape",
    };
  }
  return {
    bounds: HOLLOW_LANDSCAPE_BOUNDS,
    hills: HOLLOW_HILLS,
    trees: HOLLOW_TREES,
    colors: {
      ground: LANDSCAPE_GROUND_COLOR,
      hill: LANDSCAPE_HILL_COLOR,
      tree: LANDSCAPE_TREE_COLOR,
    },
    namePrefix: "landscape",
  };
}

/** 某个区域当前的道具清单（遮挡探针/灌木反馈按区域取）。 */
function propsForRegion(regionId: string | null): readonly PropPlacement[] {
  const layout =
    regionId === null ? undefined : REGION_RUNTIME_LAYOUTS[regionId];
  return layout?.props ?? PROPS;
}

/** 某区域的出口清单（逻辑层 travelToRegion 会再校验一次，这里只用于提前判定）。 */
function exitsForRegion(regionId: string | null): readonly RegionLinkageExit[] {
  const layout =
    regionId === null ? undefined : REGION_RUNTIME_LAYOUTS[regionId];
  return layout?.exits ?? [];
}

/**
 * 直接装载存档/读档需要的目标区域（不经路口判定）。
 * 与 travelToRegion 的差别只有一个：没有「走到出口」这一步，
 * 因为调用方已经知道快照属于哪个区域。仍走黑场 + 重建 + 视觉同步。
 */
async function enterRegionForSnapshot(
  state: P1WorldState,
  regionId: string,
): Promise<string | null> {
  const layout = REGION_RUNTIME_LAYOUTS[regionId];
  if (layout === undefined) {
    return null;
  }
  const scene = state.player.rootNode.getScene();
  if (state.traveling) {
    return null;
  }
  state.traveling = true;
  const gate = getLoadingGate();
  await gate.maskIn(REGION_FADE_MS);
  try {
    // 会话侧直接进入该区域（不经路口：读档路径已经知道目标区域）。
    const enteredSession = state.session.tryEnterRegion(CONTENT_BUNDLE, regionId);
    if (!enteredSession.ok) {
      state.ui.setSaveStatus(`进入 ${regionId} 失败：${enteredSession.message}`, "error");
      return null;
    }
    await loadRegionVisuals(state, scene, layout);
    syncVisualToSnapshot(state, state.session.snapshot());
    // 切区后玩家落在新区入口：相机直接就位，不做长镜头平移。
    snapCameraToPlayer(state);
    return layout.regionId;
  } finally {
    await gate.maskOut(REGION_FADE_MS);
    state.traveling = false;
  }
}

/** 卸载旧区域、装载新区域的可视部分（切区与读档共用）。 */
async function loadRegionVisuals(
  state: P1WorldState,
  scene: Scene,
  layout: RegionRuntimeLayout,
): Promise<void> {
  // **先建新区再拆旧区**：createRegionRuntime 会异步加载贴图并构建 navmesh，
  // 期间玩家仍可能点地面（走到已 dispose 的 navmesh 上会让 Recast WASM
  // 抛 "memory access out of bounds"）。旧的 runtime 在新区就绪前一直可用。
  const runtime = await createRegionRuntime(scene, state.root, forwardVector(scene), layout);

  clearWaypoints(state);
  state.deadEnemies.clear();
  state.dyingEnemies.clear();
  state.hitReacts.clear();
  state.selectEnemy(null);
  invalidateCollectProgressCache(state);
  state.session.endDialogue();
  setInteractionPhase(state.interaction, createInteractionState());
  closeDialoguePresentation(state);
  state.zoomProgress = 0;

  state.runtime.dispose();
  state.landscape.dispose();
  state.runtime = runtime;
  // 区域上下文整体替换（code-review #4/#13）：colliders 与 bounds 随新区
  // 一起换掉，硬碰撞求解与 NPC 踱步钳制不再沿用旧区域的数值。
  state.regionContext = {
    regionId: runtime.regionId,
    bounds: runtime.bounds,
    colliders: runtime.colliders,
    bushes: bushesOf(layout.props),
  };
  // 逻辑层的冲锋挡停/投射物撞墙用同一份新区域 collider（code-review #4）。
  state.session.setWorldObstacles(runtime.colliders);
  state.landscape = createLandscapeRing(scene, state.root, landscapeOptionsFor(layout.regionId));
  state.navigation = runtime.navigation;
  rebuildRegionVisuals(state, scene, runtime);
  // 票 37 验收修复：出口标记随区域一起重建（洞口是当前区域的出口）。
  rebuildPortalVisuals(state, scene);
  // 实体视觉重建（code-review #3）：上一区域的 NPC/敌人 mesh 必须清掉，
  // 新区域的敌人必须有 visual。玩家跨区域保留。
  rebuildEntityVisuals(state, scene, layout);
}

/**
 * 区域切换（票 35）：
 *   黑场淡入 → 会话切区（保留玩家/任务进度）→ 销毁旧区域、装新区 →
 *   重建遮挡/碰撞/路点 → 自动存档（票 31）→ 黑场淡出。
 *
 * 返回切换后的区域 id；玩家不在路口时返回 null（什么都不做）。
 */
async function travelToRegion(
  state: P1WorldState,
  scene: Scene,
  position: { x: number; z: number },
): Promise<string | null> {
  if (state.traveling) {
    return null;
  }
  const fromRegionId = state.session.currentRegionId;
  const exit = findTriggeredExit(exitsForRegion(fromRegionId), position);
  if (exit === null) {
    return null;
  }
  const layout = REGION_RUNTIME_LAYOUTS[exit.targetRegionId];
  if (layout === undefined) {
    state.ui.setSaveStatus(`目标区域未配置渲染布局：${exit.targetRegionId}`, "error");
    return null;
  }

  state.traveling = true;
  // 黑场：先把 mask 拉满，正好挡住下一个区域的资源加载与首帧上传。
  const gate = getLoadingGate();
  await gate.maskIn(REGION_FADE_MS);
  try {
    const travel = state.session.tryTravelToRegion(CONTENT_BUNDLE, {
      x: position.x,
      y: 0,
      z: position.z,
    });
    if (!travel.ok) {
      state.ui.setSaveStatus(`区域切换失败：${travel.message ?? "未知原因"}`, "error");
      return null;
    }

    // 视觉：旧区域的网格/碰撞/navmesh 整体卸载，装载新区域
    // （对话/路点/死亡集合的清理都在 loadRegionVisuals 里）。
    await loadRegionVisuals(state, scene, layout);
    syncVisualToSnapshot(state, state.session.snapshot());
    // 切区后玩家落在新区入口：相机直接就位，不做长镜头平移。
    snapCameraToPlayer(state);

    // 自动存档：区域切换是关键节点（票 31 的触发时机之一）。
    await state.autoSaver.notifyRegionChanged();
    state.ui.setSaveStatus(`已进入 ${layout.regionId}`, "ok");
    return layout.regionId;
  } finally {
    await gate.maskOut(REGION_FADE_MS);
    state.traveling = false;
  }
}

/**
 * 切区后的实体视觉重建（code-review #3）：
 * - 清掉快照里不存在的旧视觉（上一区域的 NPC/敌人 mesh 不能残留）；
 * - 为新区域的 NPC/敌人新建视觉并挂 NPC 待机演出（踱步钳制用新区域 bounds）；
 * - 反馈层锚点同步重建（旧锚点指向已销毁节点）。
 */
function rebuildEntityVisuals(
  state: P1WorldState,
  scene: Scene,
  layout: RegionRuntimeLayout,
): void {
  const snapshot = state.session.snapshot();
  const plan = planEntityVisualRebuild(
    snapshot.entities,
    new Set(state.visuals.keys()),
  );
  for (const id of plan.disposeIds) {
    const visual = state.visuals.get(id);
    if (visual !== undefined) {
      visual.procedural?.dispose();
      visual.node.dispose(false, true);
    }
    state.visuals.delete(id);
    state.npcIdle.get(id)?.dispose();
    state.npcIdle.delete(id);
    state.feedback.trackEntity(id, null, 0);
  }
  for (const entity of plan.create) {
    const visual = createEntityVisual(scene, state.root, state, entity);
    state.visuals.set(entity.id, visual);
    if (entity.identity.type === "npc") {
      state.npcIdle.set(
        entity.id,
        new NpcIdleController({
          scene,
          node: visual.node,
          home: { x: entity.position.x, z: entity.position.z },
          seed: entity.id.length * 131 + state.visuals.size * 37,
          bounds: layout.bounds,
        }),
      );
    }
    state.feedback.trackEntity(entity.id, visual.node, visual.targetY + 0.35);
  }
  // 遮挡描边目标表重建（视觉表变了）。
  state.occlusionTargets = [...state.visuals.entries()]
    .map(([id, visual]) => ({
      id,
      mesh: visual.mesh as Mesh,
      anchor: visual.node.position,
      targetY: visual.targetY,
    }))
    .filter((target) => scene.getMeshByName(target.mesh.name) !== null);
}

/** 新区域的遮挡描边与灌木遮挡目标重建（旧的指向已销毁网格）。 */
function rebuildRegionVisuals(
  state: P1WorldState,
  scene: Scene,
  runtime: RegionRuntime,
): void {
  const camera = scene.activeCamera;
  const forward = camera
    ? camera.getDirection(new Vector3(0, 0, 1)).normalize()
    : new Vector3(-0.408, -0.816, 0.408).normalize();

  state.occlusion = new OcclusionOutlineController(
    state.layer,
    runtime.environment.occluders.map((occluder) => occluder.box),
    forward,
  );
  for (const mesh of [
    ...runtime.environment.groundMeshes,
    ...runtime.environment.propMeshes,
    ...runtime.environment.meshedParts,
  ]) {
    state.layer.addExcludedMesh(mesh);
  }

  const targets = [...state.visuals.entries()]
    .map(([id, visual]) => ({
      id,
      mesh: visual.mesh as Mesh,
      anchor: visual.node.position,
      targetY: visual.targetY,
    }))
    .filter((target) => scene.getMeshByName(target.mesh.name) !== null);
  state.occlusionTargets = targets;
  for (const [id, visual] of state.visuals) {
    state.feedback.trackEntity(id, visual.node, visual.targetY + 0.35);
  }
  state.environmentMetrics = {
    textureCount: runtime.environment.textures.textures.length,
    keyedTransparentRatio:
      runtime.environment.keyStats.reduce(
        (sum, entry) => sum + entry.transparentRatio,
        0,
      ) / Math.max(1, runtime.environment.keyStats.length),
    occluderCount: runtime.environment.occluders.length,
    meshedPartCount: runtime.environment.meshedParts.length,
    colliderCount: runtime.colliders.length,
  };
}

/** 当前相机的水平前向（遮挡盒与 billboard 朝向的唯一来源）。 */
function forwardVector(scene: Scene): Vector3 {
  const camera = scene.activeCamera;
  return camera
    ? camera.getDirection(new Vector3(0, 0, 1)).normalize()
    : new Vector3(-0.408, -0.816, 0.408).normalize();
}

/**
 * code-review #15：恢复自动槽但**不用空快照覆盖 auto 槽**。
 * restoreSnapshot 抛错（快照损坏/区域不一致）时直接返回 false，
 * 不调用 notifyRegionChanged——后者会把刚建好的空会话写进 auto 槽，
 * 把玩家上次的世界事实（宝箱/收集计数）全部盖掉。
 */
function safeRestoreAuto(state: P1WorldState, snapshot: GameSessionSnapshot): boolean {
  try {
    state.session.restoreSnapshot(snapshot);
    // 不调 notifyRegionChanged：恢复路径在 setup 里走 `restoredFromAuto=true`
    // 分支跳过首次写入，auto 槽保持原样（code-review #15 的防覆盖点）。
    return true;
  } catch (error) {
    state.ui.setSaveStatus(`自动存档恢复失败：${errorMessage(error)}`, "error");
    return false;
  }
}

/** 收集进度（code-review #32）：惰性缓存，脏了重算、其余帧直接复用。 */
function allCollectProgressCached(state: P1WorldState): CollectProgress[] {
  if (state.collectProgressCache === null) {
    state.collectProgressCache = state.session.allCollectProgress();
  }
  return state.collectProgressCache;
}

/** 收集进度置脏（拾取/读档/切区后调用，下次读取重算）。 */
function invalidateCollectProgressCache(state: P1WorldState): void {
  state.collectProgressCache = null;
}

function snapshotEntities(session: GameSession): string[] {
  return session.snapshot().entities.map((entity) => entity.id);
}
