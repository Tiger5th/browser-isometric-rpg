import { describe, expect, it } from "vitest";

import { createEntity, type Entity, type ItemInstance } from "./entity";
import {
  applyBuff,
  effectiveAttributes,
  equipItem,
  expireModifiers,
  grantQuestReward,
  unequipItem,
  type BuffDefinition,
  type EquipmentDefinition,
  type QuestRewardDefinition,
} from "./modifier";

function makeHero(): Entity {
  return createEntity({
    id: "entity:hero",
    type: "player",
    templateId: "hero",
    displayName: "主角",
    baseAttributes: { attack: 10, defense: 5, maxHealth: 100 },
  });
}

const sword: EquipmentDefinition = {
  templateId: "iron-sword",
  modifiers: [
    { attribute: "attack", operation: "add", value: 5 },
    { attribute: "attack", operation: "multiply", value: 0.1 },
  ],
};

const swordItem: ItemInstance = {
  instanceId: "item:sword-1",
  templateId: "iron-sword",
  quantity: 1,
  equipped: false,
};

const haste: BuffDefinition = {
  id: "haste",
  durationMs: 1000,
  modifiers: [{ attribute: "attack", operation: "multiply", value: 0.5 }],
};

const questReward: QuestRewardDefinition = {
  id: "quest:first-blood:reward",
  modifiers: [
    { attribute: "attack", operation: "add", value: 3 },
    { attribute: "maxHealth", operation: "add", value: 20 },
  ],
};

describe("装备加成", () => {
  it("装备后按 (基础+加法)×(1+百分比) 计算，卸下后恢复基础值", () => {
    const hero = makeHero();

    const equipped = equipItem(hero, swordItem, sword);
    expect(effectiveAttributes(equipped, 0).attack).toBeCloseTo(16.5);

    const unequipped = unequipItem(equipped, swordItem.instanceId);
    expect(effectiveAttributes(unequipped, 0).attack).toBeCloseTo(10);
  });

  it("多件装备独立叠加，卸下一件保留其他装备的加成", () => {
    const ring: EquipmentDefinition = {
      templateId: "power-ring",
      modifiers: [{ attribute: "attack", operation: "multiply", value: 0.1 }],
    };
    const ringItem: ItemInstance = {
      instanceId: "item:ring-1",
      templateId: "power-ring",
      quantity: 1,
      equipped: false,
    };

    const withSword = equipItem(makeHero(), swordItem, sword);
    const withBoth = equipItem(withSword, ringItem, ring);
    expect(effectiveAttributes(withBoth, 0).attack).toBeCloseTo(18);

    const withoutSword = unequipItem(withBoth, swordItem.instanceId);
    expect(effectiveAttributes(withoutSword, 0).attack).toBeCloseTo(11);
  });

  it("物品进入容器并标记为已装备，原实体不被修改", () => {
    const hero = makeHero();
    const equipped = equipItem(hero, swordItem, sword);

    expect(equipped.container.items).toEqual([{ ...swordItem, equipped: true }]);
    expect(hero.container.items).toEqual([]);
    expect(hero.modifiers).toEqual([]);
  });

  it("拒绝模板不匹配的装备", () => {
    expect(() => equipItem(makeHero(), swordItem, { templateId: "axe", modifiers: [] })).toThrow(
      "模板不匹配",
    );
  });
});

describe("限时 buff", () => {
  it("在持续时间内生效，到达到期时间后失效", () => {
    const buffed = applyBuff(makeHero(), haste, 0);

    expect(effectiveAttributes(buffed, 0).attack).toBeCloseTo(15);
    expect(effectiveAttributes(buffed, 999).attack).toBeCloseTo(15);
    expect(effectiveAttributes(buffed, 1000).attack).toBeCloseTo(10);
  });

  it("refresh 模式再次施加时重置到期时间，而不是叠加层数", () => {
    const first = applyBuff(makeHero(), haste, 0);
    const refreshed = applyBuff(first, haste, 600);

    expect(refreshed.modifiers).toHaveLength(1);
    expect(effectiveAttributes(refreshed, 1500).attack).toBeCloseTo(15);
    expect(effectiveAttributes(refreshed, 1600).attack).toBeCloseTo(10);
  });

  it("stack 模式按层叠加，并遵守 maxStacks 上限", () => {
    const stackingHaste: BuffDefinition = { ...haste, stacking: "stack", maxStacks: 2 };

    const once = applyBuff(makeHero(), stackingHaste, 0);
    const twice = applyBuff(once, stackingHaste, 400);
    const capped = applyBuff(twice, stackingHaste, 450);

    expect(effectiveAttributes(twice, 500).attack).toBeCloseTo(20);
    expect(effectiveAttributes(capped, 500).attack).toBeCloseTo(20);
    // 第一层在 t=1000 到期，只剩第二层
    expect(effectiveAttributes(capped, 1000).attack).toBeCloseTo(15);
    expect(effectiveAttributes(capped, 1400).attack).toBeCloseTo(10);
  });
});

describe("任务奖励", () => {
  it("发放永久修饰器并写入领取账本", () => {
    const rewarded = grantQuestReward(makeHero(), questReward);

    expect(rewarded.claimedRewardIds).toEqual([questReward.id]);
    expect(effectiveAttributes(rewarded, 0)).toMatchObject({ attack: 13, maxHealth: 120 });
    // 永久修饰器不随时间失效
    expect(effectiveAttributes(rewarded, Number.MAX_SAFE_INTEGER)).toMatchObject({
      attack: 13,
      maxHealth: 120,
    });
  });

  it("同一奖励重复发放不会产生额外效果", () => {
    const once = grantQuestReward(makeHero(), questReward);
    const twice = grantQuestReward(once, questReward);

    expect(twice.claimedRewardIds).toEqual([questReward.id]);
    expect(twice.modifiers).toHaveLength(2);
    expect(effectiveAttributes(twice, 0)).toMatchObject({ attack: 13, maxHealth: 120 });
  });
});

describe("统一修饰器机制", () => {
  it("装备、buff、任务奖励三类来源共同作用于同一属性", () => {
    const hero = makeHero();
    const equipped = equipItem(hero, swordItem, sword);
    const buffed = applyBuff(equipped, haste, 0);
    const rewarded = grantQuestReward(buffed, questReward);

    // (10 + 5 + 3) × (1 + 0.1 + 0.5)
    expect(effectiveAttributes(rewarded, 0).attack).toBeCloseTo(28.8);
    // 只移除装备来源（+5 加法与 +0.1 乘法），不影响 buff / 任务奖励
    const afterUnequip = unequipItem(rewarded, swordItem.instanceId);
    expect(effectiveAttributes(afterUnequip, 0).attack).toBeCloseTo(19.5);
  });

  it("JSON 序列化往返后修饰器行为保持一致", () => {
    const hero = grantQuestReward(
      applyBuff(equipItem(makeHero(), swordItem, sword), haste, 0),
      questReward,
    );
    const restored = JSON.parse(JSON.stringify(hero)) as Entity;

    expect(effectiveAttributes(restored, 0)).toEqual(effectiveAttributes(hero, 0));
    expect(effectiveAttributes(restored, 1000)).toEqual(effectiveAttributes(hero, 1000));
    expect(restored.claimedRewardIds).toEqual(hero.claimedRewardIds);
  });

  it("expireModifiers 清理到期项并保留永久项", () => {
    const hero = grantQuestReward(applyBuff(makeHero(), haste, 0), questReward);
    const cleaned = expireModifiers(hero, 1000);

    expect(cleaned.modifiers.map((modifier) => modifier.source.kind).sort()).toEqual([
      "quest",
      "quest",
    ]);
    expect(effectiveAttributes(cleaned, 1000)).toMatchObject({ attack: 13 });
  });
});
