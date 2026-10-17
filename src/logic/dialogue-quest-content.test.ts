import { describe, expect, it } from "vitest";

import elderMaCompiled from "../../content/dialogues/elder_ma.ink?ink";
import slimeTemplateData from "../../content/enemy-templates/slime.json";
import slimeBlueData from "../../content/enemies/slime_blue.json";
import slimeElderData from "../../content/enemies/slime_elder.json";
import slimeMeadowData from "../../content/enemies/slime_meadow.json";
import healingHerbData from "../../content/items/healing_herb.json";
import oldCoinData from "../../content/items/old_coin.json";
import slimeGelData from "../../content/items/slime_gel.json";
import travelerSwordData from "../../content/items/traveler_sword.json";
import npcElderData from "../../content/npcs/elder_ma.json";
import npcScoutData from "../../content/npcs/scout_lin.json";
import cullSlimesData from "../../content/quests/cull_slimes.json";
import regionData from "../../content/regions/green_hollow.json";

import type { ContentBundle } from "./content/types";
import { GameSession } from "./game-session";

/**
 * 真实 content/ 数据的闭环测试：示例对话、任务标签、敌人模板与奖励引用
 * 必须能在一起跑通（L2 之外的运行时验证）。`?ink` 由 Vite 插件在测试期编译。
 */
const BUNDLE = {
  regions: [regionData],
  npcs: [npcElderData, npcScoutData],
  enemyTemplates: [slimeTemplateData],
  enemies: [slimeMeadowData, slimeBlueData, slimeElderData],
  items: [healingHerbData, oldCoinData, slimeGelData, travelerSwordData],
  quests: [cullSlimesData],
} as unknown as ContentBundle;

describe("示例内容：马婆婆的清理史莱姆任务", () => {
  it("对话接取 → 击杀三只史莱姆 → 复命发奖，完整走通", () => {
    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(BUNDLE, "region:green_hollow");

    // 第一次交谈：可接状态显示两个接取分支。
    session.talkTo("npc:elder_ma");
    expect(session.snapshot().dialogue?.choices).toEqual(["发生了什么？", "我这就去。"]);
    session.chooseDialogueOption(1);
    expect(session.snapshot().quests[0].status).toBe("active");

    // 进行中交谈：只剩「还在清理」的应答，不会重复接取。
    session.talkTo("npc:elder_ma");
    expect(session.snapshot().dialogue?.choices).toEqual(["我还在清理史莱姆。"]);
    session.chooseDialogueOption(0);
    expect(session.snapshot().quests[0].status).toBe("active");

    for (const enemyId of ["enemy:slime_meadow", "enemy:slime_blue", "enemy:slime_elder"]) {
      session.emitCombatEvent({
        type: "enemy-killed",
        enemyId,
        enemyTemplateId: "enemy_template:slime",
      });
    }
    const ready = session.snapshot().quests[0];
    expect(ready.status).toBe("ready_to_turn_in");
    expect(ready.objectives[0].current).toBe(3);

    // 可交状态：对话只显示复命分支。
    session.talkTo("npc:elder_ma");
    expect(session.snapshot().dialogue?.choices).toEqual([
      "（复命）史莱姆已经清理完了。",
    ]);
    session.chooseDialogueOption(0);

    const snapshot = session.snapshot();
    expect(snapshot.quests[0].status).toBe("completed");
    const player = snapshot.entities.find((entity) => entity.identity.type === "player");
    expect(player).toBeDefined();
    expect(
      player!.container.items.map((item) => [item.templateId, item.quantity]),
    ).toEqual([
      ["item:traveler_sword", 1],
      ["item:healing_herb", 2],
    ]);
    expect(player!.attributes.maxHp).toBe(110);
    expect(player!.modifiers).toEqual([
      expect.objectContaining({
        attribute: "maxHp",
        operation: "add",
        value: 10,
        source: { kind: "quest", id: "quest:cull_slimes" },
      }),
    ]);
  });

  it("会话内战斗击杀自动推进任务进度（票 21 合流后的真实路径）", () => {
    const session = new GameSession();
    session.registerDialogue("elder_ma", elderMaCompiled);
    session.loadRegion(BUNDLE, "region:green_hollow");
    session.talkTo("npc:elder_ma");
    session.chooseDialogueOption(1);
    expect(session.snapshot().quests[0].status).toBe("active");

    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));

    session.attack("entity:player", "enemy:slime_meadow");
    let objective = session.snapshot().quests[0].objectives[0];
    for (let index = 0; index < 20 && objective.current === 0; index += 1) {
      session.advance(1000);
      objective = session.snapshot().quests[0].objectives[0];
    }

    expect(objective.current).toBe(1);
    expect(events.filter((type) => type === "enemy-killed")).toHaveLength(1);
    expect(
      session.drainEvents().some(
        (event) => event.type === "death" && event.kind === "enemy",
      ),
    ).toBe(true);
  });
});
