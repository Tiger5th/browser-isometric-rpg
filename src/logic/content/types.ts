/**
 * content/ 数据文件的 TypeScript 视图。
 *
 * 这些接口是 JSON schema（content/schema/*.schema.json）的运行时代码形态，
 * 二者必须保持同步：schema 是合同，本文件是消费者。字段含义见 content/README.md。
 */

import type { Vec3 } from "../entity";
import type { ModifierTemplate } from "../modifier";

/** 内容文件类别，与 content/ 下的目录一一对应。 */
export type ContentKind = "region" | "npc" | "enemy-template" | "enemy" | "item" | "quest";

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

/** 一个章节/切片的全量内容数据。 */
export interface ContentBundle {
  regions: RegionDefinition[];
  npcs: NpcDefinition[];
  enemyTemplates: EnemyTemplateDefinition[];
  enemies: EnemyDefinition[];
  items: ItemDefinition[];
  quests: QuestDefinition[];
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
}

export type ContentIssueCode =
  | "schema"
  | "reference"
  | "duplicate-id"
  | "file-name"
  | "range"
  | "dialogue-reference"
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
