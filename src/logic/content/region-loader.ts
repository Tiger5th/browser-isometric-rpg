/**
 * 内容索引与区域实例化：把 content/ 数据转成 Entity。
 *
 * 纯函数、零引擎依赖。调用方负责先通过 L2 校验（tools/content/lint.mjs）；
 * 本模块仍会在引用缺失/重复时显式报错，避免坏数据静默进入会话。
 */

import { createEntity, type Entity } from "../entity";
import type {
  ContentBundle,
  EnemyDefinition,
  EnemyTemplateDefinition,
  ItemDefinition,
  NpcDefinition,
  QuestDefinition,
  RegionDefinition,
} from "./types";

export interface ContentIndex {
  bundle: ContentBundle;
  regions: Map<string, RegionDefinition>;
  npcs: Map<string, NpcDefinition>;
  enemyTemplates: Map<string, EnemyTemplateDefinition>;
  enemies: Map<string, EnemyDefinition>;
  items: Map<string, ItemDefinition>;
  quests: Map<string, QuestDefinition>;
}

function indexEntries<T extends { id: string }>(
  entries: readonly T[],
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    if (map.has(entry.id)) {
      throw new Error(`重复的${label} id：${entry.id}`);
    }
    map.set(entry.id, entry);
  }
  return map;
}

/** 建立内容索引；同一类别内重复 id 直接报错。 */
export function createContentIndex(bundle: ContentBundle): ContentIndex {
  return {
    bundle,
    regions: indexEntries(bundle.regions, "区域"),
    npcs: indexEntries(bundle.npcs, "NPC"),
    enemyTemplates: indexEntries(bundle.enemyTemplates, "敌人模板"),
    enemies: indexEntries(bundle.enemies, "敌人"),
    items: indexEntries(bundle.items, "物品"),
    quests: indexEntries(bundle.quests, "任务"),
  };
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function mergeTags(...lists: Array<readonly string[] | undefined>): string[] {
  const tags: string[] = [];
  for (const list of lists) {
    for (const tag of list ?? []) {
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }
  return tags;
}

/**
 * 实例化一个区域内的实体：玩家 + 本区域 NPC + 本区域敌人。
 *
 * 顺序确定：玩家、NPC（按 id）、敌人（按 id）。敌人属性 = 模板属性叠加实例覆盖；
 * 标签 = 模板标签 + 实例标签（去重）。
 */
export function instantiateRegionEntities(index: ContentIndex, regionId: string): Entity[] {
  const region = index.regions.get(regionId);
  if (!region) {
    throw new Error(`未知区域：${regionId}`);
  }

  const entities: Entity[] = [];
  const seen = new Set<string>();
  const push = (entity: Entity): void => {
    if (seen.has(entity.id)) {
      throw new Error(`重复的实体 id：${entity.id}`);
    }
    seen.add(entity.id);
    entities.push(entity);
  };

  push(
    createEntity({
      id: region.player.id,
      type: "player",
      templateId: region.player.templateId,
      displayName: region.player.displayName,
      baseAttributes: { ...region.player.baseAttributes },
      position: region.player.spawn.position,
      rotation: region.player.spawn.rotation,
      tags: ["player"],
    }),
  );

  const npcs = [...index.npcs.values()]
    .filter((npc) => npc.regionId === regionId)
    .sort(byId);
  for (const npc of npcs) {
    push(
      createEntity({
        id: npc.id,
        type: "npc",
        templateId: npc.templateId,
        displayName: npc.displayName,
        baseAttributes: { ...(npc.baseAttributes ?? {}) },
        position: npc.position,
        rotation: npc.rotation,
        tags: npc.tags ?? ["npc"],
        dialogueId: npc.dialogueId,
        questIds: npc.questIds,
      }),
    );
  }

  const enemies = [...index.enemies.values()]
    .filter((enemy) => enemy.regionId === regionId)
    .sort(byId);
  for (const enemy of enemies) {
    const template = index.enemyTemplates.get(enemy.templateId);
    if (!template) {
      throw new Error(`敌人 ${enemy.id} 引用了未知模板：${enemy.templateId}`);
    }
    push(
      createEntity({
        id: enemy.id,
        type: "enemy",
        templateId: template.id,
        displayName: enemy.displayName,
        baseAttributes: {
          ...template.baseAttributes,
          ...(enemy.overrides?.baseAttributes ?? {}),
        },
        position: enemy.position,
        rotation: enemy.rotation,
        tags: mergeTags(template.tags, enemy.tags),
        aiProfileId: template.aiProfileId,
        aiProfile: template.aiProfile,
      }),
    );
  }

  return entities;
}
