/**
 * 反馈层核心的单元测试（票 27）。
 *
 * 接缝 = CombatFeedbackCore 的 onDamage/onHealth/setPinned/view()：
 * 反馈层只消费事件、不改变游戏状态——这些测试全部用事件数据驱动，
 * 不接触 GameSession。
 */

import { describe, expect, it } from "vitest";

import {
  CombatFeedbackCore,
  DAMAGE_FEED_RISE_MS,
  HEALTH_BAR_LINGER_MS,
} from "./combat-feedback-core";

function core() {
  return new CombatFeedbackCore();
}

describe("CombatFeedbackCore 伤害飘字", () => {
  it("对敌伤害产生黄色飘字，普攻 intensity 按伤害占比缩放", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 13,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 1000,
    });

    const { damage, pulses } = feedback.view(1000);
    expect(damage).toHaveLength(1);
    expect(damage[0]).toMatchObject({
      targetId: "enemy:slime",
      amount: 11,
      incoming: false,
      heavy: false,
      previousHp: 24,
      hp: 13,
      maxHp: 24,
    });
    expect(pulses[0]).toMatchObject({ incoming: false, heavy: false });
    expect(pulses[0].intensity).toBeGreaterThan(0.9); // 11/24 ≈ 0.46 × 2
  });

  it("玩家受击产生红色飘字与 incoming 脉冲", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "entity:player",
      amount: 2,
      targetHp: 98,
      targetMaxHp: 100,
      heavy: false,
      incoming: true,
      at: 2000,
    });

    const { damage, pulses } = feedback.view(2000);
    expect(damage[0]).toMatchObject({ incoming: true, amount: 2 });
    expect(pulses[0]).toMatchObject({ incoming: true });
  });

  it("重击飘字标记 heavy 且脉冲强度封顶为 1", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 17,
      targetHp: 7,
      targetMaxHp: 24,
      heavy: true,
      incoming: false,
      at: 3000,
    });

    const { damage, pulses } = feedback.view(3000);
    expect(damage[0].heavy).toBe(true);
    expect(pulses[0].intensity).toBe(1);
  });

  it("连续命中的 previousHp 以上一击后的剩余生命为基准", () => {
    const feedback = new CombatFeedbackCore({ feedTtlMs: 5000 });
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 13,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 0,
    });
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 2,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 1000,
    });

    const { damage } = feedback.view(1000);
    expect(damage.map((entry) => entry.previousHp)).toEqual([24, 13]);
  });

  it("飘字在上浮时长后回收", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 13,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 0,
    });

    expect(feedback.view(DAMAGE_FEED_RISE_MS - 1).damage).toHaveLength(1);
    expect(feedback.view(DAMAGE_FEED_RISE_MS + 1).damage).toHaveLength(0);
  });
});

describe("CombatFeedbackCore 敌人血条可见性", () => {
  it("未被选中的敌人受击后显示血条，5 秒无伤后淡出", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 13,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 1000,
    });

    expect(feedback.view(1000).frames).toHaveLength(1);
    expect(feedback.view(1000 + HEALTH_BAR_LINGER_MS - 1).frames).toHaveLength(1);
    expect(feedback.view(1000 + HEALTH_BAR_LINGER_MS + 1).frames).toHaveLength(0);
  });

  it("被选中的敌人血条常显，即使很久没有受击", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 13,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 0,
    });
    feedback.setPinned("enemy:slime", true);

    const late = feedback.view(60_000);
    expect(late.frames).toHaveLength(1);
    expect(late.frames[0].pinned).toBe(true);

    feedback.setPinned("enemy:slime", false);
    expect(feedback.view(60_000).frames).toHaveLength(0);
  });

  it("血条血量跟随事件推进", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 13,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 0,
    });
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 2,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 500,
    });

    expect(feedback.view(500).frames[0]).toMatchObject({ hp: 2, maxHp: 24 });
  });

  it("治疗只更新血条，不产生飘字或脉冲", () => {
    const feedback = core();
    feedback.onHealth({ entityId: "entity:player", hp: 60, maxHp: 100, at: 0 });

    const view = feedback.view(0);
    expect(view.damage).toEqual([]);
    expect(view.pulses).toEqual([]);
    expect(view.frames).toEqual([]); // 玩家血条走 HUD，不进敌人目标圈集合
  });

  it("实体消散后清理其飘字与血条", () => {
    const feedback = core();
    feedback.onDamage({
      targetId: "enemy:slime",
      amount: 11,
      targetHp: 13,
      targetMaxHp: 24,
      heavy: false,
      incoming: false,
      at: 0,
    });
    expect(feedback.view(0).frames).toHaveLength(1);

    feedback.forget("enemy:slime");

    expect(feedback.view(0).damage).toEqual([]);
    expect(feedback.view(0).frames).toEqual([]);
  });
});
