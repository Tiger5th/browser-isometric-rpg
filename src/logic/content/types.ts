/**
 * content/ 数据文件的 TypeScript 视图。
 *
 * 这些接口是 JSON schema（content/schema/*.schema.json）的运行时代码形态，
 * 二者必须保持同步：schema 是合同，本文件是消费者。字段含义见 content/README.md。
 */

import type { Vec3 } from "../entity";
import type { ModifierTemplate } from "../modifier";

/** 内容文件类别，与 content/ 下的目录一一对应。 */
export type ContentKind =
  | "region"
  | "npc"
  | "enemy-template"
  | "enemy"
  | "item"
  | "quest"
  | "character-palette"
  | "level-curve"
  | "chest"
  | "collectible"
  | "collect-set";

export interface ContentFileInput {
  kind: ContentKind;
  /** 相对仓库根的路径，仅用于校验报告。 */
  file: string;
  data: unknown;
}

export interface PlayerDefinition {
  /** 玩家实体的 EntityId，跨区域保持不变（如 entity:player）。 */
  id: string;
  templateId: string;
  displayName: string;
  spawn: {
    position: Vec3;
    rotation?: Vec3;
  };
  baseAttributes: Record<string, number>;
  /** 出生时进背包的物品（死亡轻惩罚用的金币从这里来）。 */
  startingItems?: Array<{ itemId: string; quantity: number }>;
}

export interface RegionExitDefinition {
  id: string;
  targetRegionId: string;
  position: Vec3;
  rotation?: Vec3;
}

export interface RegionDefinition {
  id: string;
  displayName: string;
  asset: {
    /** 区域 glTF/GLB 资产路径。 */
    model: string;
    /** 可选 navmesh 资产路径。 */
    navmesh?: string;
  };
  player: PlayerDefinition;
  exits?: RegionExitDefinition[];
  /** 区域内敌人 AI 拒止进入的地带（票 33）。缺省 = 无安全区。 */
  safeZones?: SafeZoneDefinitionContent[];
}

export interface NpcDefinition {
  id: string;
  displayName: string;
  /** 渲染/行为模板标识，由表现层解释。 */
  templateId: string;
  regionId: string;
  position: Vec3;
  rotation?: Vec3;
  baseAttributes?: Record<string, number>;
  tags?: string[];
  /** 对话 id = content/dialogues/<dialogueId>.ink 的文件名（不含扩展名）。 */
  dialogueId?: string;
  questIds?: string[];
  /** 角色色板卡 id；3D 贴图与立绘按同一张卡生成（票 29）。 */
  paletteId?: string;
  /** 立绘资源引用（表现层解释）；未生成时可缺省，UI 用程序化占位。 */
  portrait?: PortraitReference;
  /**
   * 商人价格表（票 33）：itemId → 单价（金币/个）。
   * `sell` = 商人从玩家手里买（玩家把战利品换成金币）；
   * `buy` = 商人卖给玩家（玩家花金币买药）。两者都必须为正整数（L2 校验）。
   * 运行时解释口在 src/logic/trade.ts。
   */
  vendor?: VendorDefinition;
  /** 巡逻路线（票 33）：走→停留张望→下一点；纯表现层驱动，位置进快照。 */
  patrol?: PatrolRouteDefinition;
  /** 任务状态变化时的换锚点（票 33，「世界因你而变」的最小实现）。 */
  reanchors?: ReanchorDefinition[];
}

/** 立绘引用：资源路径 + 画面锚点（说话方/站位由表现层排布）。 */
export interface PortraitReference {
  /** 图片资源路径，如 assets/portraits/elder_ma.png。 */
  image: string;
  /** 生图提示词关键词留档，便于同卡重新生成时复用。 */
  keywords?: string[];
}

/**
 * 商人价格表（票 33）。键是 itemId，值是单价（金币/个，必须为正整数）。
 * 卖出与买入的差值就是商人的利差。
 */
export interface VendorDefinition {
  sell: Record<string, number>;
  buy: Record<string, number>;
}

/** 巡逻路线（票 33）：至少 2 个点位，首点建议等于 NPC 初始位置。 */
export interface PatrolRouteDefinition {
  waypoints: Vec3[];
  /** 到点后停留张望的毫秒数；缺省 2500。 */
  dwellMs?: number;
}

/** 换锚点声明（票 33）：任务完成/状态变化时 NPC 换到的新巡逻路线。 */
export interface ReanchorDefinition {
  /** 触发换锚点的任务 id。 */
  questId: string;
  waypoints: Vec3[];
  dwellMs?: number;
}

/**
 * 安全区（票 33）：区域内敌人 AI 拒止进入的矩形地带。
 * 挂在区域定义上（region.safeZones），挂在 npc 上是错的——安全区的边界
 * 属于关卡地形，不属于某个 NPC。
 */
export interface SafeZoneDefinitionContent {
  id: string;
  shape: "rect";
  center: Vec3;
  halfExtents: { x: number; z: number };
}

export interface DropDefinition {
  itemId: string;
  /** 掉落概率，0–1。 */
  chance: number;
  min: number;
  max: number;
}

/**
 * AI 档案（票 36）：内容里的纯数据形态，由 `src/logic/enemy-ai.ts` 的
 * resolveEnemyAiProfile 解释。缺省（不写）= 既有 chaser 近战追击状态机。
 * kind 决定状态机分支，数值均可省略（省略即用档案默认值）。
 */
export interface EnemyAiProfileData {
  /** chaser = 既有近战追击；windup-charge = 蓄力冲锋；ranged-kite = 保持距离吐弹。 */
  kind: "chaser" | "windup-charge" | "ranged-kite";
  /** windup-charge：前摇时长（毫秒，默认 600）。 */
  windupMs?: number;
  /** windup-charge：冲锋速度（米/秒）。 */
  chargeSpeed?: number;
  /** windup-charge：单次冲锋的最长直线距离（米）。 */
  chargeDistance?: number;
  /** windup-charge：冲锋结束后的硬直（毫秒）。 */
  recoveryMs?: number;
  /** windup-charge：进入该距离就起手前摇。 */
  triggerRange?: number;
  /** windup-charge：冲锋路径命中半径（米）。 */
  hitRadius?: number;
  /** ranged-kite：期望交战距离（米），比它远就追近。 */
  preferredRange?: number;
  /** ranged-kite：玩家进入该距离就后撤。 */
  retreatRange?: number;
  /** ranged-kite：开火间隔（毫秒）。 */
  fireIntervalMs?: number;
  /** ranged-kite：投射物速度（米/秒）。 */
  projectileSpeed?: number;
  /** ranged-kite：投射物伤害（固定值）。 */
  projectileDamage?: number;
  /** ranged-kite：投射物碰撞半径（米）。 */
  projectileRadius?: number;
  /** ranged-kite：投射物存活时限（毫秒）。 */
  projectileLifetimeMs?: number;
}

export interface EnemyTemplateDefinition {
  id: string;
  displayName: string;
  /** 敌人 AI 档案 id，由逻辑层解释（P1 = melee_chaser 状态机）。 */
  aiProfileId: string;
  /** 票 36：AI 档案；缺省 = 既有 chaser 状态机。 */
  aiProfile?: EnemyAiProfileData;
  baseAttributes: Record<string, number>;
  drops?: DropDefinition[];
  tags?: string[];
}

export interface EnemyDefinition {
  id: string;
  templateId: string;
  displayName: string;
  regionId: string;
  position: Vec3;
  rotation?: Vec3;
  tags?: string[];
  overrides?: {
    baseAttributes?: Record<string, number>;
  };
}

export type ItemKind = "equipment" | "consumable" | "misc";

export interface EquipmentDefinition {
  slot: "weapon" | "armor" | "accessory";
  /** 修饰器 schema 与 src/logic/modifier.ts 一致。 */
  modifiers: ModifierTemplate[];
}

export interface RestoreEffectDefinition {
  type: "restore";
  attribute: string;
  amount: number;
}

export interface ConsumableDefinition {
  effects: RestoreEffectDefinition[];
}

export interface ItemDefinitionBase {
  id: string;
  displayName: string;
  kind: ItemKind;
  description: string;
  /** 单格最大堆叠数，缺省 1。 */
  maxStack?: number;
  /** 基准价值（货币单位），缺省 0。 */
  value?: number;
}

export interface EquipmentItemDefinition extends ItemDefinitionBase {
  kind: "equipment";
  equipment: EquipmentDefinition;
}

export interface ConsumableItemDefinition extends ItemDefinitionBase {
  kind: "consumable";
  consumable: ConsumableDefinition;
}

export interface MiscItemDefinition extends ItemDefinitionBase {
  kind: "misc";
}

export type ItemDefinition =
  | EquipmentItemDefinition
  | ConsumableItemDefinition
  | MiscItemDefinition;

export interface QuestObjectiveDefinition {
  id: string;
  type: "kill";
  enemyTemplateId: string;
  count: number;
}

export interface QuestRewardItemDefinition {
  itemId: string;
  quantity: number;
}

export interface QuestRewardDefinition {
  items?: QuestRewardItemDefinition[];
  modifiers?: ModifierTemplate[];
}

export interface QuestDefinition {
  id: string;
  title: string;
  description?: string;
  giverNpcId: string;
  /** 缺省为 giverNpcId。 */
  turnInNpcId?: string;
  objectives: QuestObjectiveDefinition[];
  rewards: QuestRewardDefinition;
}

/**
 * 角色色板卡（票 29）：每个主要角色一张。
 * 主色/辅色/点缀色 + 发色服装关键词；3D 贴图、立绘、头像同卡生成，
 * 保证资产之间配色不漂移（见 GLOSSARY「角色色板卡」）。
 */
export interface CharacterPaletteDefinition {
  id: string;
  displayName: string;
  /** 角色定位说明（村民/斥候/主角…），供生图时统一风格。 */
  role: string;
  /** 主色（对话框边、名字牌、3D tint 的主基调）。 */
  primary: string;
  /** 辅色（服装大面积）。 */
  secondary: string;
  /** 点缀色（装饰/高光）。 */
  accent: string;
  /** 发色关键词，如 "silver hair, long"。 */
  hairKeywords: string;
  /** 服装关键词，如 "linen robe, straw sandals"。 */
  costumeKeywords: string;
  /** 生成状态：pending 表示立绘/贴图尚未出图，允许使用程序化占位。 */
  status?: "pending" | "generated";
}

/**
 * 等级曲线（票 34）：累计经验 → 等级的阈值表；每级属性加成走修饰器模板。
 * 运行时解释口是 src/logic/leveling.ts。
 */
export interface LevelCurveFileDefinition {
  id: string;
  displayName: string;
  defaultModifiers: ModifierTemplate[];
  levels: Array<{
    level: number;
    xpRequired: number;
    modifiers?: ModifierTemplate[];
  }>;
}

/** 宝箱（票 37）：世界实体新类型，位置与战利品表都在内容里。 */
export interface ChestDefinition {
  id: string;
  displayName: string;
  regionId: string;
  position: Vec3;
  rotation?: Vec3;
  loot: Array<{ itemId: string; quantity: number }>;
}

/** 收集品（票 37）：拾取即进背包，计数聚合到 worldState。 */
export interface CollectibleDefinition {
  id: string;
  displayName: string;
  regionId: string;
  position: Vec3;
  rotation?: Vec3;
  itemId: string;
  quantity: number;
  /** 收集集 id；缺省时用自身 id 当集 id。 */
  setId?: string;
}

/** 收集集（票 37）：集内全收集后自动发一件饰品。 */
export interface CollectSetDefinition {
  id: string;
  displayName: string;
  rewardItemId: string;
  /** 奖励数量，缺省 1。 */
  rewardQuantity?: number;
}

/** 一个章节/切片的全量内容数据。 */
export interface ContentBundle {
  regions: RegionDefinition[];
  npcs: NpcDefinition[];
  enemyTemplates: EnemyTemplateDefinition[];
  enemies: EnemyDefinition[];
  items: ItemDefinition[];
  quests: QuestDefinition[];
  /** 角色色板卡（票 29）；缺省视为空集。 */
  characterPalettes?: CharacterPaletteDefinition[];
  /** 等级曲线（票 34）；缺省视为无成长系统。 */
  levelCurves?: LevelCurveFileDefinition[];
  /** 宝箱（票 37）；缺省视为空集。 */
  chests?: ChestDefinition[];
  /** 收集品（票 37）；缺省视为空集。 */
  collectibles?: CollectibleDefinition[];
  /** 收集集（票 37）；缺省视为无全收集奖励。 */
  collectSets?: CollectSetDefinition[];
}

/** 工具链扫描 ink 文件后交给校验器的对话元数据。 */
export interface DialogueQuestTag {
  kind: "offer" | "turnin";
  questId: string;
}

export interface DialogueInput {
  /** dialogueId = .ink 文件名（不含扩展名）。 */
  id: string;
  file: string;
  questTags: DialogueQuestTag[];
}

/** L2 校验使用的 JSON schema 集合；键名固定，方便工具与测试共用。 */
export interface ContentSchemas {
  common: object;
  region: object;
  npc: object;
  enemyTemplate: object;
  enemy: object;
  item: object;
  quest: object;
  characterPalette: object;
  levelCurve: object;
  chest: object;
  collectible: object;
  collectSet: object;
}

export type ContentIssueCode =
  | "schema"
  | "reference"
  | "duplicate-id"
  | "file-name"
  | "range"
  | "level-curve"
  | "dialogue-reference"
  /** 引用的资产文件不存在（仅当调用方注入 existingFiles 时才会产生）。 */
  | "asset"
  | "json"
  | "ink";

export interface ContentIssue {
  code: ContentIssueCode;
  /** 相对仓库根的文件路径。 */
  file: string;
  /** 出问题的 JSON 指针（根为 "/"）。 */
  path: string;
  message: string;
}

export interface ContentValidationResult {
  valid: boolean;
  issues: ContentIssue[];
}
