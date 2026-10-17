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
  | "level-curve";

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
  /** 角色色板卡 id；3D 贴图与立绘按同一张卡生成（票 29）。 */
  paletteId?: string;
  /** 立绘资源引用（表现层解释）；未生成时可缺省，UI 用程序化占位。 */
  portrait?: PortraitReference;
}

/** 立绘引用：资源路径 + 画面锚点（说话方/站位由表现层排布）。 */
export interface PortraitReference {
  /** 图片资源路径，如 assets/portraits/elder_ma.png。 */
  image: string;
  /** 生图提示词关键词留档，便于同卡重新生成时复用。 */
  keywords?: string[];
}

export interface DropDefinition {
  itemId: string;
  /** 掉落概率，0–1。 */
  chance: number;
  min: number;
  max: number;
}

export interface EnemyTemplateDefinition {
  id: string;
  displayName: string;
  /** 敌人 AI 档案 id，由逻辑层解释（P1 = melee_chaser 状态机）。 */
  aiProfileId: string;
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
}

export type ContentIssueCode =
  | "schema"
  | "reference"
  | "duplicate-id"
  | "file-name"
  | "range"
  | "level-curve"
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
