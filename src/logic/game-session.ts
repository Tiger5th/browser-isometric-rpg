/**
 * GameSession：游戏逻辑核心。
 *
 * 单一时钟 + 实体集合 + 对话/任务状态；渲染层只允许读取 snapshot() 并提交意图，
 * 不得直接访问或修改实体。本模块零引擎依赖，可在 vitest 中手动推进时间。
 *
 * 对话复用 P0 的 inkjs 封装（src/logic/dialogue.ts），任务状态机见 src/logic/quest.ts。
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
import type { CombatEvent, GameSessionEvent, GameSessionEventListener } from "./game-events";
import { createContentIndex, instantiateRegionEntities } from "./content/region-loader";
import type { ContentBundle, QuestDefinition } from "./content/types";
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
 * v2（票 22）：实体快照补充属性/背包/修饰器，顶层新增 dialogue 与 quests。
 */
export const GAME_SESSION_SNAPSHOT_VERSION = 2;

/** 渲染层可提交的意图集合；后续按票逐步扩展 useItem/equip 等。 */
export interface GameSessionIntents {
  moveTo(entityId: EntityId | string, target: Vec3): void;
  /** 与 NPC 开始对话；对话通过 ink 选项推进。 */
  talkTo(entityId: EntityId | string): void;
  /** 选择当前对话的第 index 个选项。 */
  chooseDialogueOption(index: number): void;
  /**
   * 战斗子系统（票 21）的写入入口：把战斗事件送入会话。
   * 任务目标只订阅 enemy-killed；本方法不实现任何战斗规则。
   */
  emitCombatEvent(event: CombatEvent): void;
}

export interface EntityMovementSnapshot {
  target: Vec3;
  speed: number;
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
  /** 按当前游戏时间计算的有效属性（任务奖励/装备修饰器已生效）。 */
  effectiveAttributes: Record<string, number>;
  modifiers: Modifier[];
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

export class GameSession implements GameSessionIntents {
  /** 以 EntityId 为键；值本身也不对外暴露，避免渲染层绕过意图直接修改。 */
  private readonly entities = new Map<EntityId, Entity>();
  private readonly movements = new Map<EntityId, Movement>();
  private readonly dialogues = new Map<string, string | Record<string, unknown>>();
  private readonly eventListeners = new Set<GameSessionEventListener>();
  private readonly questDefinitions = new Map<string, QuestDefinition>();
  private questLog = new QuestLog([]);
  private dialogue: ActiveDialogue | null = null;
  private playerId: EntityId | null = null;
  private elapsedMs = 0;
  private regionId: string | null = null;

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
    if (this.playerId === null && cloned.identity.type === "player") {
      this.playerId = cloned.id;
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
    this.regionId = regionId;
  }

  /** 当前已加载的区域 id；未加载时为 null。 */
  get currentRegionId(): string | null {
    return this.regionId;
  }

  /** 提交移动到目标点的意图；重复提交会替换当前移动。 */
  moveTo(entityId: EntityId | string, target: Vec3): void {
    const id = entityId as EntityId;
    const entity = this.entities.get(id);
    if (!entity) {
      throw new Error(`未知实体：${entityId}`);
    }
    assertFiniteVec3(target, "移动目标");
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

  /** 战斗事件入口（票 21 调用）；本票只消费 enemy-killed 推进任务。 */
  emitCombatEvent(event: CombatEvent): void {
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

    const newlyReady = this.questLog.recordEnemyKill(event.enemyTemplateId);
    this.publish(event);
    for (const questId of newlyReady) {
      this.publish({ type: "quest-ready", questId });
    }
  }

  /** 订阅会话事件；返回取消订阅函数。 */
  subscribe(listener: GameSessionEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** 手动推进游戏时钟（毫秒）。deltaMs 必须是非负有限值。 */
  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new Error("advance 的 deltaMs 必须是非负有限数值");
    }
    this.elapsedMs += deltaMs;

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
      const step = (movement.speed * deltaMs) / 1000;

      if (distance <= step || distance === 0) {
        position.x = movement.target.x;
        position.y = movement.target.y;
        position.z = movement.target.z;
        this.movements.delete(id);
        continue;
      }

      position.x += (dx / distance) * step;
      position.z += (dz / distance) * step;
      // 与 Crowd V2 的视觉朝向约定一致（+Z 为 0，朝 +X 为 π/2）。
      entity.state.rotation.y = Math.atan2(dx, dz);
    }
  }

  /** 只读快照：每次调用都返回新对象，渲染层无法借此修改内部状态。 */
  snapshot(): GameSessionSnapshot {
    const now = this.elapsedMs;
    const entities: EntitySnapshot[] = [...this.entities.values()]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((entity) => {
        const movement = this.movements.get(entity.id);
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
          effectiveAttributes: effectiveAttributes(entity, now),
          modifiers: entity.modifiers.map(cloneModifier),
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
