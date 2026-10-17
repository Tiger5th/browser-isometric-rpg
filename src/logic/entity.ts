/**
 * Entity 数据模型：身份 + 状态 + 容器 + 属性 + 引用。
 * 零引擎依赖——位置/旋转使用本模块自有的 Vec3，而不是 Babylon 的 Vector3。
 */

import type { Modifier } from "./modifier";

/** 全局唯一实体标识。 */
export type EntityId = string & { readonly __entityId: unique symbol };

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface EntityIdentity {
  /** 实体大类：player / npc / enemy / item 等。 */
  type: string;
  /** 内容模板 id。 */
  templateId: string;
  displayName: string;
}

export interface EntityState {
  position: Vec3;
  rotation: Vec3;
  /** 行为/剧情标签（如 "hostile"、"in-combat"）。 */
  tags: string[];
}

export interface ItemInstance {
  /** 物品实例 id；装备修饰器以它为 source id。 */
  instanceId: string;
  templateId: string;
  quantity: number;
  equipped: boolean;
}

export interface EntityContainer {
  items: ItemInstance[];
}

export interface EntityReferences {
  dialogueId?: string;
  questIds: string[];
  aiProfileId?: string;
}

export interface Entity {
  id: EntityId;
  identity: EntityIdentity;
  state: EntityState;
  container: EntityContainer;
  /** 未经修饰器影响的基础属性值。 */
  baseAttributes: Record<string, number>;
  /** 装备 / buff / 任务奖励共用的修饰器列表。 */
  modifiers: Modifier[];
  /** 一次性奖励领取账本，保证任务奖励不会重复发放。 */
  claimedRewardIds: string[];
  references: EntityReferences;
}

export interface CreateEntityInput {
  id: string;
  type: string;
  templateId: string;
  displayName: string;
  baseAttributes?: Record<string, number>;
  position?: Vec3;
  rotation?: Vec3;
  tags?: string[];
  dialogueId?: string;
  questIds?: string[];
  aiProfileId?: string;
}

export function asEntityId(value: string): EntityId {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("EntityId 必须是非空字符串");
  }
  return value as EntityId;
}

function copyVec3(value: Vec3 | undefined): Vec3 {
  if (value === undefined) {
    return { x: 0, y: 0, z: 0 };
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isFinite(value[axis])) {
      throw new Error(`位置/旋转的 ${axis} 必须是有限数值`);
    }
  }
  return { x: value.x, y: value.y, z: value.z };
}

function copyAttributes(input: Record<string, number> | undefined): Record<string, number> {
  const attributes: Record<string, number> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (key.trim() === "" || !Number.isFinite(value)) {
      throw new Error(`属性 ${key} 必须是有限数值`);
    }
    attributes[key] = value;
  }
  return attributes;
}

export function createEntity(input: CreateEntityInput): Entity {
  return {
    id: asEntityId(input.id),
    identity: {
      type: input.type,
      templateId: input.templateId,
      displayName: input.displayName,
    },
    state: {
      position: copyVec3(input.position),
      rotation: copyVec3(input.rotation),
      tags: [...(input.tags ?? [])],
    },
    container: { items: [] },
    baseAttributes: copyAttributes(input.baseAttributes),
    modifiers: [],
    claimedRewardIds: [],
    references: {
      ...(input.dialogueId !== undefined ? { dialogueId: input.dialogueId } : {}),
      questIds: [...(input.questIds ?? [])],
      ...(input.aiProfileId !== undefined ? { aiProfileId: input.aiProfileId } : {}),
    },
  };
}

/** 深拷贝实体，供纯函数式修改使用（不共享数组/对象引用）。 */
export function cloneEntity(entity: Entity): Entity {
  return {
    id: entity.id,
    identity: { ...entity.identity },
    state: {
      position: { ...entity.state.position },
      rotation: { ...entity.state.rotation },
      tags: [...entity.state.tags],
    },
    container: {
      items: entity.container.items.map((item) => ({ ...item })),
    },
    baseAttributes: { ...entity.baseAttributes },
    modifiers: entity.modifiers.map((modifier) => ({
      ...modifier,
      source: { ...modifier.source },
    })),
    claimedRewardIds: [...entity.claimedRewardIds],
    references: {
      ...entity.references,
      questIds: [...entity.references.questIds],
    },
  };
}
