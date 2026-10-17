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
 */

import type { Story } from "inkjs";

import {
  continueDialogue,
  createDialogue,
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
  EnemyKilledEvent,
  GameSessionEvent,
  GameSessionEventListener,
} from "./game-events";
import { createContentIndex, instantiateRegionEntities } from "./content/region-loader";
import type { ContentBundle, DropDefinition, QuestDefinition } from "./content/types";
import {
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
 */
export const GAME_SESSION_SNAPSHOT_VERSION = 2;

/** 战斗默认值；内容属性可用同名键覆盖（见 content/README.md）。 */
export const DEFAULT_ATTACK_RANGE = 2;
export const DEFAULT_ATTACK_INTERVAL_MS = 1000;
export const BASE_HIT_CHANCE = 0.9;
export const DEFAULT_AGGRO_RADIUS = 8;
export const DEFAULT_PATROL_RADIUS = 4;
export const DEFAULT_IDLE_MS = 2000;
export const DEFAULT_RESPAWN_DELAY_MS = 1000;
/** 内部模拟固定步长：大 delta 也能稳定走位/结算，不受帧率影响。 */
const SIMULATION_STEP_MS = 100;

export type EnemyAiState = "idle" | "patrol" | "chase" | "attack" | "dead";

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
  /** 取消自动攻击；不会取消已经发生的伤害。 */
  stopAttack(entityId: EntityId | string): void;
}

export interface GameSessionOptions {
  /** [0,1) 随机源；默认确定性序列，测试可注入固定值。 */
  random?: () => number;
  /** 玩家死亡到重生的延迟（毫秒）。 */
  respawnDelayMs?: number;
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
  elapsedMs: number;
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
  targetId: EntityId | null;
  aiState: EnemyAiState | null;
  idleMs: number;
  patrolIndex: number;
}

interface SpawnRecord {
  position: Vec3;
  rotation: Vec3;
}

interface EnemyProfile {
  aiProfileId: string;
  drops: DropDefinition[];
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
  private readonly itemDefinitions = new Map<string, { id: string; maxStack: number }>();
  private readonly events: CombatEvent[] = [];
  private readonly random: () => number;
  private readonly respawnDelayMs: number;
  private elapsedMs = 0;
  private regionId: string | null = null;
  private playerId: EntityId | null = null;
  private respawnAtMs: number | null = null;
  private nextItemInstanceId = 1;

  constructor(options: GameSessionOptions = {}) {
    this.random = options.random ?? createSeededRandom(0x5eed);
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
      targetId: null,
      aiState: cloned.identity.type === "enemy" ? "idle" : null,
      idleMs: 0,
      patrolIndex: 0,
    });

    if (cloned.identity.type === "enemy") {
      this.enemyProfiles.set(cloned.id, {
        aiProfileId: cloned.references.aiProfileId ?? "ai:melee_chaser",
        drops: [],
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
      this.itemDefinitions.set(item.id, {
        id: item.id,
        maxStack: Math.max(1, Math.floor(item.maxStack ?? 1)),
      });
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
      if (runtime.aiState === "chase" || runtime.aiState === "attack") {
        runtime.aiState = "idle";
        runtime.idleMs = 0;
      }
    }
    this.movements.set(id, { target: cloneVec3(target), speed: DEFAULT_MOVE_SPEED });
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
    this.resolveAttackIfReady(attacker.id);
  }

  /** 取消自动攻击；已经结算的回合不受影响。 */
  stopAttack(entityId: EntityId | string): void {
    const id = entityId as EntityId;
    const runtime = this.combat.get(id);
    if (!runtime) {
      throw new Error(`未知实体：${entityId}`);
    }
    runtime.targetId = null;
    this.movements.delete(id); // 自动接近的移动随攻击取消。
    if (runtime.aiState === "chase" || runtime.aiState === "attack") {
      runtime.aiState = "idle";
      runtime.idleMs = 0;
    }
  }

  /** 取走并清空自上次调用以来的战斗事件（攻击/死亡/经验/掉落/重生）。 */
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
    }

    const ids = [...this.entities.keys()].sort() as EntityId[];
    for (const id of ids) {
      this.updateBehavior(id, stepMs);
    }
    this.moveEntities(stepMs);
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
    if (runtime.cooldownMs > 0) {
      return;
    }

    const target = this.entities.get(runtime.targetId);
    const targetRuntime = this.combat.get(runtime.targetId);
    if (!target || !targetRuntime || !targetRuntime.alive) {
      runtime.targetId = null;
      return;
    }

    const distance = horizontalDistance(attacker.state.position, target.state.position);
    if (distance > this.attackRangeOf(attacker)) {
      return;
    }

    const attackerAttributes = this.attributesOf(attacker);
    const targetAttributes = this.attributesOf(target);
    const hitChance = clamp(
      BASE_HIT_CHANCE + ((attackerAttributes.accuracy ?? 0) - (targetAttributes.evasion ?? 0)) / 100,
      0.05,
      1,
    );
    const hit = this.random() < hitChance;
    const damage = hit
      ? Math.max(
          1,
          Math.round((attackerAttributes.attack ?? 0) - (targetAttributes.defense ?? 0)),
        )
      : 0;

    runtime.cooldownMs = this.attackIntervalOf(attacker);
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

  private handleDeath(entity: Entity, killer: Entity): void {
    const runtime = this.combat.get(entity.id);
    if (!runtime) {
      return;
    }
    runtime.hp = 0;
    runtime.alive = false;
    runtime.cooldownMs = 0;
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
          },
          container: {
            items: entity.container.items.map((item) => ({ ...item })),
          },
          claimedRewardIds: [...entity.claimedRewardIds],
        };
      });

    return {
      version: GAME_SESSION_SNAPSHOT_VERSION,
      elapsedMs: this.elapsedMs,
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
