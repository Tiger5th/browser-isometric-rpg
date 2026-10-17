import { describe, expect, it } from "vitest";

import { GameSession, type IntentResult } from "./game-session";
import { findTriggeredExit } from "./region-linkage";
import {
  GREEN_HOLLOW_REGION_ID,
  SLIME_DEN_REGION_ID,
  SAMPLE_CONTENT_BUNDLE as BUNDLE,
} from "./content/sample-content";
import elderMaCompiled from "../../content/dialogues/elder_ma.ink?ink";

/** 内容包里的出口位置：翠谷南缘洞口 (0,19)，巢穴北缘洞口 (0,-11)。 */
const CAVE_MOUTH = { x: 0, y: 0, z: 19 };
const DEN_MOUTH = { x: 0, y: 0, z: -11 };

function hollowExits() {
  const region = BUNDLE.regions.find((entry) => entry.id === GREEN_HOLLOW_REGION_ID);
  if (region?.exits === undefined) {
    throw new Error("翠谷缺少 exits");
  }
  return region.exits;
}

function sessionInHollow(): GameSession {
  const session = new GameSession();
  session.registerDialogue("elder_ma", elderMaCompiled);
  session.loadRegion(BUNDLE, GREEN_HOLLOW_REGION_ID);
  return session;
}

/** 接取巢穴任务（等价于在马婆婆对话里选「南边那个洞口是什么地方？」再确认）。 */
function acceptDenCull(session: GameSession): void {
  session.talkTo("npc:elder_ma");
  const choices = session.snapshot().dialogue?.choices ?? [];
  session.chooseDialogueOption(choices.indexOf("南边那个洞口是什么地方？"));
  const offerChoices = session.snapshot().dialogue?.choices ?? [];
  if (offerChoices.length > 0) {
    session.chooseDialogueOption(0);
  }
}

/** 会话内战斗打死一只敌人（走真实伤害结算，因此掉落/经验都生效）。 */
function killEnemy(session: GameSession, enemyId: string): void {
  for (let index = 0; index < 40; index += 1) {
    const alive = session
      .snapshot()
      .entities.find((entity) => entity.id === enemyId)?.combat.alive;
    if (alive !== true) {
      return;
    }
    session.tryAttack("entity:player", enemyId);
    session.advance(1000);
  }
}

describe("区域联动（票 35）：路口触发区域切换", () => {
  it("玩家不在任何路口时拒绝切换，会话留在原区域", () => {
    const session = sessionInHollow();
    expect(findTriggeredExit(hollowExits(), { x: 0, z: 0 })).toBeNull();

    const result: IntentResult = session.tryTravelToRegion(BUNDLE, { x: 0, y: 0, z: 0 });
    expect(result.ok).toBe(false);
    expect(session.currentRegionId).toBe(GREEN_HOLLOW_REGION_ID);
  });

  it("走到翠谷南缘洞口即进入史莱姆巢穴，落在巢穴出生点", () => {
    const session = sessionInHollow();

    expect(session.tryTravelToRegion(BUNDLE, CAVE_MOUTH).ok).toBe(true);
    expect(session.currentRegionId).toBe(SLIME_DEN_REGION_ID);

    const player = session.snapshot().entities.find((entity) => entity.id === "entity:player");
    expect(player?.position).toEqual({ x: 0, y: 0, z: -6 });
  });

  it("切换后只存在目标区域的实体：巢穴里没有翠谷的 NPC", () => {
    const session = sessionInHollow();
    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);

    // 巢穴 = 3 只巢穴史莱姆 + 票 36 的两种新敌人（混编，见 spec「区域 2 敌人配置」）。
    const ids = session.snapshot().entities.map((entity) => entity.id).sort();
    expect(ids).toEqual([
      "enemy:den_charger",
      "enemy:den_spitter",
      "enemy:slime_den_brood",
      "enemy:slime_den_core",
      "enemy:slime_den_watcher",
      "entity:player",
    ]);
  });

  it("区域 2 混编了票 36 的两种新敌人 + 史莱姆（spec 约定）", () => {
    const session = sessionInHollow();
    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);

    const templates = session
      .snapshot()
      .entities.filter((entity) => entity.identity.type === "enemy")
      .map((entity) => entity.identity.templateId)
      .sort();
    expect(templates).toEqual([
      "enemy_template:charger",
      "enemy_template:slime_den",
      "enemy_template:slime_den",
      "enemy_template:slime_den",
      "enemy_template:spitter",
    ]);
  });

  it("往返双向：走回巢穴北缘洞口又回到翠谷，且 NPC 回来", () => {
    const session = sessionInHollow();
    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);
    expect(session.currentRegionId).toBe(SLIME_DEN_REGION_ID);

    expect(session.tryTravelToRegion(BUNDLE, DEN_MOUTH).ok).toBe(true);
    expect(session.currentRegionId).toBe(GREEN_HOLLOW_REGION_ID);

    const ids = session.snapshot().entities.map((entity) => entity.id).sort();
    expect(ids).toEqual([
      "enemy:charger_meadow",
      "enemy:slime_blue",
      "enemy:slime_elder",
      "enemy:slime_meadow",
      "enemy:spitter_pond",
      "entity:player",
      "npc:elder_ma",
      "npc:merchant_bo",
      "npc:scout_lin",
      "npc:smith_qi",
    ]);
  });

  it("切换广播 region-changed，带上来源出口与目标区域", () => {
    const session = sessionInHollow();
    const seen: string[] = [];
    session.subscribe((event) => {
      if (event.type === "region-changed") {
        seen.push(`${event.fromRegionId}->${event.toRegionId}@${event.exitId}`);
      }
    });

    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);
    session.tryTravelToRegion(BUNDLE, DEN_MOUTH);

    expect(seen).toEqual([
      "region:green_hollow->region:slime_den@exit:cave_mouth",
      "region:slime_den->region:green_hollow@exit:den_to_hollow",
    ]);
  });

  it("跨区域任务：翠谷接取 → 巢穴击杀累计进度 → 回翠谷交付完成", () => {
    const session = sessionInHollow();
    acceptDenCull(session);
    expect(
      session.snapshot().quests.find((quest) => quest.id === "quest:den_cull")?.status,
    ).toBe("active");

    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);

    // 目标只存在于巢穴：前两只凑够进度，但不足 3 只，仍不能交付。
    for (const enemyId of ["enemy:slime_den_watcher", "enemy:slime_den_brood"]) {
      session.emitCombatEvent({
        type: "enemy-killed",
        enemyId,
        enemyTemplateId: "enemy_template:slime_den",
      });
    }
    let quest = session.snapshot().quests.find((entry) => entry.id === "quest:den_cull");
    expect(quest?.objectives[0].current).toBe(2);
    expect(quest?.status).toBe("active");

    session.emitCombatEvent({
      type: "enemy-killed",
      enemyId: "enemy:slime_den_core",
      enemyTemplateId: "enemy_template:slime_den",
    });
    quest = session.snapshot().quests.find((entry) => entry.id === "quest:den_cull");
    expect(quest?.objectives[0].current).toBe(3);
    expect(quest?.status).toBe("ready_to_turn_in");

    // 交付必须回到 NPC 所在的区域 1。
    session.tryTravelToRegion(BUNDLE, DEN_MOUTH);
    session.talkTo("npc:elder_ma");
    const choices = session.snapshot().dialogue?.choices ?? [];
    expect(choices).toContain("（复命）巢穴里的史莱姆已经清干净了。");
    session.chooseDialogueOption(
      choices.indexOf("（复命）巢穴里的史莱姆已经清干净了。"),
    );

    const snapshot = session.snapshot();
    expect(
      snapshot.quests.find((entry) => entry.id === "quest:den_cull")?.status,
    ).toBe("completed");
    const player = snapshot.entities.find((entity) => entity.id === "entity:player");
    expect(
      player?.container.items.map((item) => [item.templateId, item.quantity]),
    ).toEqual([
      // 起始金币（票 36 死亡轻惩罚）在最前。
      ["item:old_coin", 25],
      ["item:healing_herb", 3],
      ["item:old_coin", 20],
    ]);
  });

  it("切区保留玩家背包（跨区域累计的战利品不丢）", () => {
    const session = sessionInHollow();
    acceptDenCull(session);
    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);
    // 会话内战斗的击杀奖励（凝胶/巢穴核心）留在背包里。
    killEnemy(session, "enemy:slime_den_core");
    const gel = session.snapshot().entities
      .find((entity) => entity.id === "entity:player")
      ?.container.items.find((item) => item.templateId === "item:slime_gel");
    expect(gel?.quantity).toBeGreaterThan(0);

    session.tryTravelToRegion(BUNDLE, DEN_MOUTH);

    const kept = session.snapshot().entities
      .find((entity) => entity.id === "entity:player")
      ?.container.items.find((item) => item.templateId === "item:slime_gel");
    expect(kept?.quantity).toBe(gel?.quantity);
  });

  it("enterRegion 不经路口直接进入目标区域（读档路径）", () => {
    const session = sessionInHollow();
    session.enterRegion(BUNDLE, SLIME_DEN_REGION_ID);

    expect(session.currentRegionId).toBe(SLIME_DEN_REGION_ID);
    const player = session.snapshot().entities.find((entity) => entity.id === "entity:player");
    expect(player?.position).toEqual({ x: 0, y: 0, z: -6 });
  });

  it("enterRegion 保留任务进度，回翠谷后可直接交付", () => {
    const session = sessionInHollow();
    acceptDenCull(session);
    session.enterRegion(BUNDLE, SLIME_DEN_REGION_ID);
    for (const enemyId of ["enemy:slime_den_watcher", "enemy:slime_den_brood", "enemy:slime_den_core"]) {
      session.emitCombatEvent({
        type: "enemy-killed",
        enemyId,
        enemyTemplateId: "enemy_template:slime_den",
      });
    }
    session.enterRegion(BUNDLE, GREEN_HOLLOW_REGION_ID);

    expect(
      session.snapshot().quests.find((quest) => quest.id === "quest:den_cull")?.status,
    ).toBe("ready_to_turn_in");
  });

  it("enterRegion 广播 region-changed，读档方能感知区域变化", () => {
    const session = sessionInHollow();
    const seen: string[] = [];
    session.subscribe((event) => {
      if (event.type === "region-changed") {
        seen.push(`${event.fromRegionId}->${event.toRegionId}`);
      }
    });

    session.enterRegion(BUNDLE, SLIME_DEN_REGION_ID);
    // 已经在这个区域时不再重复广播。
    session.enterRegion(BUNDLE, SLIME_DEN_REGION_ID);

    expect(seen).toEqual(["region:green_hollow->region:slime_den"]);
  });

  it("enterRegion 到未知区域时 try* 版本返回 ok=false", () => {
    const session = sessionInHollow();
    const result = session.tryEnterRegion(BUNDLE, "region:nowhere");
    expect(result.ok).toBe(false);
    expect(session.currentRegionId).toBe(GREEN_HOLLOW_REGION_ID);
  });

  it("出口指向未知区域时显式报错，会话保持在原区域", () => {
    const session = sessionInHollow();
    const broken = {
      ...BUNDLE,
      regions: BUNDLE.regions.map((region) =>
        region.id === GREEN_HOLLOW_REGION_ID
          ? {
              ...region,
              exits: [
                {
                  id: "exit:void",
                  targetRegionId: "region:nowhere",
                  position: { x: 0, y: 0, z: 19 },
                },
              ],
            }
          : region,
      ),
    };

    const result = session.tryTravelToRegion(broken, CAVE_MOUTH);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nowhere/);
    expect(session.currentRegionId).toBe(GREEN_HOLLOW_REGION_ID);
  });

  it("切区前的移动意图被取消，玩家不会一路走进新区域", () => {
    const session = sessionInHollow();
    session.moveTo("entity:player", { x: 0, y: 0, z: 19 });
    const moving = session
      .snapshot()
      .entities.find((entity) => entity.id === "entity:player");
    expect(moving?.movement).not.toBeNull();

    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);

    expect(
      session.snapshot().entities.find((entity) => entity.id === "entity:player")?.movement,
    ).toBeNull();
  });

  it("切区后进行中的对话被结束，避免残留指向已卸载 NPC 的对话", () => {
    const session = sessionInHollow();
    session.talkTo("npc:elder_ma");
    expect(session.snapshot().dialogue).not.toBeNull();

    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);

    expect(session.snapshot().dialogue).toBeNull();
  });

  it("区域 2 专属掉落物只在巢穴产出：巢穴核心不出自翠谷史莱姆", () => {
    const session = sessionInHollow();
    acceptDenCull(session);
    for (const enemyId of ["enemy:slime_meadow", "enemy:slime_blue", "enemy:slime_elder"]) {
      killEnemy(session, enemyId);
    }
    const items = session.snapshot().entities
      .find((entity) => entity.id === "entity:player")
      ?.container.items.map((item) => item.templateId);
    expect(items).toContain("item:slime_gel");
    expect(items).not.toContain("item:slime_core");
  });

  it("区域 2 专属掉落物进了商人收购价目表（供票 33 交易闭环）", () => {
    // 老陶（票 33 的商人）收 slime_core：区域 2 掉的东西在区域 1 卖得掉，
    // 这是「探索新地图有独特回报」闭环的最后一环。
    const merchant = BUNDLE.npcs.find((npc) => npc.id === "npc:merchant_bo");
    const sell = (merchant?.vendor as { sell?: Record<string, number> } | undefined)?.sell;
    expect(sell?.["item:slime_core"]).toBeGreaterThan(0);
    // 凝胶（区域 1 的掉落）同样在价目表里，两者价格不同以体现稀缺度。
    expect(sell?.["item:slime_gel"]).toBeGreaterThan(0);
    expect(sell?.["item:slime_core"]).toBeGreaterThan(sell?.["item:slime_gel"] ?? 0);
  });

  it("巢穴专属掉落物：巢穴史莱姆有机会掉落巢穴核心（供票 33 商人收购）", () => {
    // 掉落是概率事件，用固定随机源让 chance 判定确定性地命中。
    // 每件掉落消耗两个随机数：先判 chance（0.1 < 0.45 命中），再取数量。
    let step = 0;
    const random = (): number => {
      step += 1;
      return step % 2 === 1 ? 0.1 : 0;
    };
    const session = new GameSession({ random });
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(BUNDLE, GREEN_HOLLOW_REGION_ID);
    acceptDenCull(session);
    session.tryTravelToRegion(BUNDLE, CAVE_MOUTH);

    killEnemy(session, "enemy:slime_den_watcher");

    const items = session.snapshot().entities
      .find((entity) => entity.id === "entity:player")
      ?.container.items.map((item) => item.templateId);
    expect(items).toContain("item:slime_core");
  });
});