#!/usr/bin/env node
/**
 * L2 内容校验负向自测（票 29）：构造坏角色色板卡 / 坏立绘引用，
 * 确认 schema 与引用完整性规则会拦截。
 * 输出：reports/content-lint-negative-test.json
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { validateContent } from "../../src/logic/content/validate.ts";

const ROOT = resolve(import.meta.dirname, "../..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(ROOT, relativePath), "utf8"));
}

async function loadSchemas() {
  const names = {
    common: "common.schema.json",
    region: "region.schema.json",
    npc: "npc.schema.json",
    enemyTemplate: "enemy-template.schema.json",
    enemy: "enemy.schema.json",
    item: "item.schema.json",
    quest: "quest.schema.json",
    characterPalette: "character-palette.schema.json",
    levelCurve: "level-curve.schema.json",
  };
  const schemas = {};
  for (const [key, name] of Object.entries(names)) {
    schemas[key] = await readJson(`content/schema/${name}`);
  }
  return schemas;
}

const KIND_DIRS = [
  { kind: "region", dir: "regions" },
  { kind: "npc", dir: "npcs" },
  { kind: "enemy-template", dir: "enemy-templates" },
  { kind: "enemy", dir: "enemies" },
  { kind: "item", dir: "items" },
  { kind: "quest", dir: "quests" },
  { kind: "character-palette", dir: "character-palettes" },
  { kind: "level-curve", dir: "level-curves" },
];

async function loadFiles() {
  const files = [];
  for (const { kind, dir } of KIND_DIRS) {
    for (const name of (await readdir(join(ROOT, `content/${dir}`)))
      .filter((entry) => entry.endsWith(".json"))
      .sort()) {
      files.push({ kind, file: `content/${dir}/${name}`, data: await readJson(`content/${dir}/${name}`) });
    }
  }
  return files;
}

const schemas = await loadSchemas();
const baseFiles = await loadFiles();
const dialogues = [
  {
    id: "elder_ma",
    file: "content/dialogues/elder_ma.ink",
    questTags: [
      { kind: "offer", questId: "quest:cull_slimes" },
      { kind: "turnin", questId: "quest:cull_slimes" },
      { kind: "offer", questId: "quest:den_cull" },
      { kind: "turnin", questId: "quest:den_cull" },
    ],
  },
  { id: "merchant_bo", file: "content/dialogues/merchant_bo.ink", questTags: [] },
  { id: "smith_qi", file: "content/dialogues/smith_qi.ink", questTags: [] },
];

function clone(files) {
  return structuredClone(files);
}

function find(files, file) {
  const found = files.find((entry) => entry.file === file);
  if (!found) {
    throw new Error(`测试数据缺少文件：${file}`);
  }
  return found;
}

const cases = [];

// 1) 色板卡主色不是 #rrggbb。
{
  const files = clone(baseFiles);
  find(files, "content/character-palettes/elder_ma.json").data.primary = "red";
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "bad-palette-color",
    label: "色板卡 primary 不是 #rrggbb",
    expectation: "schema 错误指向 /primary",
    status: result.valid ? "passed" : "failed",
    issues: result.issues.filter((issue) => issue.file === "content/character-palettes/elder_ma.json"),
    caught: result.issues.some(
      (issue) => issue.file === "content/character-palettes/elder_ma.json" && issue.path === "/primary" && issue.code === "schema",
    ),
  });
}

// 2) 色板卡缺少发色关键词。
{
  const files = clone(baseFiles);
  delete find(files, "content/character-palettes/scout_lin.json").data.hairKeywords;
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "missing-palette-keywords",
    label: "色板卡缺少 hairKeywords",
    expectation: "schema 错误",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) => issue.file === "content/character-palettes/scout_lin.json" && issue.code === "schema",
    ),
    issues: result.issues,
  });
}

// 3) NPC 引用不存在的色板卡。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/elder_ma.json").data.paletteId = "character_palette:missing";
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "npc-bad-palette-ref",
    label: "NPC paletteId 指向不存在的色板卡",
    expectation: "reference 错误指向 /paletteId",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/elder_ma.json" &&
        issue.code === "reference" &&
        issue.path === "/paletteId",
    ),
    issues: result.issues,
  });
}

// 4) 立绘引用缺少 image。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/scout_lin.json").data.portrait = { keywords: ["scout"] };
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "portrait-missing-image",
    label: "portrait 缺少 image 字段",
    expectation: "schema 错误指向 /portrait",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/scout_lin.json" &&
        issue.code === "schema" &&
        issue.path === "/portrait",
    ),
    issues: result.issues,
  });
}

// 5) 票 35：区域出口指向不存在的目标区域 → 引用完整性报错。
{
  const files = clone(baseFiles);
  find(files, "content/regions/slime_den.json").data.exits[0].targetRegionId = "region:nowhere";
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "region-exit-unknown-target",
    label: "区域出口指向未知区域",
    expectation: "reference 错误指向 /exits/0/targetRegionId",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/regions/slime_den.json" &&
        issue.code === "reference" &&
        issue.path === "/exits/0/targetRegionId",
    ),
    issues: result.issues,
  });
}

// 6) 票 35：区域 2 专属掉落物引用不存在的物品 → 引用完整性报错。
{
  const files = clone(baseFiles);
  find(files, "content/enemy-templates/slime_den.json").data.drops[1].itemId = "item:ghost_core";
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "enemy-drop-unknown-item",
    label: "敌人掉落引用不存在的物品",
    expectation: "reference 错误指向 /drops/1/itemId",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/enemy-templates/slime_den.json" &&
        issue.code === "reference" &&
        issue.path === "/drops/1/itemId",
    ),
    issues: result.issues,
  });
}

// 7) 等级曲线阈值倒退（票 34）：schema 表达不了区间关系，必须由结构校验拦截。
{
  const files = clone(baseFiles);
  const data = find(files, "content/level-curves/standard.json").data;
  data.levels[2].xpRequired = 10;
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "level-curve-non-monotonic",
    label: "等级曲线 xpRequired 倒退",
    expectation: "level-curve 错误指向 /levels",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) => issue.file === "content/level-curves/standard.json" && issue.code === "level-curve",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/level-curves/standard.json"),
  });
}

// 8) 等级曲线缺省加成为空：升级将没有任何属性变化。
{
  const files = clone(baseFiles);
  find(files, "content/level-curves/standard.json").data.defaultModifiers = [];
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "level-curve-empty-modifiers",
    label: "等级曲线 defaultModifiers 为空",
    expectation: "schema 或 level-curve 错误",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some((issue) => issue.file === "content/level-curves/standard.json"),
    issues: result.issues.filter((issue) => issue.file === "content/level-curves/standard.json"),
  });
}

// 9) 商人价格表引用不存在的物品（票 33）。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/merchant_bo.json").data.vendor.sell["item:mystery_gel"] = 5;
  delete find(files, "content/npcs/merchant_bo.json").data.vendor.sell["item:slime_gel"];
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "vendor-bad-item-ref",
    label: "vendor.sell 引用不存在的物品",
    expectation: "reference 错误指向 /vendor/sell/<itemId>",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/merchant_bo.json" &&
        issue.code === "reference" &&
        issue.path === "/vendor/sell/item:mystery_gel",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/npcs/merchant_bo.json"),
  });
}

// 8) 商人价格非正整数（0 价会让交易面板出现免费/零收益的死行）。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/merchant_bo.json").data.vendor.buy["item:healing_herb"] = 0;
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "vendor-zero-price",
    label: "vendor 价格为 0",
    expectation: "schema 错误指向 /vendor/buy",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/merchant_bo.json" &&
        issue.code === "schema" &&
        issue.path.startsWith("/vendor"),
    ),
    issues: result.issues.filter((issue) => issue.file === "content/npcs/merchant_bo.json"),
  });
}

// 9) 同一物品同时出现在 sell 与 buy（没有利差，面板出现空转行）。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/merchant_bo.json").data.vendor.sell["item:healing_herb"] = 3;
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "vendor-no-spread",
    label: "同一物品同时 sell 与 buy",
    expectation: "range 错误指向 /vendor/buy",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/merchant_bo.json" &&
        issue.code === "range" &&
        issue.path === "/vendor/buy/item:healing_herb",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/npcs/merchant_bo.json"),
  });
}

// 10) 巡逻路线只有一个点位（schema 层就应拦下：巡逻至少要有来有回）。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/scout_lin.json").data.patrol.waypoints = [
    { x: -6, y: 0, z: 3 },
  ];
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "patrol-single-waypoint",
    label: "巡逻路线只有一个点位",
    expectation: "schema 错误指向 /patrol/waypoints",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/scout_lin.json" &&
        issue.code === "schema" &&
        issue.path.startsWith("/patrol/waypoints"),
    ),
    issues: result.issues.filter((issue) => issue.file === "content/npcs/scout_lin.json"),
  });
}

// 11) 巡逻首点不等于 NPC 初始位置（开局/读档会瞬移）。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/scout_lin.json").data.patrol.waypoints[0] = { x: 5, y: 0, z: 5 };
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "patrol-anchor-mismatch",
    label: "巡逻首点与 NPC 初始位置不一致",
    expectation: "range 错误指向 /patrol/waypoints/0",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/scout_lin.json" &&
        issue.code === "range" &&
        issue.path === "/patrol/waypoints/0",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/npcs/scout_lin.json"),
  });
}

// 12) 换锚点引用不存在的任务。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/elder_ma.json").data.reanchors[0].questId = "quest:missing";
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "reanchor-bad-quest-ref",
    label: "reanchors 引用不存在的任务",
    expectation: "reference 错误指向 /reanchors/0/questId",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/elder_ma.json" &&
        issue.code === "reference" &&
        issue.path === "/reanchors/0/questId",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/npcs/elder_ma.json"),
  });
}

// 13) 安全区半长宽为 0（等于没有安全区却不声明）。
{
  const files = clone(baseFiles);
  find(files, "content/regions/green_hollow.json").data.safeZones[0].halfExtents.x = 0;
  const result = validateContent(files, schemas, dialogues);
  cases.push({
    id: "safe-zone-zero-extent",
    label: "安全区 halfExtents 为 0",
    expectation: "schema 错误指向 /safeZones/0/halfExtents",
    status: result.valid ? "passed" : "failed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/regions/green_hollow.json" &&
        issue.code === "schema" &&
        issue.path.startsWith("/safeZones/0/halfExtents"),
    ),
    issues: result.issues.filter((issue) => issue.file === "content/regions/green_hollow.json"),
  });
}

// 15) 对照组：原始内容集必须通过。
const control = validateContent(clone(baseFiles), schemas, dialogues);

const allCaught = cases.every((entry) => entry.caught) && control.valid;
const report = {
  schemaVersion: 1,
  purpose:
    "L2 负向测试：确认色板卡/立绘（票 29）、等级曲线（票 34）、村庄经济（票 33）与区域出口/敌人掉落引用（票 35）的 schema、引用与结构规则会拦截坏数据",
  exitExpectation: "failed",
  status: allCaught ? "passed" : "failed",
  control: { valid: control.valid, issues: control.issues },
  cases,
};
await mkdir(join(ROOT, "reports"), { recursive: true });
await writeFile(
  join(ROOT, "reports/content-lint-negative-test.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      status: report.status,
      controlValid: control.valid,
      cases: cases.map((entry) => ({ id: entry.id, caught: entry.caught })),
    },
    null,
    2,
  ),
);
if (!allCaught) {
  process.exitCode = 1;
}
