/**
 * 区域上下文（code-review 收敛项）：把「随切区整体替换」的表现层事实
 * 收敛到一个显式对象里——regionId + bounds + colliders + 灌木列表 +
 * 实体视觉重建计划。p1-world 切区时整体替换，区域相关逻辑不再各自
 * 引用翠谷常量（review #3/#4/#13 的根因）。
 */

import type { EntitySnapshot } from "../../logic/game-session";
import type { PropPlacement } from "./green-hollow-layout";
import type { Bounds2DLike, PropCollider } from "./world-physics";

/** 玩家实体 id（内容里固定；玩家视觉跨区域保留）。 */
const PLAYER_ENTITY_ID = "entity:player";

/** 灌木遮挡判定用的最小灌木（每帧热路径，只留必要字段）。 */
export interface BushEntry {
  id: string;
  x: number;
  z: number;
}

/** 实体视觉重建计划：切区后一次性执行的清理/新建清单。 */
export interface EntityVisualRebuildPlan {
  /** 需要销毁的旧视觉（含快照里已不存在的陈旧 id）；玩家不在其列。 */
  disposeIds: string[];
  /** 需要新建视觉的实体（NPC/敌人；玩家跨区域保留）。 */
  create: EntitySnapshot[];
}

/**
 * 纯函数：对比当前实体视觉表与新区域快照，给出视觉重建计划。
 * - 玩家跨区域保留，既不清也不建；
 * - 快照里没有的旧视觉（上一区域的 NPC/敌人、任何陈旧 id）全部清掉；
 * - 快照里尚无视觉的 NPC/敌人全部新建（巢穴敌人必须有 visual）。
 */
export function planEntityVisualRebuild(
  snapshotEntities: readonly EntitySnapshot[],
  existingVisualIds: ReadonlySet<string>,
): EntityVisualRebuildPlan {
  const snapshotIds = new Set<EntitySnapshot['id']>(
    snapshotEntities.map((entity) => entity.id),
  );
  const disposeIds: string[] = [];
  for (const id of existingVisualIds) {
    if (id !== PLAYER_ENTITY_ID && !snapshotIds.has(id as EntitySnapshot["id"])) {
      disposeIds.push(id);
    }
  }
  const create = snapshotEntities.filter(
    (entity) =>
      entity.identity.type !== "player" && !existingVisualIds.has(entity.id),
  );
  return { disposeIds, create };
}

/**
 * 布局的灌木列表缓存（code-review #31）：帧内热路径只查表不重建。
 * 纯函数 + 一次性调用，调用方在切区时算好存进区域上下文。
 */
export function bushesOf(props: readonly PropPlacement[]): BushEntry[] {
  return props
    .filter((prop) => prop.kind === "bush")
    .map((prop) => ({ id: prop.id, x: prop.x, z: prop.z }));
}

/** 一个区域表现层的完整上下文：切区时整体替换。 */
export interface RegionContext {
  regionId: string | null;
  bounds: Bounds2DLike;
  colliders: readonly PropCollider[];
  /** 灌木缓存（bushesOf(props)，切区时重建一次）。 */
  bushes: readonly BushEntry[];
}
