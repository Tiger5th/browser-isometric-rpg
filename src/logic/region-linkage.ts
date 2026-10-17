/**
 * 区域联动（票 35）：路口/传送点的**纯几何判定**。
 *
 * 为什么单独成模块：区域切换是 P1 明确不支持的动作（GameSession.loadRegion
 * 此前直接报错），而「玩家走到路口就切区域」这件事本身只是
 * 「一组出口点 vs 一个玩家位置」的纯函数判定，没有任何引擎/会话依赖。
 * 把它放在逻辑层可以让「走到底触发」这条契约被 L1 直接测，
 * 渲染层只负责拿到结果后走黑场 + 会话切区域。
 *
 * 判定半径取 1.6m：比角色碰撞半径（0.4m）宽，比一个地块（6m）窄，
 * 因此「走到区域边缘的路口」会触发，站在路口旁边来回走不会来回切区。
 */

/** 出口触发半径（米）。 */
export const EXIT_TRIGGER_RADIUS = 1.6;

/** 与 content/regions/*.json 的 exits 字段同形（渲染层传入，模块不解释内容）。 */
export interface RegionLinkageExit {
  id: string;
  targetRegionId: string;
  position: { x: number; y: number; z: number };
}

export interface Vec2Like {
  x: number;
  z: number;
}

/**
 * 找到玩家当前位置触发的出口（最近的一个在半径内的）。
 * 没有出口在半径内时返回 null——调用方据此什么都不做。
 *
 * 多个出口重叠时取距离最近者，保证结果与 exits 数组顺序无关（确定性）。
 */
export function findTriggeredExit(
  exits: readonly RegionLinkageExit[],
  position: Vec2Like,
  radius: number = EXIT_TRIGGER_RADIUS,
): RegionLinkageExit | null {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error("出口触发半径必须是正的有限数值");
  }

  let best: RegionLinkageExit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const exit of exits) {
    const distance = Math.hypot(
      exit.position.x - position.x,
      exit.position.z - position.z,
    );
    if (distance > radius) {
      continue;
    }
    if (distance < bestDistance) {
      best = exit;
      bestDistance = distance;
    }
  }

  return best;
}