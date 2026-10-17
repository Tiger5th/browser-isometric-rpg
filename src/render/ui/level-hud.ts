/**
 * HUD 等级徽标的视图模型（票 34）。
 *
 * HUD 只消费 GameSession.snapshot()，所以「等级/经验进度条」这一层换算必须是
 * 纯函数：渲染层搭 DOM，逻辑与数据都留在这里。等级曲线可选——没接入成长系统时
 * 回退到实体属性（`level` / `xpToNext`），HUD 仍能显示而不是空着。
 */

import {
  levelForXp,
  levelProgressRatio,
  nextLevelThreshold,
  xpToNextLevel,
  type LevelCurveDefinition,
} from "../../logic/leveling";

export interface LevelHudInput {
  /** 累计经验（玩家基础属性 xp）。 */
  xp: number;
  /** 等级（玩家基础属性 level）；无曲线时的回退来源。 */
  level?: number | undefined;
  /** 内容属性 xpToNext；无曲线时的回退来源（历史内容里由区域 JSON 提供）。 */
  xpToNext?: number | undefined;
}

export interface LevelHudView {
  level: number;
  xp: number;
  /** 距下一级的累计经验差额；满级时为 null。 */
  xpToNext: number | null;
  /** 经验文案的分母（下一级的累计经验阈值）；满级时为 null。 */
  nextThreshold: number | null;
  /** 0–1 的经验条比例。 */
  xpRatio: number;
  /** 徽标文案，如「Lv.3」。 */
  badge: string;
  /** 是否真的满级（有曲线且没有下一级）；没曲线时为 false。 */
  maxed: boolean;
  /** 经验文案，如「经验 260 / 190」或满级时的「经验 260（满级）」。 */
  xpText: string;
}

function positiveOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/**
 * 等级徽标 + 经验条的显示值。
 *
 * 有曲线时曲线说了算（曲线是成长系统的唯一真相来源）；没有曲线时按实体属性显示，
 * 让「只有 xp、还没有等级」的老内容继续有数值可看。
 */
export function levelHudView(
  input: LevelHudInput,
  curve?: LevelCurveDefinition | undefined,
): LevelHudView {
  const xp = Number.isFinite(input.xp) ? Math.max(0, Math.round(input.xp)) : 0;
  const level =
    curve === undefined
      ? Math.max(1, Math.round(input.level ?? 1))
      : levelForXp(curve, xp);
  const xpToNext =
    curve === undefined ? positiveOrNull(input.xpToNext) : xpToNextLevel(curve, level, xp);
  const nextThreshold =
    curve === undefined ? xpToNext : nextLevelThreshold(curve, level);
  // 有曲线时按本级区间算进度；没曲线时按旧内容口径（累计经验 / xpToNext）算。
  const xpRatio =
    curve !== undefined
      ? levelProgressRatio(curve, xp)
      : xpToNext === null
        ? 0
        : Math.min(1, Math.max(0, xp / xpToNext));
  const maxed = curve !== undefined && xpToNext === null;
  return {
    level,
    xp,
    xpToNext,
    nextThreshold,
    xpRatio,
    badge: `Lv.${level}`,
    maxed,
    xpText:
      xpToNext === null
        ? maxed
          ? `经验 ${xp}（满级）`
          : `经验 ${xp}`
        : `经验 ${xp} / ${nextThreshold}`,
  };
}