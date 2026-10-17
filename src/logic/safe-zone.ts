/**
 * 安全区几何（票 33，user story 12）。
 *
 * 安全区 = 区域内容里定义的矩形地带，敌人 AI 的追击意图进入时由逻辑层拒止
 * （不追入，见 GameSession.updateEnemyBehavior）。这里只做纯几何判定：
 * 零引擎依赖、零状态，可 L1 直测。
 *
 * 为什么要独立的矩形而不是「距离村庄中心多少米」：内容作者需要在关卡里
 * 画出可走的安全范围（围栏、河流、栅栏），矩形 + 中心 + 半长宽最直观，
 * 也便于将来给多边形留替换位（调用方只依赖 insideSafeZone）。
 */

import type { Vec3 } from "./entity";

/** 内容层的安全区定义（region.safeZones 的运行时代码形态）。 */
export interface SafeZoneDefinition {
  id: string;
  shape: "rect";
  /** 矩形中心。 */
  center: Vec3;
  /** 沿 X/Z 轴的半长宽（米）。 */
  halfExtents: { x: number; z: number };
}

/** 水平距离判定：y 轴不参与（安全区是地面上的地带）。 */
export function insideSafeZone(zone: SafeZoneDefinition, point: Vec3): boolean {
  return (
    Math.abs(point.x - zone.center.x) <= zone.halfExtents.x &&
    Math.abs(point.z - zone.center.z) <= zone.halfExtents.z
  );
}

/**
 * 点是否落在任一安全区内。zones 为空时恒为 false（无安全区的区域行为不变）。
 */
export function insideAnySafeZone(
  zones: readonly SafeZoneDefinition[],
  point: Vec3,
): boolean {
  return zones.some((zone) => insideSafeZone(zone, point));
}

/**
 * 从区域的 exit/实体出生点视角，给出「点所在的安全区」；不在安全区内为 null。
 * 供表现层画地面色块（调试可视化）与日志使用。
 */
export function safeZoneAt(
  zones: readonly SafeZoneDefinition[],
  point: Vec3,
): SafeZoneDefinition | null {
  return zones.find((zone) => insideSafeZone(zone, point)) ?? null;
}
