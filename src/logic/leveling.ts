/**
 * 等级曲线（票 34）：把累计经验换算成等级，并给出每级属性加成。
 *
 * 曲线是内容数据（content/level-curves/*.json，见 level-curve.schema.json），
 * 本模块是它的运行时形态与唯一解释口：GameSession 结算升级、HUD 显示徽标、
 * L2 lint 的单调性校验都走这里，避免三处各写一份阈值逻辑。
 */

import type { ModifierTemplate } from "./modifier";

/** 曲线里的一级。 */
export interface LevelDefinition {
  level: number;
  /** 到达该等级所需的**累计**经验（非增量）。 */
  xpRequired: number;
  /** 该级的属性加成；缺省用曲线的 defaultModifiers。 */
  modifiers?: ModifierTemplate[];
}

export interface LevelCurveDefinition {
  id: string;
  displayName: string;
  /** 每级默认属性加成；单级可覆盖。 */
  defaultModifiers: ModifierTemplate[];
  /** 按 level 升序、从 1 开始连续。 */
  levels: LevelDefinition[];
}

export interface LevelProgress {
  level: number;
  cumulativeXp: number;
  /** 距下一级还差多少累计经验；已满级为 null。 */
  xpToNext: number | null;
  /** 下一级的累计经验阈值（HUD 经验文案的分母）；已满级为 null。 */
  nextThreshold: number | null;
  /** 1 → level 累计的属性加成（修饰器模板，按等级升序展开）。 */
  modifiers: ModifierTemplate[];
}

/** 曲线是否可用（levels 非空、level 从 1 连续递增）。运行时假定已过 L2。 */
function sortedLevels(curve: LevelCurveDefinition): LevelDefinition[] {
  return [...curve.levels].sort((left, right) => left.level - right.level);
}

/** 累计经验对应的等级：取满足 xpRequired <= cumulativeXp 的最高等级。 */
export function levelForXp(curve: LevelCurveDefinition, cumulativeXp: number): number {
  const xp = Number.isFinite(cumulativeXp) ? cumulativeXp : 0;
  let level = 1;
  for (const definition of sortedLevels(curve)) {
    if (xp >= definition.xpRequired) {
      level = definition.level;
    }
  }
  return level;
}

/** 下一级的累计经验阈值；满级为 null。 */
export function nextLevelThreshold(
  curve: LevelCurveDefinition,
  level: number,
): number | null {
  const next = sortedLevels(curve).find((entry) => entry.level === level + 1);
  return next?.xpRequired ?? null;
}

/** 满级时 xpToNext 为 null。 */
export function xpToNextLevel(
  curve: LevelCurveDefinition,
  level: number,
  cumulativeXp: number,
): number | null {
  const ordered = sortedLevels(curve);
  const current = ordered.find((entry) => entry.level === level);
  if (current === undefined) {
    return null;
  }
  const next = ordered.find((entry) => entry.level === level + 1);
  if (next === undefined) {
    return null;
  }
  return Math.max(0, next.xpRequired - cumulativeXp);
}

/** 1 → level 的累计属性加成；升序展开，交给修饰器系统入账。 */
export function modifiersForLevel(
  curve: LevelCurveDefinition,
  level: number,
): ModifierTemplate[] {
  const templates: ModifierTemplate[] = [];
  for (const definition of sortedLevels(curve)) {
    // L1 是基准等级：属性加成是「每升一级」的一份，因此不含 L1。
    if (definition.level <= 1) {
      continue;
    }
    if (definition.level > level) {
      break;
    }
    templates.push(...(definition.modifiers ?? curve.defaultModifiers));
  }
  return templates;
}

/**
 * 当前等级的经验条进度（0–1）：按本级的经验区间算，
 * 而不是「累计经验 / 距下一级的差额」——后者在刚进级时会跳到接近满格。
 * 满级返回 1。
 */
export function levelProgressRatio(
  curve: LevelCurveDefinition,
  cumulativeXp: number,
): number {
  const xp = Number.isFinite(cumulativeXp) ? Math.max(0, cumulativeXp) : 0;
  const ordered = sortedLevels(curve);
  const level = levelForXp(curve, xp);
  const current = ordered.find((entry) => entry.level === level);
  const next = ordered.find((entry) => entry.level === level + 1);
  if (current === undefined || next === undefined) {
    return 1;
  }
  const span = next.xpRequired - current.xpRequired;
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (xp - current.xpRequired) / span));
}

/** 一次结算的等级进度快照（level / cumulativeXp / 距下一级 / 累计加成）。 */
export function resolveLevelProgress(
  curve: LevelCurveDefinition,
  cumulativeXp: number,
): LevelProgress {
  const level = levelForXp(curve, cumulativeXp);
  return {
    level,
    cumulativeXp,
    xpToNext: xpToNextLevel(curve, level, cumulativeXp),
    nextThreshold: nextLevelThreshold(curve, level),
    modifiers: modifiersForLevel(curve, level),
  };
}

/**
 * 曲线结构校验（返回人类可读的问题列表，空数组表示合法）。
 * L2 lint 与逻辑层都调用它：内容写错时不该静默把玩家卡在某个等级。
 */
export function validateLevelCurve(curve: unknown): string[] {
  if (typeof curve !== "object" || curve === null || Array.isArray(curve)) {
    return ["等级曲线必须是对象"];
  }
  const data = curve as Partial<LevelCurveDefinition>;
  const issues: string[] = [];
  if (typeof data.id !== "string" || data.id.trim() === "") {
    issues.push("id 必须是非空字符串");
  }
  if (!Array.isArray(data.defaultModifiers) || data.defaultModifiers.length === 0) {
    issues.push("defaultModifiers 至少要有一项（每级加属性的载体）");
  }
  if (!Array.isArray(data.levels) || data.levels.length === 0) {
    issues.push("levels 不能为空");
    return issues;
  }

  let previousXp = -1;
  let previousLevel = 0;
  for (const [index, definition] of data.levels.entries()) {
    if (typeof definition !== "object" || definition === null) {
      issues.push(`/levels/${index} 必须是对象`);
      continue;
    }
    if (definition.level !== previousLevel + 1) {
      issues.push(`/levels/${index}/level 必须从 1 起连续递增，实际为 ${String(definition.level)}`);
    }
    if (!Number.isFinite(definition.xpRequired) || definition.xpRequired < 0) {
      issues.push(`/levels/${index}/xpRequired 必须是非负有限数值`);
    } else if (definition.xpRequired <= previousXp) {
      issues.push(
        `/levels/${index}/xpRequired（${definition.xpRequired}）必须严格大于上一级（${previousXp}）`,
      );
    }
    if (definition.modifiers !== undefined && !Array.isArray(definition.modifiers)) {
      issues.push(`/levels/${index}/modifiers 必须是数组`);
    }
    previousLevel = definition.level;
    previousXp = definition.xpRequired;
  }
  if (data.levels[0]?.xpRequired !== 0) {
    issues.push("levels[0].xpRequired 必须为 0（L1 不需要经验）");
  }
  return issues;
}