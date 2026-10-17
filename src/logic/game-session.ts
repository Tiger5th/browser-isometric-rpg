/**
 * GameSession：游戏逻辑核心。
 *
 * 单一时钟 + 实体集合 + 战斗/对话/任务状态；渲染层只允许读取 snapshot()/drainEvents()
 * 并提交意图，不得直接访问或修改实体。本模块零引擎依赖，可在 vitest 中手动推进时间。
 *
 * 对话复用 P0 的 inkjs 封装（src/logic/dialogue.ts），任务状态机见 src/logic/quest.ts。
 *
 * 战斗（票 21）：
 * - 攻击是意图：attack() 设置目标，满足射程与冷却时立即结算一轮；
 *   之后的回合由 advance() 按冷却自动推进（回合制时间步进）。
 * - 属性一律取修饰器后的有效值：(base + Σadd) × (1 + Σmultiply)。
 * - 命中率 = clamp(0.9 + (accuracy - evasion) / 100, 0.05, 1)；
 *   伤害 = max(1, round(attack - defense))。
 * - 敌人 AI 状态机：idle → patrol → chase → attack → dead，全部在本模块内。
 * - 玩家死亡后 respawnDelayMs 回到区域出生点，生命回满；活着的敌人重置到出生点。
 *
 * 任务（票 22）：敌人死亡时统一经过 onEnemyKilled() 推进击杀目标；
 * 外部战斗系统也可通过 emitCombatEvent() 送入同样形状的事件。
 *
 * 反馈层（票 27）：命中/生命变化/拾取/升级作为一等订阅事件广播
 * （见 game-events.ts 的 DamageDealtEvent / HealthChangedEvent / ItemGainedEvent /
 * PlayerLevelUpEvent）。本模块只发布事实，不关心谁在播放飘字/音效。
 * `drainEvents()` 的战斗日志保持不变，面向逐帧回放消费方。
 */

import type { Story } from "inkjs";

import {
  continueDialogue,
  createDialogue,
  restoreDialogue,
  snapshotDialogue,
  type DialogueSnapshot,
} from "./dialogue";
import {
  cloneEntity,
  type Entity,
  type EntityId,
  type EntityIdentity,
  type ItemInstance,
  type Vec3,
} from "./entity";
import type {
  DamageDealtEvent,
  EnemyKilledEvent,
  GameSessionEvent,
  GameSessionEventListener,
} from "./game-events";
import {
  chargeDirection,
  coinPenaltyFor,
  kiteMoveTarget,
  resolveEnemyAiProfile,
  stepCharge,
  stepProjectile,
  type EnemyAiProfile,
  type ProjectileRuntime,
  type ProjectileSnapshot,
  type RangedKiteAiProfile,
  type WindupChargeAiProfile,
  type WorldObstacle,
} from "./enemy-ai";
import { createContentIndex, instantiateRegionEntities } from "./content/region-loader";
import type {
  ContentBundle,
  DropDefinition,
  ItemDefinition,
  QuestDefinition,
} from "./content/types";
import {
  createModifiers,
  effectiveAttributes,
  grantQuestReward,
  type Modifier,
} from "./modifier";
import { QuestLog, type QuestSnapshot } from "./quest";

/** 与 Crowd V2 的 maxSpeed 对齐，逻辑与表现的速度感一致。 */
export const DEFAULT_MOVE_SPEED = 5.5;
/**
 * 快照版本。
 * v2（票 22）：实体快照补充属性/背包/修饰器/战斗状态，顶层新增 dialogue 与 quests。
 * v2（票 23）：顶层补充 regionId / nextItemInstanceId / respawnAtMs，支持完整读档。
 * v3（票 27）：实体 combat 补充 heavyCooldownMs——重击有独立冷却，剩余时间必须
 * 随存档恢复，否则读档后重击按钮状态与逻辑不符。迁移链见 save.ts 的 v2→v3。
 * 后续成长系统（等级/经验）与世界状态挂在顶层新字段，不再动 combat 结构。
 */
export const GAME_SESSION_SNAPSHOT_VERSION = 3;

/** 战斗默认值；内容属性可用同名键覆盖（见 content/README.md）。 */
export const DEFAULT_ATTACK_RANGE = 2;
export const DEFAULT_ATTACK_INTERVAL_MS = 1000;
/** 重击默认冷却；内容属性 heavyAttackCooldownMs 可覆盖。 */
export const DEFAULT_HEAVY_ATTACK_COOLDOWN_MS = 8000;
/** 重击默认伤害倍率；内容属性 heavyAttackMultiplier 可覆盖。 */
export const DEFAULT_HEAVY_ATTACK_MULTIPLIER = 1.5;
/** 重击默认前摇（毫秒）；内容属性 heavyAttackWindupMs 可覆盖。 */
export const DEFAULT_HEAVY_ATTACK_WINDUP_MS = 600;
/** 敌人普攻前摇（毫秒）；内容属性 enemyAttackWindupMs 可覆盖。 */
export const DEFAULT_ENEMY_ATTACK_WINDUP_MS = 300;
export const BASE_HIT_CHANCE = 0.9;
export const DEFAULT_AGGRO_RADIUS = 8;
export const DEFAULT_PATROL_RADIUS = 4;
export const DEFAULT_IDLE_MS = 2000;
export const DEFAULT_RESPAWN_DELAY_MS = 1000;
/** 死亡惩罚：默认损失 10% 金币（向上取整）；内容可用 region.player.deathPenalty 覆盖。 */
export const DEFAULT_DEATH_PENALTY_COIN_ID = "item:old_coin";
export const DEFAULT_DEATH_PENALTY_RATE = 0.1;
/** 逻辑层角色/投射物的碰撞半径（与表现层 CHARACTER_COLLIDER_RADIUS 对齐）。 */
export const LOGIC_COLLIDER_RADIUS = 0.4;
/** 内部模拟固定步长：大 delta 也能稳定走位/结算，不受帧率影响。 */
const SIMULATION_STEP_MS = 100;

/**
 * 敌人 AI 状态。票 36 在既有 5 态之上加冲锋链路
 * （windup-charge → charge → recovery）与 kiting（kite = 远程吐弹的交战态）。
 */
export type EnemyAiState =
  | "idle"
  | "patrol"
  | "chase"
  | "attack"
  | "dead"
  | "windup-charge"
  | "charge"
  | "recovery"
  | "kite";

/** 渲染层可提交的意图集合；后续按票逐步扩展 useItem/equip 等。 */
export interface GameSessionIntents {
  moveTo(entityId: EntityId | string, target: Vec3): void;
  /** 与 NPC 开始对话；对话通过 ink 选项推进。 */
  talkTo(entityId: EntityId | string): void;
  /** 选择当前对话的第 index 个选项。 */
  chooseDialogueOption(index: number): void;
  /**
   * 外部战斗子系统的写入入口：把「敌人被击杀」事件送入会话。
   * 会话内部战斗（票 21）在敌人死亡时走同一个处理函数，无需重复调用。
   */
  emitCombatEvent(event: EnemyKilledEvent): void;
  /** 攻击目标；目标不在射程内时会自动接近（玩家）或进入追击（敌人）。 */
  attack(attackerId: EntityId | string, targetId: EntityId | string): void;
  /**
   * 重击意图（票 27）：复用 attack 的结算器，1.5 倍伤害、8000ms 独立冷却、
   * 更长前摇与更大飘字由反馈层消费 damage-dealt 的 heavy 标记实现。
   * 重击是一次性意图：本回合结算后自动回到普攻。
   */
  heavyAttack(attackerId: EntityId | string, targetId: EntityId | string): void;
  /** 取消自动攻击；不会取消已经发生的伤害。 */
  stopAttack(entityId: EntityId | string): void;
  /**
   * 使用背包中的消耗品。按内容定义结算 effects（当前支持恢复 hp），
   * 数量减一，归零后实例移除。
   */
  useItem(entityId: EntityId | string, instanceId: string): void;
  /** 装备背包中的装备；同槽位已有的装备会被自动卸下。 */
  equip(entityId: EntityId | string, instanceId: string): void;
  /** 卸下已装备的物品并移除其修饰器。 */
  unequip(entityId: EntityId | string, instanceId: string): void;
}

/**
 * 意图执行结果：UI 面向的友好拒绝。
 * 逻辑层原有方法仍然抛错（供测试/调用方发现编程错误）；`try*` 系列
 * 把「过期实例、无对话、目标已死亡」等可预期失败转成结构化结果，
 * 避免 DOM 事件处理器里冒出未捕获异常。
 */
export interface IntentResult {
  ok: boolean;
  message?: string;
}

export interface GameSessionOptions {
  /** [0,1) 随机源；默认确定性序列，测试可注入固定值。 */
  random?: () => number;
  /** 玩家死亡到重生的延迟（毫秒）。 */
  respawnDelayMs?: number;
  /** 死亡惩罚的金币物品 id；缺省 item:old_coin（内容可覆盖）。 */
  deathPenaltyCoinItemId?: string;
  /** 死亡惩罚的金币扣除比例；缺省 0.1（向上取整）。 */
  deathPenaltyRate?: number;
  /**
   * 硬碰撞障碍清单（票 36 冲锋挡停用）。形状与表现层票 28 的 PropCollider 兼容，
   * 场景把 buildPropColliders() 的结果交进来即可，碰撞与 navmesh 同源。
   */
  worldObstacles?: readonly WorldObstacle[];
}

export interface EntityMovementSnapshot {
  target: Vec3;
  speed: number;
}

export interface EntityCombatSnapshot {
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  alive: boolean;
  /** 敌人 AI 状态；玩家/NPC 为 null。 */
  aiState: EnemyAiState | null;
  targetId: EntityId | null;
  /** 距离下一轮攻击还需的毫秒数。 */
  attackCooldownMs: number;
  /** 距离下一次重击就绪还需的毫秒数（v3 新增；重击冷却独立于普攻间隔）。 */
  heavyCooldownMs: number;
}

export interface EntitySnapshot {
  id: EntityId;
  identity: EntityIdentity;
  position: Vec3;
  rotation: Vec3;
  tags: string[];
  /** 当前移动意图；null 表示静止。 */
  movement: EntityMovementSnapshot | null;
  /** 未经修饰器影响的基础属性。 */
  baseAttributes: Record<string, number>;
  /** 修饰器后的有效属性（hp 为基准值，当前生命看 combat.hp）。 */
  attributes: Record<string, number>;
  modifiers: Modifier[];
  combat: EntityCombatSnapshot;
  container: { items: ItemInstance[] };
  /** 一次性奖励领取账本，保证任务奖励不会重复发放。 */
  claimedRewardIds: string[];
}

/** 进行中的对话；story 的 ink 执行状态可完整序列化。 */
export interface GameDialogueSnapshot {
  npcId: EntityId;
  dialogueId: string;
  /** 当前停留点之前本次推进产生的文本（已 trim）。 */
  text: string;
  choices: string[];
  story: DialogueSnapshot;
}

export type CombatEvent =
  | {
      type: "attack";
      at: number;
      attackerId: EntityId;
      targetId: EntityId;
      hit: boolean;
      damage: number;
      targetHp: number;
      targetMaxHp: number;
    }
  | {
      type: "death";
      at: number;
      entityId: EntityId;
      kind: "player" | "enemy";
    }
  | {
      type: "xp";
      at: number;
      entityId: EntityId;
      amount: number;
      total: number;
    }
  | {
      type: "loot";
      at: number;
      entityId: EntityId;
      itemId: string;
      quantity: number;
    }
  | {
      type: "respawn";
      at: number;
      entityId: EntityId;
      position: Vec3;
    };

/** 可 JSON 序列化的完整游戏状态。 */
export interface GameSessionSnapshot {
  version: number;
  /** 已加载区域；会话尚未加载区域时为 null。 */
  regionId: string | null;
  elapsedMs: number;
  /** 下一个自动生成的物品实例序号；读档后继续保证实例 id 唯一。 */
  nextItemInstanceId: number;
  /** 玩家死亡后的重生时刻；无待重生时为 null。 */
  respawnAtMs: number | null;
  entities: EntitySnapshot[];
  /** 无进行中的对话时为 null。 */
  dialogue: GameDialogueSnapshot | null;
  /** 全部任务的当前状态（含尚未接取的 available）。 */
  quests: QuestSnapshot[];
}

interface Movement {
  target: Vec3;
  speed: number;
}

interface ActiveDialogue {
  npcId: EntityId;
  dialogueId: string;
  story: Story;
  /** 最近一次推进后的 ink 状态；避免每帧 snapshot() 重复 ToJson。 */
  storySnapshot: DialogueSnapshot;
  text: string;
  choices: string[];
}

/** 对话标签：`# quest:offer:<questId>` / `# quest:turnin:<questId>`。 */
const QUEST_TAG_PATTERN = /^quest:(offer|turnin):(quest:[a-z0-9_]+)$/;

interface CombatRuntime {
  hp: number;
  alive: boolean;
  cooldownMs: number;
  /** 重击冷却剩余毫秒；普攻冷却用 cooldownMs。 */
  heavyCooldownMs: number;
  /** 下一次结算是否为重击（一次性意图，结算后失效）。 */
  heavyStrike: boolean;
  /** 前摇剩余毫秒；>0 表示已锁定目标、等待抬手结束。 */
  windupMs: number;
  /** 前摇结束后是否结算为重击。 */
  windupHeavy: boolean;
  /** 前摇刚结束、下一次 resolve 直接结算（不再重新起前摇）。 */
  windupReady: boolean;
  targetId: EntityId | null;
  aiState: EnemyAiState | null;
  idleMs: number;
  patrolIndex: number;
  /** 票 36：冲锋链路状态（windup 剩余、冲锋已走距离、recovery 剩余）。 */
  chargeWindupMs: number;
  chargeRemaining: number;
  chargeRemainingMs: number;
  /** 冲锋方向在前摇结束时锁定，冲锋途中不再跟随目标。 */
  chargeDir: { x: number; z: number } | null;
  /** 本次冲锋是否已结算过伤害（一次冲锋只打一下）。 */
  chargeHit: boolean;
  /** 吐弹型开火倒计时。 */
  fireCooldownMs: number;
  /** 逻辑层投射物编号。 */
  projectilesFired: number;
}

interface SpawnRecord {
  position: Vec3;
  rotation: Vec3;
}

interface EnemyProfile {
  aiProfileId: string;
  drops: DropDefinition[];
  /** 票 36：aiProfile 档案；缺省 = 既有 chaser 状态机。 */
  aiProfile: EnemyAiProfile | null;
}

function assertFiniteVec3(value: Vec3, label: string): void {
  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isFinite(value[axis])) {
      throw new Error(`${label} 的 ${axis} 必须是有限数值`);
    }
  }
}

function cloneVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function cloneModifier(modifier: Modifier): Modifier {
  return { ...modifier, source: { ...modifier.source } };
}

function assertAttributesRecord(
  attributes: Record<string, number>,
  label: string,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (key.trim() === "" || !Number.isFinite(value)) {
      throw new Error(`${label} 的属性 ${key || "(空)"} 必须是有限数值`);
    }
  }
}

/**
 * 读档前的修饰器结构校验。
 * 损坏存档若把 value 注入成字符串，会在 effectiveAttributes 里产生
 * NaN 或字符串拼接（如 '1205'），因此必须在写入前整体拒绝。
 */
function assertModifierShape(value: unknown, label: string): asserts value is Modifier {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} 必须是对象`);
  }
  const modifier = value as Partial<Modifier>;
  if (typeof modifier.id !== "string" || modifier.id.trim() === "") {
    throw new Error(`${label} 的 id 必须是非空字符串`);
  }
  if (
    typeof modifier.attribute !== "string" ||
    modifier.attribute.trim() === ""
  ) {
    throw new Error(`${label} 的 attribute 必须是非空字符串`);
  }
  if (modifier.operation !== "add" && modifier.operation !== "multiply") {
    throw new Error(`${label} 的 operation 非法：${String(modifier.operation)}`);
  }
  if (typeof modifier.value !== "number" || !Number.isFinite(modifier.value)) {
    throw new Error(`${label} 的 value 必须是有限数值`);
  }
  const source = modifier.source;
  if (typeof source !== "object" || source === null) {
    throw new Error(`${label} 的 source 必须是对象`);
  }
  if (
    source.kind !== "equipment" &&
    source.kind !== "buff" &&
    source.kind !== "quest"
  ) {
    throw new Error(`${label} 的 source.kind 非法：${String(source.kind)}`);
  }
  if (typeof source.id !== "string" || source.id.trim() === "") {
    throw new Error(`${label} 的 source.id 必须是非空字符串`);
  }
  if (
    modifier.expiresAt !== undefined &&
    (typeof modifier.expiresAt !== "number" || !Number.isFinite(modifier.expiresAt))
  ) {
    throw new Error(`${label} 的 expiresAt 必须是有限数值`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} 必须是字符串数组`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

/** 确定性随机源（mulberry32）：同一会话同一操作序列结果可复现。 */
function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class GameSession implements GameSessionIntents {
  /** 以 EntityId 为键；值本身也不对外暴露，避免渲染层绕过意图直接修改。 */
  private readonly entities = new Map<EntityId, Entity>();
  private readonly movements = new Map<EntityId, Movement>();
  private readonly dialogues = new Map<string, string | Record<string, unknown>>();
  private readonly eventListeners = new Set<GameSessionEventListener>();
  private readonly questDefinitions = new Map<string, QuestDefinition>();
  private questLog = new QuestLog([]);
  private dialogue: ActiveDialogue | null = null;
  private readonly combat = new Map<EntityId, CombatRuntime>();
  private readonly spawns = new Map<EntityId, SpawnRecord>();
  private readonly enemyProfiles = new Map<EntityId, EnemyProfile>();
  private readonly itemDefinitions = new Map<string, ItemDefinition>();
  private readonly projectiles = new Map<string, ProjectileRuntime>();
  private obstacles: readonly WorldObstacle[];
  private readonly deathPenaltyCoinItemId: string;
  private readonly deathPenaltyRate: number;
  private readonly events: CombatEvent[] = [];
  /** 上一次广播过的生命值；health-changed 只在数值真变时发布。 */
  private readonly lastPublishedHp = new Map<EntityId, number>();
  private readonly random: () => number;
  private readonly respawnDelayMs: number;
  private elapsedMs = 0;
  private regionId: string | null = null;
  private playerId: EntityId | null = null;
  private respawnAtMs: number | null = null;
  private nextItemInstanceId = 1;

  constructor(options: GameSessionOptions = {}) {
    this.random = options.random ?? createSeededRandom(0x5eed);
    this.obstacles = options.worldObstacles ?? [];
    this.deathPenaltyCoinItemId =
      options.deathPenaltyCoinItemId ?? DEFAULT_DEATH_PENALTY_COIN_ID;
    const rate = options.deathPenaltyRate ?? DEFAULT_DEATH_PENALTY_RATE;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error("deathPenaltyRate 必须在 [0,1] 之间");
    }
    this.deathPenaltyRate = rate;
    const delay = options.respawnDelayMs ?? DEFAULT_RESPAWN_DELAY_MS;
    if (!Number.isFinite(delay) || delay < 0) {
      throw new Error("respawnDelayMs 必须是非负有限数值");
    }
    this.respawnDelayMs = delay;
  }

  /** 注册编译后的 ink JSON（dialogueId = content/dialogues/<id>.ink 的文件名）。 */
  registerDialogue(dialogueId: string, compiledJson: string | Record<string, unknown>): void {
    if (dialogueId.trim() === "") {
      throw new Error("dialogueId 不能为空");
    }
    if (this.dialogues.has(dialogueId)) {
      throw new Error(`对话已注册：${dialogueId}`);
    }
    this.dialogues.set(dialogueId, compiledJson);
  }

  /** 注册实体。实体在入会话时深拷贝，调用方后续修改不会穿透逻辑状态。 */
  addEntity(entity: Entity): void {
    if (this.entities.has(entity.id)) {
      throw new Error(`实体已存在：${entity.id}`);
    }
    const cloned = cloneEntity(entity);
    this.entities.set(cloned.id, cloned);
    this.spawns.set(cloned.id, {
      position: cloneVec3(cloned.state.position),
      rotation: cloneVec3(cloned.state.rotation),
    });
    if (cloned.identity.type === "player" && this.playerId === null) {
      this.playerId = cloned.id;
    }

    const attributes = effectiveAttributes(cloned, this.elapsedMs);
    const maxHp = Math.max(1, attributes.maxHp ?? attributes.hp ?? 1);
    const baseHp = cloned.baseAttributes.hp ?? maxHp;
    this.combat.set(cloned.id, {
      hp: clamp(baseHp, 0, maxHp),
      alive: baseHp > 0,
      cooldownMs: 0,
      heavyCooldownMs: 0,
      heavyStrike: false,
      windupMs: 0,
      windupHeavy: false,
      windupReady: false,
      targetId: null,
      aiState: cloned.identity.type === "enemy" ? "idle" : null,
      idleMs: 0,
      patrolIndex: 0,
      chargeWindupMs: 0,
      chargeRemaining: 0,
      chargeRemainingMs: 0,
      chargeDir: null,
      chargeHit: false,
      fireCooldownMs: 0,
      projectilesFired: 0,
    });
    this.lastPublishedHp.set(cloned.id, this.combat.get(cloned.id)!.hp);

    if (cloned.identity.type === "enemy") {
      this.enemyProfiles.set(cloned.id, {
        aiProfileId: cloned.references.aiProfileId ?? "ai:melee_chaser",
        drops: [],
        aiProfile: null,
      });
    }
  }

  /**
   * 从内容数据加载一个区域：实例化玩家 + 本区域 NPC/敌人并注册实体，
   * 同时初始化任务表。P1 只支持单区域会话，重复加载会显式报错。
   */
  loadRegion(bundle: ContentBundle, regionId: string): void {
    if (this.regionId !== null) {
      throw new Error(`已加载区域 ${this.regionId}，P1 不支持切换区域`);
    }
    const index = createContentIndex(bundle);
    const region = index.regions.get(regionId);
    if (region === undefined) {
      throw new Error(`未知区域：${regionId}`);
    }
    const entities = instantiateRegionEntities(index, regionId);
    // 先整体检查再写入，避免中途失败留下半加载状态。
    for (const entity of entities) {
      if (this.entities.has(entity.id)) {
        throw new Error(`实体已存在：${entity.id}`);
      }
    }
    for (const entity of entities) {
      this.addEntity(entity);
    }

    this.questDefinitions.clear();
    for (const quest of bundle.quests) {
      this.questDefinitions.set(quest.id, quest);
    }
    this.questLog = new QuestLog(bundle.quests);

    for (const item of index.items.values()) {
      this.itemDefinitions.set(item.id, structuredClone(item));
    }

    // 出生物品（当前只有死亡轻惩罚要用的金币）。物品定义已就绪，直接入包。
    const player = this.requirePlayer();
    for (const starting of region.player.startingItems ?? []) {
      this.addItem(player, starting.itemId, starting.quantity);
    }

    for (const enemy of index.enemies.values()) {
      if (enemy.regionId !== regionId) {
        continue;
      }
      const template = index.enemyTemplates.get(enemy.templateId);
      if (!template) {
        throw new Error(`敌人 ${enemy.id} 引用了未知模板：${enemy.templateId}`);
      }
      this.enemyProfiles.set(enemy.id as EntityId, {
        aiProfileId: template.aiProfileId,
        drops: (template.drops ?? []).map((drop) => ({ ...drop })),
        aiProfile: resolveEnemyAiProfile(template.aiProfile),
      });
    }

    this.regionId = regionId;
  }

  /** 当前已加载的区域 id；未加载时为 null。 */
  get currentRegionId(): string | null {
    return this.regionId;
  }

  /** 提交移动到目标点的意图；重复提交会替换当前移动，并取消攻击目标。 */
  moveTo(entityId: EntityId | string, target: Vec3): void {
    const id = entityId as EntityId;
    const entity = this.entities.get(id);
    if (!entity) {
      throw new Error(`未知实体：${entityId}`);
    }
    assertFiniteVec3(target, "移动目标");
    const runtime = this.combat.get(id);
    if (runtime) {
      runtime.targetId = null;
      // 走 A：移动永远打断攻击意图，包括已经起手的普攻/重击前摇。
      runtime.windupMs = 0;
      runtime.windupReady = false;
      runtime.heavyStrike = false;
      if (runtime.aiState === "chase" || runtime.aiState === "attack") {
        runtime.aiState = "idle";
        runtime.idleMs = 0;
      }
    }
    // 与攻击自动接近一致：点击移动也使用修饰器后的有效移动速度。
    this.movements.set(id, {
      target: cloneVec3(target),
      speed: this.moveSpeedOf(entity),
    });
  }

  /** 与 NPC 开始对话；ink 停在首个选择点或 END。 */
  talkTo(entityId: EntityId | string): void {
    const id = entityId as EntityId;
    const entity = this.entities.get(id);
    if (!entity) {
      throw new Error(`未知实体：${entityId}`);
    }
    if (this.dialogue !== null) {
      throw new Error(`已有对话进行中：${this.dialogue.npcId}`);
    }
    const dialogueId = entity.references.dialogueId;
    if (dialogueId === undefined) {
      throw new Error(`实体没有对话：${entityId}`);
    }
    const compiled = this.dialogues.get(dialogueId);
    if (compiled === undefined) {
      throw new Error(`对话未注册：${dialogueId}`);
    }

    const story = createDialogue(compiled);
    this.bindDialogueFunctions(story);
    this.dialogue = {
      npcId: id,
      dialogueId,
      story,
      storySnapshot: snapshotDialogue(story),
      text: "",
      choices: [],
    };
    this.publish({ type: "dialogue-started", npcId: id, dialogueId });
    this.continueDialogueState();
  }

  /** 实体是否有可用对话（有 dialogueId 且已注册编译结果）。 */
  canTalkTo(entityId: EntityId | string): boolean {
    const entity = this.entities.get(entityId as EntityId);
    if (entity === undefined) {
      return false;
    }
    const dialogueId = entity.references.dialogueId;
    return dialogueId !== undefined && this.dialogues.has(dialogueId);
  }

  /** 无异常版本的 talkTo；无对话/未知实体返回 ok=false。 */
  tryTalkTo(entityId: EntityId | string): IntentResult {
    return this.runIntent(() => this.talkTo(entityId));
  }

  /** 无异常版本的 useItem；过期实例等可预期失败返回 ok=false。 */
  tryUseItem(entityId: EntityId | string, instanceId: string): IntentResult {
    return this.runIntent(() => this.useItem(entityId, instanceId));
  }

  /** 无异常版本的 equip。 */
  tryEquip(entityId: EntityId | string, instanceId: string): IntentResult {
    return this.runIntent(() => this.equip(entityId, instanceId));
  }

  /** 无异常版本的 unequip。 */
  tryUnequip(entityId: EntityId | string, instanceId: string): IntentResult {
    return this.runIntent(() => this.unequip(entityId, instanceId));
  }

  /** 无异常版本的 attack；玩家死亡/目标死亡等返回 ok=false。 */
  tryAttack(attackerId: EntityId | string, targetId: EntityId | string): IntentResult {
    return this.runIntent(() => this.attack(attackerId, targetId));
  }

  private runIntent(action: () => void): IntentResult {
    try {
      action();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 选择当前对话选项；推进后若故事结束则自动关闭对话。 */
  chooseDialogueOption(index: number): void {
    if (this.dialogue === null) {
      throw new Error("没有进行中的对话");
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.dialogue.choices.length) {
      throw new Error(
        `选项索引越界：${String(index)}（共 ${this.dialogue.choices.length} 项）`,
      );
    }
    this.dialogue.story.ChooseChoiceIndex(index);
    this.continueDialogueState();
  }

  /**
   * 外部战斗事件入口（票 21 合并后，会话内战斗在敌人死亡时直接走同一处理函数）。
   * 本票只消费 enemy-killed 推进任务；若外部事件形状不同，合并时做适配即可。
   */
  emitCombatEvent(event: EnemyKilledEvent): void {
    if (event.type !== "enemy-killed") {
      throw new Error(`未知战斗事件：${String((event as { type?: unknown }).type)}`);
    }
    if (typeof event.enemyId !== "string" || event.enemyId.trim() === "") {
      throw new Error("战斗事件缺少 enemyId");
    }
    if (
      typeof event.enemyTemplateId !== "string" ||
      event.enemyTemplateId.trim() === ""
    ) {
      throw new Error("战斗事件缺少 enemyTemplateId");
    }

    this.onEnemyKilled(event.enemyId, event.enemyTemplateId, event.killerId);
  }

  /** 订阅会话事件；返回取消订阅函数。 */
  subscribe(listener: GameSessionEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** 提交攻击意图；射程内且冷却就绪时立即结算一轮。 */
  attack(attackerId: EntityId | string, targetId: EntityId | string): void {
    const attacker = this.requireEntity(attackerId);
    const target = this.requireEntity(targetId);
    if (attacker.id === target.id) {
      throw new Error("不能攻击自己");
    }
    if (attacker.identity.type === "player" && target.identity.type !== "enemy") {
      throw new Error(`玩家只能攻击敌人：${target.id}`);
    }
    if (attacker.identity.type === "enemy" && target.identity.type !== "player") {
      throw new Error(`敌人只能攻击玩家：${target.id}`);
    }
    const attackerRuntime = this.combat.get(attacker.id);
    const targetRuntime = this.combat.get(target.id);
    if (!attackerRuntime || !targetRuntime) {
      throw new Error(`实体缺少战斗状态：${attacker.id}`);
    }
    if (!attackerRuntime.alive) {
      throw new Error(`已死亡的实体不能攻击：${attacker.id}`);
    }
    if (!targetRuntime.alive) {
      throw new Error(`目标已死亡：${target.id}`);
    }

    this.movements.delete(attacker.id);
    attackerRuntime.targetId = target.id;
    if (attacker.identity.type === "enemy") {
      attackerRuntime.aiState = "chase";
      attackerRuntime.idleMs = 0;
    }
    this.faceTarget(attacker);
    this.resolveAttackIfReady(attacker.id);
  }

  /**
   * 重击意图：与 attack 同一套校验/接近逻辑，差别只在倍率与冷却。
   * 复用结算器（resolveAttackIfReady）保证命中率/自动回合/事件流不分裂。
   */
  heavyAttack(attackerId: EntityId | string, targetId: EntityId | string): void {
    const attacker = this.requireEntity(attackerId);
    const target = this.requireEntity(targetId);
    if (attacker.id === target.id) {
      throw new Error("不能攻击自己");
    }
    if (attacker.identity.type === "player" && target.identity.type !== "enemy") {
      throw new Error(`玩家只能攻击敌人：${target.id}`);
    }
    if (attacker.identity.type === "enemy" && target.identity.type !== "player") {
      throw new Error(`敌人只能攻击玩家：${target.id}`);
    }
    const attackerRuntime = this.combat.get(attacker.id);
    const targetRuntime = this.combat.get(target.id);
    if (!attackerRuntime || !targetRuntime) {
      throw new Error(`实体缺少战斗状态：${attacker.id}`);
    }
    if (!attackerRuntime.alive) {
      throw new Error(`已死亡的实体不能攻击：${attacker.id}`);
    }
    if (!targetRuntime.alive) {
      throw new Error(`目标已死亡：${target.id}`);
    }
    if (attackerRuntime.heavyCooldownMs > 0) {
      throw new Error(
        `重击冷却中（剩余 ${Math.ceil(attackerRuntime.heavyCooldownMs)}ms）`,
      );
    }

    this.movements.delete(attacker.id);
    attackerRuntime.targetId = target.id;
    attackerRuntime.heavyStrike = true;
    if (attacker.identity.type === "enemy") {
      attackerRuntime.aiState = "chase";
      attackerRuntime.idleMs = 0;
    }
    this.faceTarget(attacker);
    this.resolveAttackIfReady(attacker.id);
  }

  /** 无异常版本的 heavyAttack。 */
  tryHeavyAttack(
    attackerId: EntityId | string,
    targetId: EntityId | string,
  ): IntentResult {
    return this.runIntent(() => this.heavyAttack(attackerId, targetId));
  }

  /** 攻击/重击结算时面向目标（+Z 为 0，朝 +X 为 π/2，与移动一致）。 */
  private faceTarget(attacker: Entity): void {
    const runtime = this.combat.get(attacker.id);
    if (!runtime || runtime.targetId === null) {
      return;
    }
    const target = this.entities.get(runtime.targetId);
    if (!target) {
      return;
    }
    const dx = target.state.position.x - attacker.state.position.x;
    const dz = target.state.position.z - attacker.state.position.z;
    if (dx === 0 && dz === 0) {
      return;
    }
    attacker.state.rotation.y = Math.atan2(dx, dz);
  }

  /** 取消自动攻击；已经结算的回合不受影响。 */
  stopAttack(entityId: EntityId | string): void {
    const id = entityId as EntityId;
    const runtime = this.combat.get(id);
    if (!runtime) {
      throw new Error(`未知实体：${entityId}`);
    }
    runtime.targetId = null;
    runtime.windupMs = 0;
    runtime.windupReady = false;
    runtime.heavyStrike = false;
    this.movements.delete(id); // 自动接近的移动随攻击取消。
    if (runtime.aiState === "chase" || runtime.aiState === "attack") {
      runtime.aiState = "idle";
      runtime.idleMs = 0;
    }
  }

  /**
   * 使用消耗品意图。效果按内容定义结算：
   * - `restore:hp` 恢复当前生命，不超过修饰器后的 maxHp；
   * - 其他属性暂没有「当前值」概念，显式报错避免静默无效。
   * 无论治疗是否溢出，物品都会被消耗（与常见 RPG 一致）。
   */
  useItem(entityId: EntityId | string, instanceId: string): void {
    const entity = this.requireEntity(entityId);
    const item = this.requireItem(entity, instanceId);
    const definition = this.itemDefinitions.get(item.templateId);
    if (definition === undefined) {
      throw new Error(`物品缺少内容定义：${item.templateId}`);
    }
    if (definition.kind !== "consumable") {
      throw new Error(`物品不可使用：${definition.displayName}`);
    }
    const runtime = this.combat.get(entity.id);
    if (runtime === undefined) {
      throw new Error(`实体缺少战斗状态：${entity.id}`);
    }
    if (!runtime.alive) {
      throw new Error(`已倒下的实体不能使用物品：${entity.id}`);
    }

    // 先全量校验再应用：任一效果不支持时整体拒绝，避免出现
    // 「第一条 restore 已生效、第二条才抛错」的半生效状态。
    for (const effect of definition.consumable.effects) {
      if (effect.type !== "restore") {
        throw new Error(`未知消耗品效果：${String((effect as { type?: unknown }).type)}`);
      }
      if (effect.attribute !== "hp") {
        throw new Error(`暂不支持恢复属性：${effect.attribute}`);
      }
      if (typeof effect.amount !== "number" || !Number.isFinite(effect.amount)) {
        throw new Error(`消耗品恢复量必须是有限数值：${String(effect.amount)}`);
      }
    }
    for (const effect of definition.consumable.effects) {
      runtime.hp = Math.min(
        this.maxHpOf(entity),
        runtime.hp + Math.max(0, effect.amount),
      );
    }
    this.publishHealthChange(entity, "heal");

    item.quantity -= 1;
    if (item.quantity <= 0) {
      entity.container.items = entity.container.items.filter(
        (candidate) => candidate.instanceId !== instanceId,
      );
    }
  }

  /**
   * 装备意图：标记 equipped、挂上修饰器（source = equipment:<instanceId>）。
   * 同一槽位同时只能装备一件，已有装备先卸下。
   */
  equip(entityId: EntityId | string, instanceId: string): void {
    const entity = this.requireEntity(entityId);
    const item = this.requireItem(entity, instanceId);
    const definition = this.requireEquipmentDefinition(item);
    if (item.equipped) {
      return;
    }

    const slot = definition.equipment.slot;
    for (const other of [...entity.container.items]) {
      if (!other.equipped || other.instanceId === instanceId) {
        continue;
      }
      const otherDefinition = this.itemDefinitions.get(other.templateId);
      if (
        otherDefinition?.kind === "equipment" &&
        otherDefinition.equipment.slot === slot
      ) {
        this.unequipItem(entity, other);
      }
    }

    item.equipped = true;
    entity.modifiers = [
      ...entity.modifiers,
      ...createModifiers(definition.equipment.modifiers, {
        kind: "equipment",
        id: instanceId,
      }),
    ];
    this.clampHp(entity);
  }

  /** 卸下装备意图：清标记并移除该实例贡献的全部修饰器。 */
  unequip(entityId: EntityId | string, instanceId: string): void {
    const entity = this.requireEntity(entityId);
    const item = this.requireItem(entity, instanceId);
    this.requireEquipmentDefinition(item);
    if (!item.equipped) {
      return;
    }
    this.unequipItem(entity, item);
    this.clampHp(entity);
  }

  private requireItem(entity: Entity, instanceId: string) {
    const item = entity.container.items.find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (item === undefined) {
      throw new Error(`未知物品实例：${instanceId}`);
    }
    return item;
  }

  private requireEquipmentDefinition(item: ItemInstance) {
    const definition = this.itemDefinitions.get(item.templateId);
    if (definition === undefined) {
      throw new Error(`物品缺少内容定义：${item.templateId}`);
    }
    if (definition.kind !== "equipment") {
      throw new Error(`物品不可装备：${definition.displayName}`);
    }
    return definition;
  }

  private unequipItem(entity: Entity, item: ItemInstance): void {
    item.equipped = false;
    entity.modifiers = entity.modifiers.filter(
      (modifier) =>
        modifier.source.kind !== "equipment" || modifier.source.id !== item.instanceId,
    );
  }

  /** 修饰器变化后把当前生命夹回新的上限。 */
  private clampHp(entity: Entity): void {
    const runtime = this.combat.get(entity.id);
    if (runtime !== undefined) {
      runtime.hp = Math.min(runtime.hp, this.maxHpOf(entity));
    }
  }

  /** 取走并清空自上次调用以来的战斗事件（攻击/死亡/经验/掉落/重生）。 */
  /**
   * 设置硬碰撞障碍清单（票 36）。场景把 world-physics.buildPropColliders()
   * 的结果传进来，冲锋被挡停与投射物撞墙共用这一份数据；navmesh 也由同一份
   * collider 生成（colliderObstacleSpecs），因此碰撞与寻路不会漂移。
   * 纯数据、可在会话运行中替换（关卡切换）。
   */
  setWorldObstacles(obstacles: readonly WorldObstacle[]): void {
    this.obstacles = [...obstacles];
  }

  /** 逻辑层投射物快照（位置/半径/归属）；表现层只渲染，不参与结算。 */
  projectileSnapshots(): ProjectileSnapshot[] {
    return [...this.projectiles.values()]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((projectile) => ({
        id: projectile.id,
        ownerId: projectile.ownerId,
        position: cloneVec3(projectile.position),
        radius: projectile.radius,
      }));
  }

  drainEvents(): CombatEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** 手动推进游戏时钟（毫秒）。deltaMs 必须是非负有限值。 */
  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new Error("advance 的 deltaMs 必须是非负有限数值");
    }

    let remaining = deltaMs;
    while (remaining > 1e-9) {
      const step = Math.min(remaining, SIMULATION_STEP_MS);
      this.step(step);
      remaining -= step;
    }
  }

  private requireEntity(entityId: EntityId | string): Entity {
    const entity = this.entities.get(entityId as EntityId);
    if (!entity) {
      throw new Error(`未知实体：${entityId}`);
    }
    return entity;
  }

  private attributesOf(entity: Entity): Record<string, number> {
    return effectiveAttributes(entity, this.elapsedMs);
  }

  private maxHpOf(entity: Entity): number {
    const attributes = this.attributesOf(entity);
    return Math.max(1, attributes.maxHp ?? attributes.hp ?? 1);
  }

  private attackRangeOf(entity: Entity): number {
    const attributes = this.attributesOf(entity);
    return Math.max(0, attributes.attackRange ?? DEFAULT_ATTACK_RANGE);
  }

  private attackIntervalOf(entity: Entity): number {
    const attributes = this.attributesOf(entity);
    return Math.max(1, attributes.attackIntervalMs ?? DEFAULT_ATTACK_INTERVAL_MS);
  }

  /**
   * 前摇时长（毫秒）：
   * - 重击：heavyAttackWindupMs（默认 600，更长抬手）；
   * - 敌人普攻：enemyAttackWindupMs（默认 300，给玩家 0.3 秒走位窗口）；
   * - 玩家普攻：0（点按即时反馈）。
   */
  private attackWindupOf(
    attacker: Entity,
    heavy: boolean,
    attributes: Record<string, number>,
  ): number {
    if (heavy) {
      return Math.max(
        0,
        Math.round(attributes.heavyAttackWindupMs ?? DEFAULT_HEAVY_ATTACK_WINDUP_MS),
      );
    }
    if (attacker.identity.type === "enemy") {
      return Math.max(
        0,
        Math.round(attributes.enemyAttackWindupMs ?? DEFAULT_ENEMY_ATTACK_WINDUP_MS),
      );
    }
    return 0;
  }

  private moveSpeedOf(entity: Entity): number {
    const attributes = this.attributesOf(entity);
    return Math.max(0, attributes.moveSpeed ?? DEFAULT_MOVE_SPEED);
  }

  /** 一个内部模拟步：重生检查 → 冷却 → AI/接近 → 移动 → 攻击结算。 */
  private step(stepMs: number): void {
    this.elapsedMs += stepMs;
    this.processRespawn();

    for (const runtime of this.combat.values()) {
      if (runtime.cooldownMs > 0) {
        runtime.cooldownMs = Math.max(0, runtime.cooldownMs - stepMs);
      }
      if (runtime.heavyCooldownMs > 0) {
        runtime.heavyCooldownMs = Math.max(0, runtime.heavyCooldownMs - stepMs);
      }
      if (runtime.windupMs > 0) {
        runtime.windupMs = Math.max(0, runtime.windupMs - stepMs);
        if (runtime.windupMs === 0) {
          runtime.windupReady = true;
        }
      }
    }

    const ids = [...this.entities.keys()].sort() as EntityId[];
    for (const id of ids) {
      this.updateBehavior(id, stepMs);
    }
    this.moveEntities(stepMs);
    this.stepProjectiles(stepMs);
    for (const id of ids) {
      this.resolveAttackIfReady(id);
    }
  }

  /** 玩家重生：回出生点、生命回满；活着的敌人重置到出生点，避免蹲尸。 */
  private processRespawn(): void {
    if (this.playerId === null || this.respawnAtMs === null) {
      return;
    }
    if (this.elapsedMs < this.respawnAtMs) {
      return;
    }
    this.respawnAtMs = null;

    const player = this.entities.get(this.playerId);
    const runtime = this.combat.get(this.playerId);
    const spawn = this.spawns.get(this.playerId);
    if (!player || !runtime || !spawn) {
      return;
    }

    runtime.hp = this.maxHpOf(player);
    runtime.alive = true;
    runtime.cooldownMs = 0;
    runtime.targetId = null;
    // 空中残留的投射物随重生一起消失，避免落地即中弹。
    this.projectiles.clear();
    player.state.position = cloneVec3(spawn.position);
    player.state.rotation = cloneVec3(spawn.rotation);
    this.movements.delete(player.id);

    for (const [id, other] of this.entities) {
      if (other.identity.type !== "enemy") {
        continue;
      }
      const otherRuntime = this.combat.get(id);
      const otherSpawn = this.spawns.get(id);
      if (!otherRuntime || !otherSpawn) {
        continue;
      }
      this.movements.delete(id);
      otherRuntime.targetId = null;
      otherRuntime.cooldownMs = 0;
      otherRuntime.idleMs = 0;
      otherRuntime.patrolIndex = 0;
      otherRuntime.chargeWindupMs = 0;
      otherRuntime.chargeRemaining = 0;
      otherRuntime.chargeRemainingMs = 0;
      otherRuntime.chargeDir = null;
      otherRuntime.chargeHit = false;
      otherRuntime.fireCooldownMs = 0;
      if (!otherRuntime.alive) {
        continue; // P1：已死亡的敌人不随玩家重生刷新。
      }
      other.state.position = cloneVec3(otherSpawn.position);
      other.state.rotation = cloneVec3(otherSpawn.rotation);
      otherRuntime.hp = this.maxHpOf(other);
      otherRuntime.aiState = "idle";
      // 重生瞬间给一次完整攻击间隔的缓冲，避免敌人同一帧再次击杀玩家。
      otherRuntime.cooldownMs = this.attackIntervalOf(other);
    }

    this.events.push({
      type: "respawn",
      at: this.elapsedMs,
      entityId: player.id,
      position: cloneVec3(player.state.position),
    });
  }

  private updateBehavior(id: EntityId, stepMs: number): void {
    const entity = this.entities.get(id);
    const runtime = this.combat.get(id);
    if (!entity || !runtime || !runtime.alive) {
      return;
    }

    if (entity.identity.type === "enemy") {
      this.updateEnemyBehavior(entity, runtime, stepMs);
      return;
    }

    // 玩家/NPC：有攻击目标且不在射程内时自动接近（点击敌人后的追击）。
    if (runtime.targetId === null) {
      return;
    }
    const target = this.entities.get(runtime.targetId);
    const targetRuntime = this.combat.get(runtime.targetId);
    if (!target || !targetRuntime || !targetRuntime.alive) {
      runtime.targetId = null;
      runtime.windupMs = 0;
      runtime.windupReady = false;
      return;
    }
    const distance = horizontalDistance(entity.state.position, target.state.position);
    if (distance <= this.attackRangeOf(entity)) {
      this.movements.delete(id);
      return;
    }
    this.movements.set(id, {
      target: cloneVec3(target.state.position),
      speed: this.moveSpeedOf(entity),
    });
  }

  private updateEnemyBehavior(
    entity: Entity,
    runtime: CombatRuntime,
    stepMs: number,
  ): void {
    const profile = this.enemyProfiles.get(entity.id)?.aiProfile ?? null;
    if (profile?.kind === "windup-charge") {
      this.updateChargeBehavior(entity, runtime, profile, stepMs);
      return;
    }
    if (profile?.kind === "ranged-kite") {
      this.updateKiteBehavior(entity, runtime, profile, stepMs);
      return;
    }
    const player = this.playerId === null ? undefined : this.entities.get(this.playerId);
    const playerRuntime =
      this.playerId === null ? undefined : this.combat.get(this.playerId);

    if (!player || !playerRuntime || !playerRuntime.alive) {
      runtime.targetId = null;
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
      return;
    }

    const distance = horizontalDistance(entity.state.position, player.state.position);
    const attributes = this.attributesOf(entity);
    const aggroRadius = Math.max(0, attributes.aggroRadius ?? DEFAULT_AGGRO_RADIUS);
    const patrolRadius = Math.max(0, attributes.patrolRadius ?? DEFAULT_PATROL_RADIUS);
    const idleDuration = Math.max(0, attributes.idleMs ?? DEFAULT_IDLE_MS);
    const forcedTarget = runtime.targetId === player.id;
    const aggro = forcedTarget || distance <= aggroRadius;

    if (aggro && distance > aggroRadius * 2) {
      // 脱战：目标跑太远，回到 idle 并等待下次察觉。
      runtime.targetId = null;
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
      return;
    }

    if (aggro) {
      runtime.targetId = player.id;
      const range = this.attackRangeOf(entity);
      if (distance <= range) {
        runtime.aiState = "attack";
        this.movements.delete(entity.id);
      } else {
        runtime.aiState = "chase";
        this.movements.set(entity.id, {
          target: cloneVec3(player.state.position),
          speed: this.moveSpeedOf(entity),
        });
      }
      return;
    }

    if (runtime.aiState === "chase" || runtime.aiState === "attack") {
      runtime.targetId = null;
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
    }

    if (runtime.aiState === "idle") {
      this.movements.delete(entity.id);
      runtime.idleMs += stepMs;
      if (runtime.idleMs >= idleDuration) {
        runtime.aiState = "patrol";
        runtime.patrolIndex += 1;
      }
      return;
    }

    // patrol：绕出生点四个方向循环巡逻；到达后回到 idle。
    const spawn = this.spawns.get(entity.id);
    if (!spawn) {
      runtime.aiState = "idle";
      return;
    }
    const angle = (runtime.patrolIndex % 4) * (Math.PI / 2);
    const waypoint = {
      x: spawn.position.x + Math.cos(angle) * patrolRadius,
      y: spawn.position.y,
      z: spawn.position.z + Math.sin(angle) * patrolRadius,
    };
    if (horizontalDistance(entity.state.position, waypoint) <= 0.1) {
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
      return;
    }
    this.movements.set(entity.id, {
      target: waypoint,
      speed: this.moveSpeedOf(entity) * 0.5,
    });
  }

  /**
   * 冲锋型状态机（票 36）：
   * chase →（进入 triggerRange）windup-charge 0.6s（发 attack-windup-started，
   * heavy=true 让反馈层播长前摇提示）→ charge 直线高速（路径命中判定一次，
   * 被硬碰撞挡停）→ recovery 硬直 → chase。
   * 前摇结束时锁定冲锋方向：玩家此时横移就能躲开（走位有意义）。
   */
  private updateChargeBehavior(
    entity: Entity,
    runtime: CombatRuntime,
    profile: WindupChargeAiProfile,
    stepMs: number,
  ): void {
    const player = this.playerId === null ? undefined : this.entities.get(this.playerId);
    const playerRuntime =
      this.playerId === null ? undefined : this.combat.get(this.playerId);

    if (!player || !playerRuntime || !playerRuntime.alive) {
      runtime.targetId = null;
      runtime.chargeDir = null;
      runtime.chargeWindupMs = 0;
      runtime.chargeRemaining = 0;
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
      return;
    }

    const distance = horizontalDistance(entity.state.position, player.state.position);
    const attributes = this.attributesOf(entity);
    const aggroRadius = Math.max(0, attributes.aggroRadius ?? DEFAULT_AGGRO_RADIUS);

    // 冲锋途中与硬直中脱战判定同样生效（玩家拉开太远就放弃这次冲锋）。
    if (distance > aggroRadius * 2) {
      runtime.targetId = null;
      runtime.chargeDir = null;
      runtime.chargeWindupMs = 0;
      runtime.chargeRemaining = 0;
      runtime.chargeRemainingMs = 0;
      runtime.chargeHit = false;
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
      return;
    }

    // recovery：硬直期间站桩不动、不结算伤害（走位躲开后的白打窗口）。
    if (runtime.aiState === "recovery") {
      runtime.chargeRemainingMs = Math.max(0, runtime.chargeRemainingMs - stepMs);
      this.movements.delete(entity.id);
      if (runtime.chargeRemainingMs === 0) {
        runtime.aiState = "chase";
        runtime.idleMs = 0;
      }
      return;
    }

    // charge：沿锁定方向直线推进；被挡停或走完距离即进入 recovery。
    if (runtime.aiState === "charge") {
      const dir = runtime.chargeDir ?? { x: 0, z: 0 };
      const step = stepCharge(
        entity.state.position,
        dir,
        (profile.chargeSpeed * stepMs) / 1000,
        this.obstacles,
        LOGIC_COLLIDER_RADIUS,
      );
      entity.state.position = step.position;
      this.movements.delete(entity.id);

      if (step.blocked) {
        this.publish({
          type: "charge-blocked",
          attackerId: entity.id,
          targetId: player.id,
          obstacleId: step.blockedBy ?? "",
          at: this.elapsedMs,
        });
        this.enterChargeRecovery(runtime, profile);
        return;
      }

      // 路径命中判定：整段冲锋只结算一次（用本步落点重新量距离）。
      runtime.chargeRemaining = Math.max(0, runtime.chargeRemaining - step.travelled);
      const gapAfterStep = horizontalDistance(entity.state.position, player.state.position);
      if (!runtime.chargeHit && gapAfterStep <= profile.hitRadius) {
        runtime.chargeHit = true;
        this.resolveEnemyDamage(entity, player, this.chargeDamageOf(entity, player), false);
      }
      if (runtime.chargeRemaining <= 1e-9) {
        this.enterChargeRecovery(runtime, profile);
      }
      return;
    }

    // windup-charge：明显前摇；冲锋方向在前摇结束那一刻锁定。
    if (runtime.aiState === "windup-charge") {
      runtime.chargeWindupMs = Math.max(0, runtime.chargeWindupMs - stepMs);
      this.movements.delete(entity.id);
      this.facePosition(entity, player.state.position);
      if (runtime.chargeWindupMs === 0) {
        runtime.chargeDir = chargeDirection(entity.state.position, player.state.position);
        runtime.chargeRemaining = profile.chargeDistance;
        runtime.chargeHit = false;
        runtime.aiState = "charge";
      }
      return;
    }

    runtime.targetId = player.id;

    // 追击：进入 triggerRange 就起手前摇，否则继续接近。
    if (distance <= profile.triggerRange) {
      runtime.chargeWindupMs = profile.windupMs;
      runtime.chargeRemaining = 0;
      runtime.chargeRemainingMs = 0;
      runtime.chargeDir = null;
      runtime.chargeHit = false;
      runtime.aiState = "windup-charge";
      this.movements.delete(entity.id);
      this.facePosition(entity, player.state.position);
      this.publish({
        type: "attack-windup-started",
        attackerId: entity.id,
        targetId: player.id,
        heavy: true, // 前摇明显长于普攻，反馈层用重击提示样式。
        durationMs: profile.windupMs,
        at: this.elapsedMs,
      });
      return;
    }

    runtime.aiState = "chase";
    this.movements.set(entity.id, {
      target: cloneVec3(player.state.position),
      speed: this.moveSpeedOf(entity),
    });
  }

  private enterChargeRecovery(runtime: CombatRuntime, profile: WindupChargeAiProfile): void {
    runtime.chargeRemaining = 0;
    runtime.chargeRemainingMs = profile.recoveryMs;
    runtime.chargeDir = null;
    runtime.aiState = "recovery";
  }

  /** 冲锋伤害：与普攻同源的攻击 - 防御，向上取整且至少 1 点。 */
  private chargeDamageOf(attacker: Entity, target: Entity): number {
    const attack = this.attributesOf(attacker).attack ?? 0;
    const defense = this.attributesOf(target).defense ?? 0;
    return Math.max(1, Math.round(attack - defense));
  }

  private facePosition(entity: Entity, target: Vec3): void {
    const dx = target.x - entity.state.position.x;
    const dz = target.z - entity.state.position.z;
    if (dx === 0 && dz === 0) {
      return;
    }
    entity.state.rotation.y = Math.atan2(dx, dz);
  }

  /**
   * 吐弹型状态机（票 36）：kiting——保持 preferredRange，玩家进入 retreatRange
   * 就后撤，太远则追近；开火倒计时归零时朝玩家当前位置发射逻辑层投射物。
   * 命中判定完全在 GameSession（投射物步进 + 命中即 resolveEnemyDamage）。
   */
  private updateKiteBehavior(
    entity: Entity,
    runtime: CombatRuntime,
    profile: RangedKiteAiProfile,
    stepMs: number,
  ): void {
    const player = this.playerId === null ? undefined : this.entities.get(this.playerId);
    const playerRuntime =
      this.playerId === null ? undefined : this.combat.get(this.playerId);

    if (!player || !playerRuntime || !playerRuntime.alive) {
      runtime.targetId = null;
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
      return;
    }

    const attributes = this.attributesOf(entity);
    const aggroRadius = Math.max(0, attributes.aggroRadius ?? DEFAULT_AGGRO_RADIUS);
    const distance = horizontalDistance(entity.state.position, player.state.position);

    if (distance > aggroRadius * 2) {
      runtime.targetId = null;
      runtime.aiState = "idle";
      runtime.idleMs = 0;
      this.movements.delete(entity.id);
      return;
    }

    runtime.targetId = player.id;
    runtime.aiState = "kite";
    this.facePosition(entity, player.state.position);

    const moveTarget = kiteMoveTarget(
      entity.state.position,
      player.state.position,
      profile.preferredRange,
      profile.retreatRange,
      (this.moveSpeedOf(entity) * stepMs) / 1000,
    );
    if (moveTarget === null) {
      this.movements.delete(entity.id);
    } else {
      this.movements.set(entity.id, {
        target: moveTarget,
        speed: this.moveSpeedOf(entity),
      });
    }

    runtime.fireCooldownMs = Math.max(0, runtime.fireCooldownMs - stepMs);
    if (runtime.fireCooldownMs === 0 && distance <= profile.preferredRange + 2) {
      this.fireProjectile(entity, runtime, player, profile);
    }
  }

  private fireProjectile(
    entity: Entity,
    runtime: CombatRuntime,
    player: Entity,
    profile: RangedKiteAiProfile,
  ): void {
    runtime.projectilesFired += 1;
    runtime.fireCooldownMs = profile.fireIntervalMs;
    const projectileId = `${entity.id}#shot${runtime.projectilesFired}`;
    const dir = chargeDirection(entity.state.position, player.state.position);
    const position = {
      x: entity.state.position.x + dir.x * 0.6,
      y: entity.state.position.y,
      z: entity.state.position.z + dir.z * 0.6,
    };
    this.projectiles.set(projectileId, {
      id: projectileId,
      ownerId: entity.id,
      targetId: player.id,
      position,
      velocity: { x: dir.x * profile.projectileSpeed, z: dir.z * profile.projectileSpeed },
      damage: profile.projectileDamage,
      radius: profile.projectileRadius,
      remainingMs: profile.projectileLifetimeMs,
    });
    this.publish({
      type: "projectile-spawned",
      projectileId,
      ownerId: entity.id,
      targetId: player.id,
      position,
      at: this.elapsedMs,
    });
  }

  /** 投射物步进：命中 → 伤害；撞障碍/超时 → 消失。表现层只消费两个事件。 */
  private stepProjectiles(stepMs: number): void {
    const player = this.playerId === null ? undefined : this.entities.get(this.playerId);
    if (!player) {
      return;
    }
    for (const [id, projectile] of this.projectiles) {
      const owner = this.entities.get(projectile.ownerId as EntityId);
      const step = stepProjectile(
        projectile,
        stepMs,
        player.state.position,
        LOGIC_COLLIDER_RADIUS,
        this.obstacles,
      );
      this.projectiles.set(id, step.projectile);

      if (step.hit) {
        this.projectiles.delete(id);
        // 伤害与战斗日志都由 resolveEnemyDamage 统一结算，这里不重复记账。
        if (owner !== undefined) {
          this.resolveEnemyDamage(owner, player, projectile.damage, false);
        }
        this.publish({
          type: "projectile-removed",
          projectileId: id,
          ownerId: projectile.ownerId as EntityId,
          reason: "hit",
          at: this.elapsedMs,
        });
        continue;
      }
      if (step.blocked || step.expired) {
        this.projectiles.delete(id);
        this.publish({
          type: "projectile-removed",
          projectileId: id,
          ownerId: projectile.ownerId as EntityId,
          reason: step.blocked ? "blocked" : "expired",
          at: this.elapsedMs,
        });
      }
    }
  }

  /**
   * 敌人直接结算一次伤害（冲锋命中 / 投射物命中）。
   * 命中判定在 AI 侧完成，damage 是**已算好的最终伤害**：冲锋走攻防公式，
   * 投射物用档案里的固定伤害（威胁来自距离与走位，不来自防御）。
   */
  private resolveEnemyDamage(
    attacker: Entity,
    target: Entity,
    damage: number,
    heavy: boolean,
  ): void {
    const targetRuntime = this.combat.get(target.id);
    if (!targetRuntime || !targetRuntime.alive) {
      return;
    }
    targetRuntime.hp = Math.max(0, targetRuntime.hp - damage);
    this.publishDamageDealt(attacker, target, {
      amount: damage,
      heavy,
      at: this.elapsedMs,
    });
    this.publishHealthChange(target, "damage");
    this.events.push({
      type: "attack",
      at: this.elapsedMs,
      attackerId: attacker.id,
      targetId: target.id,
      hit: true,
      damage,
      targetHp: targetRuntime.hp,
      targetMaxHp: this.maxHpOf(target),
    });
    if (targetRuntime.hp <= 0) {
      this.handleDeath(target, attacker);
    }
  }

  /** 移动按固定步长推进；与 Crowd V2 的朝向约定一致（+Z 为 0，朝 +X 为 π/2）。 */
  private moveEntities(stepMs: number): void {
    for (const [id, movement] of this.movements) {
      const entity = this.entities.get(id);
      if (!entity) {
        this.movements.delete(id);
        continue;
      }

      const { position } = entity.state;
      const dx = movement.target.x - position.x;
      const dz = movement.target.z - position.z;
      const distance = Math.hypot(dx, dz);
      const step = (movement.speed * stepMs) / 1000;

      if (distance <= step || distance === 0) {
        position.x = movement.target.x;
        position.y = movement.target.y;
        position.z = movement.target.z;
        this.movements.delete(id);
        continue;
      }

      position.x += (dx / distance) * step;
      position.z += (dz / distance) * step;
      entity.state.rotation.y = Math.atan2(dx, dz);
    }
  }

  private resolveAttackIfReady(attackerId: EntityId): void {
    const attacker = this.entities.get(attackerId);
    const runtime = this.combat.get(attackerId);
    if (!attacker || !runtime || !runtime.alive || runtime.targetId === null) {
      return;
    }
    // 票 36：windup-charge / ranged-kite 有自己的结算管线（冲锋命中判定、
    // 投射物步进），不走通用普攻结算器，否则两套状态机会互相打断。
    const profile = this.enemyProfiles.get(attackerId)?.aiProfile ?? null;
    if (attacker.identity.type === "enemy" && profile !== null) {
      return;
    }
    // 前摇结束时 cooldownMs 已经在本回合起手时锁定，因此 windupReady 要绕过冷却门。
    if (runtime.cooldownMs > 0 && !runtime.windupReady) {
      return;
    }

    const target = this.entities.get(runtime.targetId);
    const targetRuntime = this.combat.get(runtime.targetId);
    if (!target || !targetRuntime || !targetRuntime.alive) {
      runtime.targetId = null;
      runtime.windupMs = 0;
      runtime.windupReady = false;
      return;
    }

    const distance = horizontalDistance(attacker.state.position, target.state.position);
    if (distance > this.attackRangeOf(attacker)) {
      // 前摇中目标跑出射程 = 走位躲开：取消这次前摇，重新接近后再起手。
      if (runtime.windupReady) {
        runtime.windupReady = false;
        runtime.windupMs = 0;
      }
      return;
    }

    if (runtime.windupMs > 0) {
      return; // 前摇中，等 step() 走完。
    }

    const attackerAttributes = this.attributesOf(attacker);
    // 重击是一次性意图：起手即锁定，结算后自动回到普攻。
    const heavy = runtime.windupReady ? runtime.windupHeavy : runtime.heavyStrike;
    runtime.heavyStrike = false;

    // 前摇：敌人普攻 0.3s、重击 0.6s；玩家普攻 0（保持即时反馈）。
    if (!runtime.windupReady) {
      const windup = this.attackWindupOf(attacker, heavy, attackerAttributes);
      if (windup > 0) {
        runtime.windupMs = windup;
        runtime.windupHeavy = heavy;
        // 重击是独立技能冷却：普攻回合仍按 attackIntervalMs 继续。
        runtime.cooldownMs = this.attackIntervalOf(attacker);
        runtime.heavyCooldownMs = heavy
          ? Math.max(
              1,
              Math.round(
                attackerAttributes.heavyAttackCooldownMs ??
                  DEFAULT_HEAVY_ATTACK_COOLDOWN_MS,
              ),
            )
          : runtime.heavyCooldownMs;
        if (attacker.identity.type === "enemy") {
          runtime.aiState = "attack";
        }
        this.faceTarget(attacker);
        this.publish({
          type: "attack-windup-started",
          attackerId: attacker.id,
          targetId: target.id,
          heavy,
          durationMs: windup,
          at: this.elapsedMs,
        });
        return;
      }
      // 无前摇：直接进入结算，冷却在结算前锁定。
      runtime.cooldownMs = this.attackIntervalOf(attacker);
      runtime.heavyCooldownMs = heavy
        ? Math.max(
            1,
            Math.round(
              attackerAttributes.heavyAttackCooldownMs ??
                DEFAULT_HEAVY_ATTACK_COOLDOWN_MS,
            ),
          )
        : runtime.heavyCooldownMs;
    } else {
      runtime.windupReady = false;
    }

    const targetAttributes = this.attributesOf(target);
    const hitChance = clamp(
      BASE_HIT_CHANCE + ((attackerAttributes.accuracy ?? 0) - (targetAttributes.evasion ?? 0)) / 100,
      0.05,
      1,
    );
    const hit = this.random() < hitChance;
    const heavyMultiplier = heavy
      ? Math.max(1, attackerAttributes.heavyAttackMultiplier ?? DEFAULT_HEAVY_ATTACK_MULTIPLIER)
      : 1;
    const damage = hit
      ? Math.max(
          1,
          Math.round(
            ((attackerAttributes.attack ?? 0) - (targetAttributes.defense ?? 0)) *
              heavyMultiplier,
          ),
        )
      : 0;

    // 攻击朝向 = 结算时面向目标（目标可能在前摇期间移动）。
    this.faceTarget(attacker);
    if (attacker.identity.type === "enemy") {
      runtime.aiState = "attack";
    }
    if (target.identity.type === "enemy" && attacker.identity.type === "player") {
      const targetTargetRuntime = this.combat.get(target.id);
      if (targetTargetRuntime && targetTargetRuntime.alive) {
        targetTargetRuntime.targetId = attacker.id; // 被打的敌人立刻仇恨玩家。
        if (targetTargetRuntime.aiState === "idle" || targetTargetRuntime.aiState === "patrol") {
          targetTargetRuntime.aiState = "chase";
          targetTargetRuntime.idleMs = 0;
        }
      }
    }

    if (hit) {
      targetRuntime.hp = Math.max(0, targetRuntime.hp - damage);
      this.publishDamageDealt(attacker, target, {
        amount: damage,
        heavy,
        at: this.elapsedMs,
      });
      this.publishHealthChange(target, "damage");
    } else {
      // 未命中只让 UI 播放 miss 表现，不进一等事件（没有结算事实可转译）。
      this.events.push({
        type: "attack",
        at: this.elapsedMs,
        attackerId: attacker.id,
        targetId: target.id,
        hit,
        damage,
        targetHp: targetRuntime.hp,
        targetMaxHp: this.maxHpOf(target),
      });
      return;
    }

    this.events.push({
      type: "attack",
      at: this.elapsedMs,
      attackerId: attacker.id,
      targetId: target.id,
      hit,
      damage,
      targetHp: targetRuntime.hp,
      targetMaxHp: this.maxHpOf(target),
    });

    if (targetRuntime.hp <= 0) {
      this.handleDeath(target, attacker);
    }
  }

  /**
   * 广播命中事实（票 27 一等事件）。lethal 在这一击直接致死时为 true；
   * 否则目标剩余生命交给 health-changed 表达。
   */
  private publishDamageDealt(
    attacker: Entity,
    target: Entity,
    options: { amount: number; heavy: boolean; at: number },
  ): void {
    const targetRuntime = this.combat.get(target.id);
    if (!targetRuntime) {
      return;
    }
    const event: DamageDealtEvent = {
      type: "damage-dealt",
      attackerId: attacker.id,
      targetId: target.id,
      amount: options.amount,
      targetHp: targetRuntime.hp,
      targetMaxHp: this.maxHpOf(target),
      heavy: options.heavy,
      lethal: targetRuntime.hp <= 0,
      at: options.at,
    };
    this.publish(event);
  }

  /** 广播生命变化（受伤/治疗）。重生回满不广播：读档/重生不是被转译的战斗事实。 */
  private publishHealthChange(entity: Entity, cause: "damage" | "heal"): void {
    const runtime = this.combat.get(entity.id);
    if (!runtime) {
      return;
    }
    const hp = runtime.hp;
    const previousHp = this.lastPublishedHp.get(entity.id) ?? hp;
    if (previousHp === hp) {
      return;
    }
    this.lastPublishedHp.set(entity.id, hp);
    this.publish({
      type: "health-changed",
      entityId: entity.id,
      hp,
      maxHp: this.maxHpOf(entity),
      previousHp,
      cause,
    });
  }

  private handleDeath(entity: Entity, killer: Entity): void {
    const runtime = this.combat.get(entity.id);
    if (!runtime) {
      return;
    }
    runtime.hp = 0;
    runtime.alive = false;
    runtime.cooldownMs = 0;
    runtime.heavyCooldownMs = 0;
    runtime.windupMs = 0;
    runtime.windupReady = false;
    runtime.heavyStrike = false;
    runtime.targetId = null;
    this.movements.delete(entity.id);

    if (entity.identity.type === "enemy") {
      runtime.aiState = "dead";
      this.events.push({
        type: "death",
        at: this.elapsedMs,
        entityId: entity.id,
        kind: "enemy",
      });

      // 死者不再被任何实体锁定。
      for (const other of this.combat.values()) {
        if (other.targetId === entity.id) {
          other.targetId = null;
        }
      }

      if (killer.identity.type === "player") {
        this.grantKillRewards(entity, killer);
        // 票 22：会话内战斗的击杀与外部 emitCombatEvent 走同一任务进度入口。
        this.onEnemyKilled(entity.id, entity.identity.templateId, killer.id);
      }
      return;
    }

    if (entity.identity.type === "player") {
      this.events.push({
        type: "death",
        at: this.elapsedMs,
        entityId: entity.id,
        kind: "player",
      });
      this.respawnAtMs = this.elapsedMs + this.respawnDelayMs;

      // 票 36 死亡轻惩罚：回村出生点由 processRespawn 负责，这里只扣金币。
      this.applyDeathPenalty(this.requirePlayer());

      // 玩家倒下瞬间让敌人停手，避免重生前继续吃伤害。
      for (const [id, other] of this.entities) {
        if (other.identity.type !== "enemy") {
          continue;
        }
        const otherRuntime = this.combat.get(id);
        if (!otherRuntime) {
          continue;
        }
        otherRuntime.targetId = null;
        this.movements.delete(id);
        if (otherRuntime.alive) {
          otherRuntime.aiState = "idle";
          otherRuntime.idleMs = 0;
        }
      }
    }
  }

  /**
   * 死亡轻惩罚（票 36）：损失 ceil(rate × 金币总数) 枚金币物品。
   * 金币就是背包物品，所以扣减结果随实体背包自然进快照，不需要新快照字段。
   * 金币不足一份（0 枚）时免罚，不广播事件。
   */
  private applyDeathPenalty(player: Entity): void {
    const itemId = this.deathPenaltyCoinItemId;
    const total = player.container.items
      .filter((item) => item.templateId === itemId)
      .reduce((sum, item) => sum + item.quantity, 0);
    const lost = coinPenaltyFor(total, this.deathPenaltyRate);
    if (lost <= 0) {
      return;
    }
    const remaining = this.removeItem(player, itemId, lost);
    this.events.push({
      type: "loot",
      at: this.elapsedMs,
      entityId: player.id,
      itemId,
      quantity: -lost,
    });
    this.publish({
      type: "item-lost",
      entityId: player.id,
      itemId,
      quantity: lost,
    });
    this.publish({
      type: "player-death-penalty",
      entityId: player.id,
      itemId,
      lostQuantity: lost,
      remainingQuantity: remaining,
      at: this.elapsedMs,
    });
  }

  /** 从背包扣减物品，返回扣减后的剩余总量；数量不足时按现有量扣。 */
  private removeItem(entity: Entity, itemId: string, quantity: number): number {
    let remaining = Math.max(0, Math.floor(quantity));
    let left = 0;
    for (const item of entity.container.items) {
      left += item.templateId === itemId ? item.quantity : 0;
    }
    for (const item of entity.container.items) {
      if (remaining <= 0) {
        break;
      }
      if (item.templateId !== itemId) {
        continue;
      }
      const taken = Math.min(item.quantity, remaining);
      item.quantity -= taken;
      remaining -= taken;
      left -= taken;
    }
    entity.container.items = entity.container.items.filter((item) => item.quantity > 0);
    return left;
  }

  /** 击杀奖励：经验进玩家属性，掉落按模板概率/区间进背包。 */
  private grantKillRewards(enemy: Entity, player: Entity): void {
    const enemyAttributes = this.attributesOf(enemy);
    const xp = Math.max(0, Math.round(enemyAttributes.xp ?? 0));
    if (xp > 0) {
      const total = (player.baseAttributes.xp ?? 0) + xp;
      player.baseAttributes.xp = total;
      this.events.push({
        type: "xp",
        at: this.elapsedMs,
        entityId: player.id,
        amount: xp,
        total,
      });
    }

    const profile = this.enemyProfiles.get(enemy.id);
    if (!profile) {
      return;
    }
    for (const drop of profile.drops) {
      if (this.random() >= drop.chance) {
        continue;
      }
      const min = Math.max(0, Math.floor(drop.min));
      const max = Math.max(min, Math.floor(drop.max));
      const quantity = min + Math.floor(this.random() * (max - min + 1));
      if (quantity <= 0) {
        continue;
      }
      this.addItem(player, drop.itemId, quantity);
      this.events.push({
        type: "loot",
        at: this.elapsedMs,
        entityId: player.id,
        itemId: drop.itemId,
        quantity,
      });
      this.publish({
        type: "item-gained",
        entityId: player.id,
        itemId: drop.itemId,
        quantity,
      });
    }
  }

  /** 背包入栈：按 maxStack 合并，返回实际创建的实例 id。 */
  private addItem(entity: Entity, itemId: string, quantity: number): string[] {
    const definition = this.itemDefinitions.get(itemId);
    const maxStack = Math.max(1, definition?.maxStack ?? 1);
    let remaining = Math.max(0, Math.floor(quantity));
    const created: string[] = [];

    for (const item of entity.container.items) {
      if (remaining <= 0) {
        break;
      }
      if (item.templateId !== itemId || item.quantity >= maxStack) {
        continue;
      }
      const moved = Math.min(maxStack - item.quantity, remaining);
      item.quantity += moved;
      remaining -= moved;
    }

    while (remaining > 0) {
      const moved = Math.min(maxStack, remaining);
      const instanceId = `${itemId}@${this.nextItemInstanceId}`;
      this.nextItemInstanceId += 1;
      entity.container.items.push({
        instanceId,
        templateId: itemId,
        quantity: moved,
        equipped: false,
      });
      created.push(instanceId);
      remaining -= moved;
    }

    return created;
  }

  /** 只读快照：每次调用都返回新对象，渲染层无法借此修改内部状态。 */
  snapshot(): GameSessionSnapshot {
    const entities: EntitySnapshot[] = [...this.entities.values()]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((entity) => {
        const movement = this.movements.get(entity.id);
        const runtime = this.combat.get(entity.id);
        const attributes = this.attributesOf(entity);

        return {
          id: entity.id,
          identity: { ...entity.identity },
          position: cloneVec3(entity.state.position),
          rotation: cloneVec3(entity.state.rotation),
          tags: [...entity.state.tags],
          movement: movement
            ? { target: cloneVec3(movement.target), speed: movement.speed }
            : null,
          baseAttributes: { ...entity.baseAttributes },
          attributes: { ...attributes },
          modifiers: entity.modifiers.map(cloneModifier),
          combat: {
            hp: runtime?.hp ?? 0,
            maxHp: this.maxHpOf(entity),
            attack: attributes.attack ?? 0,
            defense: attributes.defense ?? 0,
            alive: runtime?.alive ?? false,
            aiState: runtime?.aiState ?? null,
            targetId: runtime?.targetId ?? null,
            attackCooldownMs: runtime?.cooldownMs ?? 0,
            heavyCooldownMs: runtime?.heavyCooldownMs ?? 0,
          },
          container: {
            items: entity.container.items.map((item) => ({ ...item })),
          },
          claimedRewardIds: [...entity.claimedRewardIds],
        };
      });

    return {
      version: GAME_SESSION_SNAPSHOT_VERSION,
      regionId: this.regionId,
      elapsedMs: this.elapsedMs,
      nextItemInstanceId: this.nextItemInstanceId,
      respawnAtMs: this.respawnAtMs,
      entities,
      dialogue:
        this.dialogue === null
          ? null
          : {
              npcId: this.dialogue.npcId,
              dialogueId: this.dialogue.dialogueId,
              text: this.dialogue.text,
              choices: [...this.dialogue.choices],
              story: {
                formatVersion: this.dialogue.storySnapshot.formatVersion,
                inkState: this.dialogue.storySnapshot.inkState,
              },
            },
      quests: this.questLog.snapshot(),
    };
  }

  /** 快照的 JSON 表示（存档/测试共用）。 */
  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  /**
   * 从快照完整恢复会话状态（读档）。
   *
   * 内容定义必须先准备好：`loadRegion()`（区域实体/任务/物品/敌人档案）与
   * `registerDialogue()`（对话）之后再调用。恢复内容：
   * - 实体：位置/朝向/标签/基础属性/修饰器/背包/已领奖励账本 + 移动意图；
   * - 战斗：生命/存活/AI 状态/目标/冷却；
   * - 顶层：游戏时钟、重生计时、物品实例序号、静默清空事件队列；
   * - 对话：ink 执行状态（文本与选项与存档点一致，可继续选择）；
   * - 任务：全部任务进度。
   *
   * 快照中的实体必须已存在于会话；会话里多出的内容实体保持默认状态
   * （兼容旧版本存档迁移后只包含部分实体的情形）。
   * 恢复不广播事件——读档不是一次游戏内状态转移。
   */
  restoreSnapshot(snapshot: GameSessionSnapshot): void {
    if (snapshot.version !== GAME_SESSION_SNAPSHOT_VERSION) {
      throw new Error(
        `不支持的快照版本：${String(snapshot.version)}（当前 ${GAME_SESSION_SNAPSHOT_VERSION}）`,
      );
    }
    if (!Number.isFinite(snapshot.elapsedMs) || snapshot.elapsedMs < 0) {
      throw new Error("快照 elapsedMs 必须是非负有限数值");
    }
    if (snapshot.regionId !== null) {
      if (typeof snapshot.regionId !== "string" || snapshot.regionId.trim() === "") {
        throw new Error("快照 regionId 必须是非空字符串或 null");
      }
      if (this.regionId !== null && this.regionId !== snapshot.regionId) {
        throw new Error(
          `快照区域 ${snapshot.regionId} 与当前已加载区域 ${this.regionId} 不一致`,
        );
      }
    }
    if (
      snapshot.respawnAtMs !== null &&
      (!Number.isFinite(snapshot.respawnAtMs) || snapshot.respawnAtMs < 0)
    ) {
      throw new Error("快照 respawnAtMs 必须是非负有限数值或 null");
    }
    if (
      !Number.isInteger(snapshot.nextItemInstanceId) ||
      snapshot.nextItemInstanceId < 1
    ) {
      throw new Error("快照 nextItemInstanceId 必须是正整数");
    }

    if (!Array.isArray(snapshot.entities)) {
      throw new Error("快照 entities 必须是数组");
    }
    if (!Array.isArray(snapshot.quests)) {
      throw new Error("快照 quests 必须是数组");
    }

    // 先确定实体集合，再写入：失败时不会留下半恢复状态。
    const seen = new Set<EntityId>();
    for (const entitySnapshot of snapshot.entities) {
      if (seen.has(entitySnapshot.id)) {
        throw new Error(`快照包含重复实体：${entitySnapshot.id}`);
      }
      if (!this.entities.has(entitySnapshot.id)) {
        throw new Error(`快照包含未知实体：${entitySnapshot.id}`);
      }
      seen.add(entitySnapshot.id);
      if (!this.combat.has(entitySnapshot.id)) {
        throw new Error(`实体缺少运行时状态：${entitySnapshot.id}`);
      }
      assertFiniteVec3(entitySnapshot.position, `快照实体 ${entitySnapshot.id} 的位置`);
      assertFiniteVec3(entitySnapshot.rotation, `快照实体 ${entitySnapshot.id} 的朝向`);
      assertAttributesRecord(
        entitySnapshot.baseAttributes,
        `快照实体 ${entitySnapshot.id}`,
      );
      assertStringArray(entitySnapshot.tags, `快照实体 ${entitySnapshot.id} 的 tags`);
      assertStringArray(
        entitySnapshot.claimedRewardIds,
        `快照实体 ${entitySnapshot.id} 的 claimedRewardIds`,
      );
      if (!Array.isArray(entitySnapshot.modifiers)) {
        throw new Error(`快照实体 ${entitySnapshot.id} 的 modifiers 必须是数组`);
      }
      entitySnapshot.modifiers.forEach((modifier, index) => {
        assertModifierShape(
          modifier,
          `快照实体 ${entitySnapshot.id} 的修饰器[${index}]`,
        );
      });
      if (
        typeof entitySnapshot.container !== "object" ||
        entitySnapshot.container === null ||
        !Array.isArray(entitySnapshot.container.items)
      ) {
        throw new Error(`快照实体 ${entitySnapshot.id} 的背包结构非法`);
      }
      if (entitySnapshot.movement !== null) {
        assertFiniteVec3(
          entitySnapshot.movement.target,
          `快照实体 ${entitySnapshot.id} 的移动目标`,
        );
        if (!Number.isFinite(entitySnapshot.movement.speed) || entitySnapshot.movement.speed <= 0) {
          throw new Error(`快照实体 ${entitySnapshot.id} 的移动速度必须是正数`);
        }
      }
      if (!Number.isFinite(entitySnapshot.combat.hp) || entitySnapshot.combat.hp < 0) {
        throw new Error(`快照实体 ${entitySnapshot.id} 的生命值必须是非负数`);
      }
      if (typeof entitySnapshot.combat.alive !== "boolean") {
        throw new Error(`快照实体 ${entitySnapshot.id} 的存活标记必须是布尔值`);
      }
      if (
        !Number.isFinite(entitySnapshot.combat.attackCooldownMs) ||
        entitySnapshot.combat.attackCooldownMs < 0
      ) {
        throw new Error(`快照实体 ${entitySnapshot.id} 的攻击冷却必须是非负数`);
      }
      if (
        !Number.isFinite(entitySnapshot.combat.heavyCooldownMs) ||
        entitySnapshot.combat.heavyCooldownMs < 0
      ) {
        throw new Error(`快照实体 ${entitySnapshot.id} 的 heavyCooldownMs 必须是非负数`);
      }
      for (const item of entitySnapshot.container.items) {
        if (
          typeof item.instanceId !== "string" ||
          item.instanceId.trim() === "" ||
          typeof item.templateId !== "string" ||
          item.templateId.trim() === "" ||
          !Number.isInteger(item.quantity) ||
          item.quantity < 1
        ) {
          throw new Error(`快照实体 ${entitySnapshot.id} 的背包物品格式非法`);
        }
      }
    }
    for (const entitySnapshot of snapshot.entities) {
      const targetId = entitySnapshot.combat.targetId;
      if (targetId !== null && !this.entities.has(targetId)) {
        throw new Error(
          `快照实体 ${entitySnapshot.id} 的攻击目标未知：${targetId}`,
        );
      }
    }

    // 对话也先验证再写入。
    let restoredDialogue: ActiveDialogue | null = null;
    if (snapshot.dialogue !== null) {
      const dialogueSnapshot = snapshot.dialogue;
      if (!this.entities.has(dialogueSnapshot.npcId)) {
        throw new Error(`对话快照引用未知 NPC：${dialogueSnapshot.npcId}`);
      }
      const compiled = this.dialogues.get(dialogueSnapshot.dialogueId);
      if (compiled === undefined) {
        throw new Error(`对话未注册：${dialogueSnapshot.dialogueId}`);
      }
      const story = createDialogue(compiled);
      this.bindDialogueFunctions(story);
      restoreDialogue(story, dialogueSnapshot.story);
      restoredDialogue = {
        npcId: dialogueSnapshot.npcId,
        dialogueId: dialogueSnapshot.dialogueId,
        story,
        storySnapshot: snapshotDialogue(story),
        text: dialogueSnapshot.text,
        choices: [...dialogueSnapshot.choices],
      };
    }

    // 任务也先干跑校验；QuestLog.restore 本身是原子的，但这里提前暴露错误，
    // 保证写入阶段不会因为任务数据非法而中断。
    this.questLog.validate(snapshot.quests);

    // ---- 写入阶段（到此不再有可预期的验证失败）----
    this.elapsedMs = snapshot.elapsedMs;
    this.respawnAtMs = snapshot.respawnAtMs;
    this.nextItemInstanceId = snapshot.nextItemInstanceId;

    for (const entitySnapshot of snapshot.entities) {
      const entity = this.entities.get(entitySnapshot.id);
      const runtime = this.combat.get(entitySnapshot.id);
      if (!entity || !runtime) {
        throw new Error(`实体缺少运行时状态：${entitySnapshot.id}`);
      }

      entity.state.position = cloneVec3(entitySnapshot.position);
      entity.state.rotation = cloneVec3(entitySnapshot.rotation);
      entity.state.tags = [...entitySnapshot.tags];
      entity.baseAttributes = { ...entitySnapshot.baseAttributes };
      entity.modifiers = entitySnapshot.modifiers.map(cloneModifier);
      entity.container.items = entitySnapshot.container.items.map((item) => ({
        ...item,
      }));
      entity.claimedRewardIds = [...entitySnapshot.claimedRewardIds];

      if (entitySnapshot.movement === null) {
        this.movements.delete(entity.id);
      } else {
        this.movements.set(entity.id, {
          target: cloneVec3(entitySnapshot.movement.target),
          speed: entitySnapshot.movement.speed,
        });
      }

      runtime.hp = Math.min(entitySnapshot.combat.hp, this.maxHpOf(entity));
      this.lastPublishedHp.set(entity.id, runtime.hp);
      runtime.alive = entitySnapshot.combat.alive;
      runtime.cooldownMs = entitySnapshot.combat.attackCooldownMs;
      runtime.heavyCooldownMs = entitySnapshot.combat.heavyCooldownMs;
      // 前摇是瞬态表现；存档不记录，读档后下一次 resolve 重新起手。
      runtime.windupMs = 0;
      runtime.windupReady = false;
      runtime.heavyStrike = false;
      runtime.targetId = entitySnapshot.combat.targetId;
      runtime.aiState = entitySnapshot.combat.aiState;
      runtime.idleMs = 0;
      runtime.patrolIndex = 0;
      // 冲锋链路与投射物是瞬态（同前摇）：快照 v3 不记录，读档后从头开始。
      runtime.chargeWindupMs = 0;
      runtime.chargeRemaining = 0;
      runtime.chargeRemainingMs = 0;
      runtime.chargeDir = null;
      runtime.chargeHit = false;
      runtime.fireCooldownMs = 0;
    }
    this.projectiles.clear();

    this.dialogue = restoredDialogue;
    this.questLog.restore(snapshot.quests);
    this.events.length = 0;
  }

  // -------------------------------------------------------------------------
  // 对话内部
  // -------------------------------------------------------------------------

  /**
   * 向 ink 暴露只读查询函数（内容侧需 `EXTERNAL questStatus(questId)` 声明）。
   * 这是对话感知任务状态的唯一入口；任务状态变化本身仍只由对话标签驱动。
   */
  private bindDialogueFunctions(story: Story): void {
    story.BindExternalFunction("questStatus", (questId: unknown): string => {
      if (typeof questId !== "string") {
        throw new Error("questStatus 的参数必须是任务 id");
      }
      const quest = this.questLog.get(questId);
      if (quest === undefined) {
        throw new Error(`未知任务：${questId}`);
      }
      return quest.status;
    });
  }

  private continueDialogueState(): void {
    const dialogue = this.dialogue;
    if (dialogue === null) {
      return;
    }

    const step = continueDialogue(dialogue.story);
    dialogue.text = step.text.trim();
    dialogue.choices = step.choices;
    for (const tag of step.tags) {
      this.applyDialogueTag(tag, dialogue.npcId);
    }
    dialogue.storySnapshot = snapshotDialogue(dialogue.story);

    if (step.ended) {
      this.dialogue = null;
      this.publish({
        type: "dialogue-ended",
        npcId: dialogue.npcId,
        dialogueId: dialogue.dialogueId,
      });
    }
  }

  private applyDialogueTag(tag: string, npcId: EntityId): void {
    const match = QUEST_TAG_PATTERN.exec(tag.trim());
    if (match === null) {
      return; // 其他 ink 标签不影响任务状态。
    }
    const kind = match[1];
    const questId = match[2];

    if (kind === "offer") {
      if (this.questLog.offer(questId)) {
        this.publish({ type: "quest-accepted", questId, npcId });
      }
      return;
    }

    const progress = this.questLog.get(questId);
    if (progress === undefined) {
      throw new Error(`未知任务：${questId}`);
    }
    if (progress.status !== "ready_to_turn_in") {
      // 未达成或已完成的复命标签是幂等空操作。
      return;
    }
    this.grantQuestRewards(questId);
    this.questLog.turnIn(questId);
    this.publish({ type: "quest-completed", questId, npcId });
  }

  /**
   * 敌人死亡的统一处理：推进任务目标并广播事件。
   * 会话内战斗（handleDeath）与外部 emitCombatEvent 都走这里，避免重复实现。
   */
  private onEnemyKilled(
    enemyId: string,
    enemyTemplateId: string,
    killerId?: string,
  ): void {
    const event: EnemyKilledEvent = {
      type: "enemy-killed",
      enemyId,
      enemyTemplateId,
      ...(killerId !== undefined ? { killerId } : {}),
    };
    const newlyReady = this.questLog.recordEnemyKill(enemyTemplateId);
    this.publish(event);
    for (const questId of newlyReady) {
      this.publish({ type: "quest-ready", questId });
    }
  }

  /** 发放任务奖励：物品入玩家背包，修饰器永久挂到玩家；账本保证只发一次。 */
  private grantQuestRewards(questId: string): void {
    const definition = this.questDefinitions.get(questId);
    if (definition === undefined) {
      throw new Error(`未知任务：${questId}`);
    }
    const player = this.requirePlayer();
    if (player.claimedRewardIds.includes(questId)) {
      return;
    }

    const items = [...player.container.items];
    const itemCounters = new Map<string, number>();
    for (const reward of definition.rewards.items ?? []) {
      const index = itemCounters.get(reward.itemId) ?? 0;
      itemCounters.set(reward.itemId, index + 1);
      items.push({
        instanceId: `${questId}:${reward.itemId}:${index}`,
        templateId: reward.itemId,
        quantity: reward.quantity,
        equipped: false,
      });
    }

    const granted = grantQuestReward(
      { ...player, container: { items } },
      { id: questId, modifiers: definition.rewards.modifiers ?? [] },
    );
    this.entities.set(granted.id, granted);
  }

  private requirePlayer(): Entity {
    if (this.playerId !== null) {
      const player = this.entities.get(this.playerId);
      if (player !== undefined) {
        return player;
      }
    }
    for (const entity of this.entities.values()) {
      if (entity.identity.type === "player") {
        this.playerId = entity.id;
        return entity;
      }
    }
    throw new Error("会话中没有玩家实体，无法发放任务奖励");
  }

  private publish(event: GameSessionEvent): void {
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }
}
