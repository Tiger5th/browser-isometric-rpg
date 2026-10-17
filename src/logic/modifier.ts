/**
 * 修饰器（Modifier）：属性变更的统一机制。
 * 装备加成、限时 buff、一次性任务奖励共用同一个列表模型。
 *
 * 计算规则（确定性）：effective = (base + Σ add) × (1 + Σ multiply)
 * - add     ：平坦加值
 * - multiply ：百分比加值，0.1 表示 +10%
 */

import type { Entity } from "./entity";
import type { ItemInstance } from "./entity";

export type ModifierOperation = "add" | "multiply";
/**
 * 修饰器来源类别。`level`（票 34）是成长系统的永久加成：
 * 它按等级整体重算，而不是逐次叠加，因此移除方式是整源替换。
 */
export type ModifierSourceKind = "equipment" | "buff" | "quest" | "level";

export interface ModifierTemplate {
  attribute: string;
  operation: ModifierOperation;
  value: number;
}

export interface ModifierSource {
  kind: ModifierSourceKind;
  id: string;
}

export interface Modifier extends ModifierTemplate {
  /** 修饰器实例 id，同一位置内唯一。 */
  id: string;
  source: ModifierSource;
  /** 绝对游戏时间（毫秒）；缺省表示永久修饰器。 */
  expiresAt?: number;
}

function assertTemplate(template: ModifierTemplate): void {
  if (template.attribute.trim() === "") {
    throw new Error("修饰器 attribute 不能为空");
  }
  if (!Number.isFinite(template.value)) {
    throw new Error(`修饰器 ${template.attribute} 的 value 必须是有限数值`);
  }
  if (template.operation !== "add" && template.operation !== "multiply") {
    throw new Error(`未知修饰器操作：${String(template.operation)}`);
  }
}

export interface CreateModifiersOptions {
  expiresAt?: number;
  /** 自定义 id 前缀，用于同一 source 的多次叠加（buff stack）。 */
  idPrefix?: string;
}

export function createModifiers(
  templates: readonly ModifierTemplate[],
  source: ModifierSource,
  options: CreateModifiersOptions = {},
): Modifier[] {
  const idPrefix = options.idPrefix ?? `${source.kind}:${source.id}`;
  return templates.map((template, index) => {
    assertTemplate(template);
    return {
      id: `${idPrefix}:${index}`,
      attribute: template.attribute,
      operation: template.operation,
      value: template.value,
      source: { ...source },
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    };
  });
}

export function isModifierActive(modifier: Modifier, now: number): boolean {
  return modifier.expiresAt === undefined || modifier.expiresAt > now;
}

/** 返回追加修饰器后的新实体（不修改入参）。 */
export function appendModifiers(entity: Entity, modifiers: readonly Modifier[]): Entity {
  const cloned = modifiers.map((modifier) => ({
    ...modifier,
    source: { ...modifier.source },
  }));
  return { ...entity, modifiers: [...entity.modifiers, ...cloned] };
}

export function removeModifiersBySource(entity: Entity, source: ModifierSource): Entity {
  return {
    ...entity,
    modifiers: entity.modifiers.filter(
      (modifier) => modifier.source.kind !== source.kind || modifier.source.id !== source.id,
    ),
  };
}

/** 移除所有到期修饰器（写入存档/切场景等时机调用）。 */
export function expireModifiers(entity: Entity, now: number): Entity {
  return {
    ...entity,
    modifiers: entity.modifiers.filter((modifier) => isModifierActive(modifier, now)),
  };
}

/** 计算当前有效属性；到期修饰器不参与计算。 */
export function effectiveAttributes(entity: Entity, now: number): Record<string, number> {
  const additions: Record<string, number> = {};
  const multipliers: Record<string, number> = {};

  for (const modifier of entity.modifiers) {
    if (!isModifierActive(modifier, now)) {
      continue;
    }
    const bucket = modifier.operation === "add" ? additions : multipliers;
    bucket[modifier.attribute] = (bucket[modifier.attribute] ?? 0) + modifier.value;
  }

  const keys = new Set([
    ...Object.keys(entity.baseAttributes),
    ...Object.keys(additions),
    ...Object.keys(multipliers),
  ]);
  const result: Record<string, number> = {};
  for (const key of keys) {
    const base = entity.baseAttributes[key] ?? 0;
    const addition = additions[key] ?? 0;
    const multiplier = multipliers[key] ?? 0;
    result[key] = (base + addition) * (1 + multiplier);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 场景一：装备加成
// ---------------------------------------------------------------------------

export interface EquipmentDefinition {
  templateId: string;
  modifiers: ModifierTemplate[];
}

/**
 * 装备物品：物品进入容器并标记 equipped，同时按 instanceId 挂上修饰器。
 * 重复装备同一 instance 会先清掉旧修饰器（幂等）。
 */
export function equipItem(
  entity: Entity,
  item: ItemInstance,
  equipment: EquipmentDefinition,
): Entity {
  if (item.templateId !== equipment.templateId) {
    throw new Error(
      `物品模板不匹配：item=${item.templateId} equipment=${equipment.templateId}`,
    );
  }
  if (!Number.isFinite(item.quantity) || item.quantity < 1) {
    throw new Error("装备数量必须大于 0");
  }

  const source: ModifierSource = { kind: "equipment", id: item.instanceId };
  const withoutOldModifiers = removeModifiersBySource(entity, source);
  const items = withoutOldModifiers.container.items.map((existing) =>
    existing.instanceId === item.instanceId
      ? { ...existing, equipped: true }
      : { ...existing },
  );
  if (!items.some((existing) => existing.instanceId === item.instanceId)) {
    items.push({ ...item, equipped: true });
  }

  return appendModifiers(
    { ...withoutOldModifiers, container: { items } },
    createModifiers(equipment.modifiers, source),
  );
}

/** 卸下物品：移除该实例产生的全部修饰器。 */
export function unequipItem(entity: Entity, instanceId: string): Entity {
  const withoutModifiers = removeModifiersBySource(entity, {
    kind: "equipment",
    id: instanceId,
  });
  return {
    ...withoutModifiers,
    container: {
      items: withoutModifiers.container.items.map((item) =>
        item.instanceId === instanceId ? { ...item, equipped: false } : { ...item },
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// 场景二：限时 buff
// ---------------------------------------------------------------------------

export type BuffStacking = "refresh" | "stack";

export interface BuffDefinition {
  id: string;
  durationMs: number;
  modifiers: ModifierTemplate[];
  /** 缺省 refresh：再次施加刷新持续时间；stack：叠加层数。 */
  stacking?: BuffStacking;
  /** 仅 stack 模式生效；缺省不限层数。 */
  maxStacks?: number;
}

/**
 * 施加 buff。expiresAt 使用绝对游戏时间，可直接随存档序列化。
 * - refresh：同一 buff 只保留最新一次，重置到期时间；
 * - stack：每次施加上一层，最多 maxStacks 层。
 */
export function applyBuff(entity: Entity, buff: BuffDefinition, now: number): Entity {
  if (!Number.isFinite(buff.durationMs) || buff.durationMs <= 0) {
    throw new Error("buff durationMs 必须是正数");
  }
  const source: ModifierSource = { kind: "buff", id: buff.id };
  const expiresAt = now + buff.durationMs;
  const cleaned = expireModifiers(entity, now);

  if ((buff.stacking ?? "refresh") === "refresh") {
    return appendModifiers(
      removeModifiersBySource(cleaned, source),
      createModifiers(buff.modifiers, source, { expiresAt }),
    );
  }

  if (buff.modifiers.length === 0) {
    return cleaned;
  }
  const existing = cleaned.modifiers.filter(
    (modifier) => modifier.source.kind === "buff" && modifier.source.id === buff.id,
  );
  const stackCount = Math.floor(existing.length / buff.modifiers.length);
  if (stackCount >= (buff.maxStacks ?? Number.POSITIVE_INFINITY)) {
    return cleaned;
  }

  // 用已存在层的最大序号推导下一层，避免层到期后复用 id。
  const stackIndexes = existing.flatMap((modifier) => {
    const match = /:stack(\d+):/.exec(modifier.id);
    return match === null ? [] : [Number(match[1])];
  });
  const nextStackIndex = stackIndexes.length === 0 ? 0 : Math.max(...stackIndexes) + 1;

  return appendModifiers(
    cleaned,
    createModifiers(buff.modifiers, source, {
      expiresAt,
      idPrefix: `buff:${buff.id}:stack${nextStackIndex}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// 场景三：一次性任务奖励
// ---------------------------------------------------------------------------

export interface QuestRewardDefinition {
  /** 领取账本 id；同一 reward 只能发放一次。 */
  id: string;
  modifiers: ModifierTemplate[];
}

/** 发放任务奖励；已领取时原样返回（幂等）。奖励修饰器永久生效。 */
export function grantQuestReward(entity: Entity, reward: QuestRewardDefinition): Entity {
  if (entity.claimedRewardIds.includes(reward.id)) {
    return entity;
  }
  const source: ModifierSource = { kind: "quest", id: reward.id };
  return {
    ...appendModifiers(entity, createModifiers(reward.modifiers, source)),
    claimedRewardIds: [...entity.claimedRewardIds, reward.id],
  };
}
