import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type {
  ContentFileInput,
  ContentKind,
  ContentSchemas,
  DialogueInput,
} from "./types";
import { validateContent } from "./validate";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONTENT_DIR = join(ROOT, "content");

const KIND_DIRS: Array<{ kind: ContentKind; dir: string }> = [
  { kind: "region", dir: "regions" },
  { kind: "npc", dir: "npcs" },
  { kind: "enemy-template", dir: "enemy-templates" },
  { kind: "enemy", dir: "enemies" },
  { kind: "item", dir: "items" },
  { kind: "quest", dir: "quests" },
  { kind: "character-palette", dir: "character-palettes" },
  { kind: "level-curve", dir: "level-curves" },
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
    characterPalette: readJson(
      "content/schema/character-palette.schema.json",
    ) as object,
    levelCurve: readJson("content/schema/level-curve.schema.json") as object,
  };
}

function loadContentFiles(): ContentFileInput[] {
  const files: ContentFileInput[] = [];
  for (const { kind, dir } of KIND_DIRS) {
    const absoluteDir = join(CONTENT_DIR, dir);
    for (const name of readdirSync(absoluteDir).filter((entry) => entry.endsWith(".json"))) {
      files.push({
        kind,
        file: `content/${dir}/${name}`,
        data: readJson(`content/${dir}/${name}`),
      });
    }
  }
  return files;
}

function dialogueInputs(): DialogueInput[] {
  return [
    {
      id: "elder_ma",
      file: "content/dialogues/elder_ma.ink",
      questTags: [
        { kind: "offer", questId: "quest:cull_slimes" },
        { kind: "turnin", questId: "quest:cull_slimes" },
      ],
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

describe("content 数据 L2 校验", () => {
  const schemas = loadSchemas();
  const files = loadContentFiles();

  it("P1 最小内容集通过 schema 与引用完整性校验", () => {
    const result = validateContent(files, schemas, dialogueInputs());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("坏 schema 被拒绝并指出字段路径", () => {
    const broken = structuredClone(files);
    const sword = fileOf(broken, "content/items/traveler_sword.json");
    const data = sword.data as Record<string, unknown>;
    delete data.equipment;

    const coin = fileOf(broken, "content/items/old_coin.json");
    (coin.data as Record<string, unknown>).equipment = {
      slot: "weapon",
      modifiers: [{ attribute: "attack", operation: "add", value: 1 }],
    };

    const npc = fileOf(broken, "content/npcs/scout_lin.json");
    (npc.data as Record<string, unknown>).unknownField = true;

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const swordIssue = result.issues.find(
      (entry) => entry.file === sword.file && entry.code === "schema",
    );
    expect(swordIssue).toBeDefined();
    expect(swordIssue!.path).toBe("/");
    expect(swordIssue!.message).toContain("equipment");
    expect(
      result.issues.some((entry) => entry.file === coin.file && entry.code === "schema"),
    ).toBe(true);
    expect(
      result.issues.some((entry) => entry.file === npc.file && entry.code === "schema"),
    ).toBe(true);
  });

  it("坏引用被拒绝：任务指向不存在的 NPC/敌人模板/物品", () => {
    const broken = structuredClone(files);
    const quest = fileOf(broken, "content/quests/cull_slimes.json");
    const data = quest.data as {
      giverNpcId: string;
      objectives: Array<{ enemyTemplateId: string }>;
      rewards: { items: Array<{ itemId: string }> };
    };
    data.giverNpcId = "npc:missing";
    data.objectives[0].enemyTemplateId = "enemy_template:missing";
    data.rewards.items[0].itemId = "item:missing";

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const references = result.issues.filter(
      (entry) => entry.file === quest.file && entry.code === "reference",
    );
    expect(references.map((entry) => entry.path)).toEqual([
      "/giverNpcId",
      "/objectives/0/enemyTemplateId",
      "/rewards/items/0/itemId",
    ]);
  });

  it("NPC/敌人/对话的坏引用同样被拒绝", () => {
    const broken = structuredClone(files);
    const npc = fileOf(broken, "content/npcs/elder_ma.json");
    const npcData = npc.data as { dialogueId: string; regionId: string };
    npcData.dialogueId = "missing_dialogue";
    npcData.regionId = "region:missing";

    const enemy = fileOf(broken, "content/enemies/slime_meadow.json");
    (enemy.data as { templateId: string }).templateId = "enemy_template:missing";

    const result = validateContent(broken, schemas, dialogueInputs());
    const paths = result.issues
      .filter((entry) => entry.code === "reference")
      .map((entry) => `${entry.file}${entry.path}`)
      .sort();
    expect(paths).toEqual(
      [
        `content/enemies/slime_meadow.json/templateId`,
        `content/npcs/elder_ma.json/dialogueId`,
        `content/npcs/elder_ma.json/regionId`,
      ].sort(),
    );
  });

  it("重复 id、文件名与 id 不一致、坏掉落区间被拒绝", () => {
    const broken = structuredClone(files);
    const gel = fileOf(broken, "content/items/slime_gel.json");
    broken.push({ ...structuredClone(gel), file: "content/items/slime_gel_copy.json" });
    const coin = fileOf(broken, "content/items/old_coin.json");
    broken.push({ ...structuredClone(coin) });
    const template = fileOf(broken, "content/enemy-templates/slime.json");
    (template.data as { drops: Array<{ min: number; max: number }> }).drops[0].max = 0;

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "duplicate-id")).toBe(true);
    expect(result.issues.some((entry) => entry.code === "file-name")).toBe(true);
    expect(result.issues.some((entry) => entry.code === "range")).toBe(true);
  });

  it("ink 对话标签引用不存在的任务被拒绝", () => {
    const brokenDialogues = structuredClone(dialogueInputs());
    brokenDialogues[0].questTags.push({ kind: "turnin", questId: "quest:missing" });
    const badTagIndex = brokenDialogues[0].questTags.length - 1;

    const result = validateContent(files, schemas, brokenDialogues);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((entry) => entry.code === "dialogue-reference");
    expect(issue).toBeDefined();
    expect(issue!.file).toBe("content/dialogues/elder_ma.ink");
    expect(issue!.path).toBe(`/questTags/${badTagIndex}`);
  });
});

describe("content L2：aiProfile 与出生物品（票 36）", () => {
  const schemas = loadSchemas();
  const files = loadContentFiles();

  it("新敌人模板的 aiProfile 正向通过", () => {
    const result = validateContent(files, schemas, dialogueInputs());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("未知 aiProfile.kind 被拒绝", () => {
    const broken = structuredClone(files);
    const template = fileOf(broken, "content/enemy-templates/charger.json");
    (template.data as { aiProfile: Record<string, unknown> }).aiProfile = {
      kind: "teleport_chaser",
    };

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (entry) => entry.file === template.file && entry.code === "schema",
    );
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("/aiProfile/kind");
  });

  it("aiProfile 数值字段类型错与未知字段被拒绝", () => {
    const broken = structuredClone(files);
    const template = fileOf(broken, "content/enemy-templates/charger.json");
    const profile = (template.data as { aiProfile: Record<string, unknown> }).aiProfile;
    profile.windupMs = "600ms";
    profile.chargeSpeedNegative = 1;

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const paths = result.issues
      .filter((entry) => entry.file === template.file && entry.code === "schema")
      .map((entry) => entry.path);
    expect(paths).toContain("/aiProfile/windupMs");
    expect(paths).toContain("/aiProfile");
  });

  it("风车组与吐弹组各自的负数数值被拒绝", () => {
    const broken = structuredClone(files);
    const charger = fileOf(broken, "content/enemy-templates/charger.json");
    (charger.data as { aiProfile: Record<string, unknown> }).aiProfile = {
      kind: "windup-charge",
      recoveryMs: -1,
    };
    const spitter = fileOf(broken, "content/enemy-templates/spitter.json");
    (spitter.data as { aiProfile: Record<string, unknown> }).aiProfile = {
      kind: "ranged-kite",
      preferredRange: 0,
    };

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const paths = result.issues
      .filter((entry) => entry.code === "schema")
      .map((entry) => `${entry.file}${entry.path}`);
    expect(paths).toContain("content/enemy-templates/charger.json/aiProfile/recoveryMs");
    expect(paths).toContain("content/enemy-templates/spitter.json/aiProfile/preferredRange");
  });

  it("出生物品必须引用已存在的物品、数量为正整数", () => {
    const broken = structuredClone(files);
    const region = fileOf(broken, "content/regions/green_hollow.json");
    const player = (region.data as { player: Record<string, unknown> }).player;
    player.startingItems = [{ itemId: "item:missing", quantity: 1 }];

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (entry) => entry.file === region.file && entry.path === "/player/startingItems/0/itemId",
    );
    expect(issue).toBeDefined();
    expect(issue!.code).toBe("reference");
  });

  it("出生物品数量必须是正整数", () => {
    const broken = structuredClone(files);
    const region = fileOf(broken, "content/regions/green_hollow.json");
    (region.data as { player: Record<string, unknown> }).player.startingItems = [
      { itemId: "item:old_coin", quantity: 0 },
    ];

    const result = validateContent(broken, schemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (entry) => entry.file === region.file && entry.path === "/player/startingItems/0/quantity",
      ),
    ).toBe(true);
  });
});

describe("角色色板卡 L2 校验（票 29）", () => {
  const paletteSchemas = loadSchemas();
  const paletteFiles = loadContentFiles();

  it("色板卡与立绘引用进入最小内容集后整体通过", () => {
    const result = validateContent(paletteFiles, paletteSchemas, dialogueInputs());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("每个主要角色各有一张色板卡（含玩家与 NPC）", () => {
    const palettes = paletteFiles.filter((file) => file.kind === "character-palette");
    // 票 33 新增商人老陶与铁七：村庄凑齐 4 个 NPC（马婆婆/林斥候/老陶/铁七）+ 玩家。
    expect(palettes.map((file) => file.file).sort()).toEqual([
      "content/character-palettes/elder_ma.json",
      "content/character-palettes/merchant_bo.json",
      "content/character-palettes/player_hero.json",
      "content/character-palettes/scout_lin.json",
      "content/character-palettes/smith_qi.json",
    ]);
    // NPC 全部登记 paletteId，引用完整。
    const npcs = paletteFiles.filter((file) => file.kind === "npc");
    expect(npcs).toHaveLength(4);
    for (const npc of npcs) {
      expect((npc.data as { paletteId?: string }).paletteId).toBeDefined();
    }
  });

  it("颜色字段必须是 #rrggbb，中文/无 #/三位缩写都被拒绝", () => {
    for (const bad of ["#f0abf", "f0abfc", "red", "#GGGGGG"]) {
      const broken = structuredClone(paletteFiles);
      const card = fileOf(broken, "content/character-palettes/elder_ma.json");
      (card.data as { primary: string }).primary = bad;
      const result = validateContent(broken, paletteSchemas, dialogueInputs());
      expect(result.valid, `primary=${bad}`).toBe(false);
      const issue = result.issues.find(
        (entry) => entry.file === card.file && entry.code === "schema",
      );
      expect(issue, `primary=${bad}`).toBeDefined();
      expect(issue!.path).toBe("/primary");
    }
  });

  it("缺少必填关键词字段被拒绝并指出路径", () => {
    const broken = structuredClone(paletteFiles);
    const card = fileOf(broken, "content/character-palettes/scout_lin.json");
    delete (card.data as { costumeKeywords?: string }).costumeKeywords;

    const result = validateContent(broken, paletteSchemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (entry) => entry.file === card.file && entry.code === "schema",
    );
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("costumeKeywords");
  });

  it("未知字段被拒绝（additionalProperties: false）", () => {
    const broken = structuredClone(paletteFiles);
    const card = fileOf(broken, "content/character-palettes/elder_ma.json");
    (card.data as Record<string, unknown>).favoriteFood = "rice";

    const result = validateContent(broken, paletteSchemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((entry) => entry.file === card.file && entry.code === "schema"),
    ).toBe(true);
  });

  it("NPC 引用不存在的色板卡被拒绝并指出 /paletteId", () => {
    const broken = structuredClone(paletteFiles);
    const npc = fileOf(broken, "content/npcs/elder_ma.json");
    (npc.data as { paletteId: string }).paletteId = "character_palette:missing";

    const result = validateContent(broken, paletteSchemas, dialogueInputs());
    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (entry) => entry.file === npc.file && entry.code === "reference",
    );
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("/paletteId");
    expect(issue!.message).toContain("色板卡");
  });

  it("立绘引用缺少 image 字段被拒绝", () => {
    const broken = structuredClone(paletteFiles);
    const npc = fileOf(broken, "content/npcs/scout_lin.json");
    (npc.data as { portrait: unknown }).portrait = { keywords: ["scout"] };

    const result = validateContent(broken, paletteSchemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (entry) => entry.file === npc.file && entry.code === "schema" && entry.path === "/portrait",
      ),
    ).toBe(true);
  });

  it("色板卡 id 前缀与文件名必须一致", () => {
    const broken = structuredClone(paletteFiles);
    const card = fileOf(broken, "content/character-palettes/elder_ma.json");
    (card.data as { id: string }).id = "character_palette:someone_else";

    const result = validateContent(broken, paletteSchemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((entry) => entry.file === card.file && entry.code === "file-name"),
    ).toBe(true);
  });

  it("同一角色不能有两张色板卡（重复 id 被拒绝）", () => {
    const broken = structuredClone(paletteFiles);
    const card = fileOf(broken, "content/character-palettes/elder_ma.json");
    broken.push({ ...structuredClone(card), file: "content/character-palettes/elder_ma_copy.json" });

    const result = validateContent(broken, paletteSchemas, dialogueInputs());
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "duplicate-id")).toBe(true);
  });

});
