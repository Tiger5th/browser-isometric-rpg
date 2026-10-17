/**
 * 探索回报（票 37）：宝箱 + 收集品的纯逻辑解释口。
 *
 * 设计约定（specs/p2-batch2-quality-motivation「探索回报与相机」）：
 * - 宝箱/收集品的位置与战利品表是**内容数据**（content/chests、content/collectibles），
 *   本模块只解释，不持有内容；
 * - 世界的「已经开了吗 / 捡了吗」这类事实挂在 worldState（票 31 的通用容器），
 *   键名固定在这里，别处不要另起一套；
 * - 收集品的计数是**聚合**出来的（数 worldState 里 collected 的条目），
 *   不是另存一个计数器——这样读档天然不回退，也不会出现计数与实体不一致。
 *
 * 本模块零引擎依赖，可被 vitest 直测。
 */

import type { JsonValue } from "./game-session";
import type { Vec3 } from "./entity";

/** 交互判定距离：玩家走到这么近才算「在宝箱/收集品旁边」。 */
export const EXPLORATION_INTERACT_RANGE = 2;

export interface ChestLootEntry {
  itemId: string;
  /** 数量，必须 ≥1（schema 管）。 */
  quantity: number;
}

export interface ChestDefinition {
  id: string;
  displayName: string;
  regionId: string;
  position: Vec3;
  rotation?: Vec3;
  loot: ChestLootEntry[];
}

export interface CollectibleDefinition {
  id: string;
  displayName: string;
  regionId: string;
  position: Vec3;
  /** 拾取进包的物品（萤光草 = 现有 item 系统的一条物品）。 */
  itemId: string;
  quantity: number;
  /**
   * 收集品集（collect set）：同一集共享进度与全收集奖励。
   * 缺省时用 collectible id 自身当集 id——单件收集品也算一集。
   */
  setId?: string;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entry(worldState: Record<string, JsonValue>, key: string): Record<string, JsonValue> | null {
  const value = worldState[key];
  return isRecord(value) ? value : null;
}

/**
 * worldState 里的宝箱键：`chest:<local>`。
 * 参数既接受完整内容 id（`chest:hollow_stone`），也接受 local 部分，
 * 两种写法落在同一个键上——存档里出现的键名因此永远是这一种。
 */
export function chestKey(chestId: string): string {
  return withPrefix("chest", chestId, "chest:");
}

/** worldState 里的收集品键：`collectible:<local>`。 */
export function collectibleKey(collectibleId: string): string {
  return withPrefix("collectible", collectibleId, "collectible:");
}

/** worldState 里的「全收集奖励已发放」键：`collect_reward:<local>`。 */
export function collectRewardKey(setId: string): string {
  return withPrefix("collect_reward", setId, "collect_set:");
}

/**
 * 拼 worldState 键：内容 id 的命名空间前缀（`contentPrefix`）先剥掉，
 * 再挂 worldState 自己的命名空间（`namespace`）。
 * 这样两种入参写法——完整内容 id 或裸 local——落在同一个键上。
 */
function withPrefix(namespace: string, id: string, contentPrefix: string): string {
  const local = id.startsWith(contentPrefix) ? id.slice(contentPrefix.length) : id;
  return `${namespace}:${local}`;
}

/** 该宝箱是否已开启。 */
export function isChestOpened(worldState: Record<string, JsonValue>, chestId: string): boolean {
  return entry(worldState, chestKey(chestId))?.opened === true;
}

/** 该收集品是否已拾取。 */
export function isCollectibleCollected(
  worldState: Record<string, JsonValue>,
  collectibleId: string,
): boolean {
  return entry(worldState, collectibleKey(collectibleId))?.collected === true;
}

/** 某收集集的奖励是否已发放。 */
export function isCollectRewardGranted(
  worldState: Record<string, JsonValue>,
  setId: string,
): boolean {
  return entry(worldState, collectRewardKey(setId))?.granted === true;
}

/** 收集品 id → 集 id（缺省用自身）。 */
export function collectSetIdOf(definition: CollectibleDefinition): string {
  return definition.setId ?? definition.id;
}

export interface CollectProgress {
  setId: string;
  collected: number;
  total: number;
  /** 0–1；total 为 0 时为 0。 */
  ratio: number;
  /** 是否已全部收集（total ≥ 1 且收集齐）。 */
  complete: boolean;
  /** 奖励是否已经发过（读档后不会重复发）。 */
  rewardGranted: boolean;
}

/** 聚合某个收集集的进度（纯读 worldState）。 */
export function collectProgress(
  worldState: Record<string, JsonValue>,
  setId: string,
  members: readonly CollectibleDefinition[],
): CollectProgress {
  let collected = 0;
  for (const member of members) {
    if (isCollectibleCollected(worldState, member.id)) {
      collected += 1;
    }
  }
  const total = members.length;
  return {
    setId,
    collected,
    total,
    ratio: total === 0 ? 0 : collected / total,
    complete: total > 0 && collected >= total,
    rewardGranted: isCollectRewardGranted(worldState, setId),
  };
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 玩家是否已进入可交互距离。 */
export function withinInteractRange(playerPosition: Vec3, target: Vec3): boolean {
  return horizontalDistance(playerPosition, target) <= EXPLORATION_INTERACT_RANGE;
}

/** 写宝箱开启状态（返回新的 worldState 片段，供会话合并）。 */
export function chestOpenedState(): Record<string, JsonValue> {
  return { opened: true };
}

/** 写收集品拾取状态。 */
export function collectibleCollectedState(): Record<string, JsonValue> {
  return { collected: true };
}

/** 写全收集奖励已发放状态。 */
export function collectRewardGrantedState(): Record<string, JsonValue> {
  return { granted: true };
}