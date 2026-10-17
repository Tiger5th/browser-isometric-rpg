/**
 * 宝箱/收集品/收集集的内容合同 L2 校验（票 37）。
 *
 * 与既有 validate.test.ts 共用同一批 schema 与内容目录；这里只守票 37 新增的
 * 三类内容（正负向），不去重复别的票的用例。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ContentFileInput, ContentKind, ContentSchemas, DialogueInput } from "./types";
import { validateContent } from "./validate";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const KIND_DIRS: Array<{ kind: ContentKind; dir: string }> = [
  { kind: "region", dir: "regions" },
  { kind: "npc", dir: "npcs" },
  { kind: "enemy-template", dir: "enemy-templates" },
  { kind: "enemy", dir: "enemies" },
  { kind: "item", dir: "items" },
  { kind: "quest", dir: "quests" },
  { kind: "character-palette", dir: "character-palettes" },
  { kind: "level-curve", dir: "level-curves" },
  { kind: "chest", dir: "chests" },
  { kind: "collectible", dir: "collectibles" },
  { kind: "collect-set", dir: "collect-sets" },
];

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

function loadSchemas(): ContentSchemas {
  return {
    common: readJson("content/schema/common.schema.json") as object,
    region: readJson("content/schema/region.schema.json") as object,
    npc: readJson("content/schema/npc.schema.json") as object,
    enemyTemplate: readJson("content/schema/enemy-template.schema.json") as object,
    enemy: readJson("content/schema/enemy.schema.json") as object,
    item: readJson("content/schema/item.schema.json") as object,
    quest: readJson("content/schema/quest.schema.json") as object,
    characterPalette: readJson("content/schema/character-palette.schema.json") as object,
    levelCurve: readJson("content/schema/level-curve.schema.json") as object,
    chest: readJson("content/schema/chest.schema.json") as object,
    collectible: readJson("content/schema/collectible.schema.json") as object,
    collectSet: readJson("content/schema/collect-set.schema.json") as object,
  };
}

function loadContentFiles(): ContentFileInput[] {
  const files: ContentFileInput[] = [];
  for (const { kind, dir } of KIND_DIRS) {
    for (const name of readdirSync(join(ROOT, "content", dir)).filter((e) => e.endsWith(".json"))) {
      files.push({ kind, file: `content/${dir}/${name}`, data: readJson(`content/${dir}/${name}`) });
    }
  }
  return files;
}

function dialogueInputs(): DialogueInput[] {
  return [
    {
      id: "elder_ma",
      file: "content/dialogues/elder_ma.ink",
      questTags: [{ kind: "offer", questId: "quest:cull_slimes" }],
    },
    // 商人与铁匠的对话没有任务标签，但文件必须登记（否则 NPC 的 dialogueId 会断引用）。
    { id: "merchant_bo", file: "content/dialogues/merchant_bo.ink", questTags: [] },
    { id: "smith_qi", file: "content/dialogues/smith_qi.ink", questTags: [] },
  ];
}

function fileOf(files: ContentFileInput[], file: string): ContentFileInput {
  const found = files.find((entry) => entry.file === file);
  if (!found) {
    throw new Error(`测试数据缺少文件：${file}`);
  }
  return found;
}

describe("宝箱/收集品/收集集 L2 校验（票 37）", () => {
  const schemas = loadSchemas();
  const files = loadContentFiles();

  function issueFor(result: ReturnType<typeof validateContent>, file: string, path: string) {
    return result.issues.find((entry) => entry.file === file && entry.path === path);
  }

  it("正向：宝箱/收集品/收集集进入内容集后整体通过", () => {
    const result = validateContent(files, schemas, dialogueInputs());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(files.filter((file) => file.kind === "chest")).toHaveLength(3);
    // 萤光草 8 件 = HUD 的 0/8 计数口径（issue 要求收集计数有终点）。
    expect(files.filter((file) => file.kind === "collectible")).toHaveLength(8);
  });

  it("宝箱缺少 loot 或 loot 为空被拒绝", () => {
    const broken = structuredClone(files);
    const chest = fileOf(broken, "content/chests/hollow_stone.json");
    delete (chest.data as Record<string, unknown>).loot;

    const empty = fileOf(broken, "content/chests/market_crate.json");
    (empty.data as { loot: unknown[] }).loot = [];

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, chest.file, "/")).toBeDefined();
    expect(issueFor(result, empty.file, "/loot")).toBeDefined();
  });

  it("宝箱 loot 数量为 0 与未知字段被拒绝", () => {
    const broken = structuredClone(files);
    const chest = fileOf(broken, "content/chests/hollow_stone.json");
    (chest.data as { loot: Array<{ quantity: number }> }).loot[0].quantity = 0;
    (chest.data as Record<string, unknown>).lockedBy = "quest:cull_slimes";

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, chest.file, "/loot/0/quantity")).toBeDefined();
    expect(issueFor(result, chest.file, "/")).toBeDefined();
  });

  it("宝箱 loot 引用不存在的物品被拒绝", () => {
    const broken = structuredClone(files);
    const chest = fileOf(broken, "content/chests/pond_shore.json");
    (chest.data as { loot: Array<{ itemId: string }> }).loot[0].itemId = "item:missing";

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, chest.file, "/loot/0/itemId")?.code).toBe("reference");
  });

  it("宝箱指向不存在的区域被拒绝", () => {
    const broken = structuredClone(files);
    const chest = fileOf(broken, "content/chests/market_crate.json");
    (chest.data as { regionId: string }).regionId = "region:missing";

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, chest.file, "/regionId")?.code).toBe("reference");
  });

  it("收集品引用不存在的物品/收集集被拒绝", () => {
    const broken = structuredClone(files);
    const collectible = fileOf(broken, "content/collectibles/glow_moss_a.json");
    (collectible.data as { itemId: string }).itemId = "item:missing";
    const other = fileOf(broken, "content/collectibles/glow_moss_b.json");
    (other.data as { setId: string }).setId = "collect_set:missing";

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, collectible.file, "/itemId")?.code).toBe("reference");
    expect(issueFor(result, other.file, "/setId")?.code).toBe("reference");
  });

  it("收集品数量为 0 与 id/文件名不一致被拒绝", () => {
    const broken = structuredClone(files);
    const collectible = fileOf(broken, "content/collectibles/glow_moss_c.json");
    (collectible.data as { quantity: number }).quantity = 0;

    const renamed = fileOf(broken, "content/collectibles/glow_moss_d.json");
    (renamed.data as { id: string }).id = "collectible:glow_moss_elsewhere";

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, collectible.file, "/quantity")).toBeDefined();
    expect(issueFor(result, renamed.file, "/id")).toBeDefined();
    expect(issueFor(result, renamed.file, "/id")?.code).toBe("file-name");
  });

  it("收集品位置必须齐全（缺 position 被拒绝）", () => {
    const broken = structuredClone(files);
    const collectible = fileOf(broken, "content/collectibles/glow_moss_e.json");
    delete (collectible.data as Record<string, unknown>).position;

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, collectible.file, "/")).toBeDefined();
  });

  it("收集集奖励物品必须存在", () => {
    const broken = structuredClone(files);
    const set = fileOf(broken, "content/collect-sets/glow_moss.json");
    (set.data as { rewardItemId: string }).rewardItemId = "item:missing";

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(issueFor(result, set.file, "/rewardItemId")?.code).toBe("reference");
  });
});