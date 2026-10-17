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
    chest: "chest.schema.json",
    collectible: "collectible.schema.json",
    collectSet: "collect-set.schema.json",
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
  { kind: "chest", dir: "chests" },
  { kind: "collectible", dir: "collectibles" },
  { kind: "collect-set", dir: "collect-sets" },
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
/**
 * 对话清单：**真扫 content/dialogues/*.ink**，与 lint.mjs 的加载口同源同规则
 * （同一个 QUEST_TAG_PATTERN）。早先这里把三个对话（含 questTags）硬编码在脚本里，
 * 新增对话时 lint.mjs 看得见、负向测试看不见，两条路径会漂移。
 */
const QUEST_TAG_PATTERN = /^[ \t]*#[ \t]*quest:(offer|turnin):([a-z0-9_]+:[a-z0-9_]+)[ \t]*$/gm;

async function loadDialogues() {
  const dir = join(ROOT, "content/dialogues");
  const dialogues = [];
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".ink")).sort()) {
    const file = `content/dialogues/${name}`;
    const source = await readFile(join(dir, name), "utf8");
    const questTags = [];
    for (const match of source.matchAll(QUEST_TAG_PATTERN)) {
      questTags.push({ kind: match[1], questId: match[2] });
    }
    dialogues.push({ id: name.slice(0, -".ink".length), file, questTags });
  }
  return dialogues;
}

/** 资产存在性校验需要仓库内真实存在的文件集合（与 lint.mjs 同源）。 */
async function loadExistingAssets() {
  const paths = new Set();
  const walk = async (relativeDir) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relative);
      } else {
        paths.add(relative);
      }
    }
  };
  await walk("assets");
  return paths;
}

const dialogues = await loadDialogues();
const existingAssets = await loadExistingAssets();

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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "bad-palette-color",
    label: "色板卡 primary 不是 #rrggbb",
    expectation: "schema 错误指向 /primary",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "missing-palette-keywords",
    label: "色板卡缺少 hairKeywords",
    expectation: "schema 错误",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "npc-bad-palette-ref",
    label: "NPC paletteId 指向不存在的色板卡",
    expectation: "reference 错误指向 /paletteId",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "portrait-missing-image",
    label: "portrait 缺少 image 字段",
    expectation: "schema 错误指向 /portrait",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "region-exit-unknown-target",
    label: "区域出口指向未知区域",
    expectation: "reference 错误指向 /exits/0/targetRegionId",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "enemy-drop-unknown-item",
    label: "敌人掉落引用不存在的物品",
    expectation: "reference 错误指向 /drops/1/itemId",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "level-curve-non-monotonic",
    label: "等级曲线 xpRequired 倒退",
    expectation: "level-curve 错误指向 /levels",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "level-curve-empty-modifiers",
    label: "等级曲线 defaultModifiers 为空",
    expectation: "schema 或 level-curve 错误",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
    caught: result.issues.some((issue) => issue.file === "content/level-curves/standard.json"),
    issues: result.issues.filter((issue) => issue.file === "content/level-curves/standard.json"),
  });
}

// 7) 宝箱 loot 引用不存在的物品（票 37）。
{
  const files = clone(baseFiles);
  find(files, "content/chests/hollow_stone.json").data.loot[0].itemId = "item:missing";
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "chest-bad-loot-ref",
    label: "宝箱 loot 引用不存在的物品",
    expectation: "reference 错误指向 /loot/0/itemId",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/chests/hollow_stone.json" &&
        issue.code === "reference" &&
        issue.path === "/loot/0/itemId",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/chests/hollow_stone.json"),
  });
}

// 8) 宝箱 loot 为空数组（票 37）：开箱无意义，schema 必须挡住。
{
  const files = clone(baseFiles);
  find(files, "content/chests/market_crate.json").data.loot = [];
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "chest-empty-loot",
    label: "宝箱 loot 为空数组",
    expectation: "schema 错误指向 /loot",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/chests/market_crate.json" &&
        issue.code === "schema" &&
        issue.path === "/loot",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/chests/market_crate.json"),
  });
}

// 9) 收集品引用不存在的收集集（票 37）：全收集奖励会查不到集定义。
{
  const files = clone(baseFiles);
  find(files, "content/collectibles/glow_moss_a.json").data.setId = "collect_set:missing";
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "collectible-bad-set-ref",
    label: "收集品 setId 指向不存在的收集集",
    expectation: "reference 错误指向 /setId",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/collectibles/glow_moss_a.json" &&
        issue.code === "reference" &&
        issue.path === "/setId",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/collectibles/glow_moss_a.json"),
  });
}

// 10) 收集集奖励物品不存在（票 37）。
{
  const files = clone(baseFiles);
  find(files, "content/collect-sets/glow_moss.json").data.rewardItemId = "item:missing";
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "collect-set-bad-reward-ref",
    label: "收集集奖励物品不存在",
    expectation: "reference 错误指向 /rewardItemId",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/collect-sets/glow_moss.json" &&
        issue.code === "reference" &&
        issue.path === "/rewardItemId",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/collect-sets/glow_moss.json"),
  });
}

// 11) 商人价格表引用不存在的物品（票 33）。
// 9) 商人价格表引用不存在的物品（票 33）。
{
  const files = clone(baseFiles);
  find(files, "content/npcs/merchant_bo.json").data.vendor.sell["item:mystery_gel"] = 5;
  delete find(files, "content/npcs/merchant_bo.json").data.vendor.sell["item:slime_gel"];
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "vendor-bad-item-ref",
    label: "vendor.sell 引用不存在的物品",
    expectation: "reference 错误指向 /vendor/sell/<itemId>",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "vendor-zero-price",
    label: "vendor 价格为 0",
    expectation: "schema 错误指向 /vendor/buy",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "vendor-no-spread",
    label: "同一物品同时 sell 与 buy",
    expectation: "range 错误指向 /vendor/buy",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "patrol-single-waypoint",
    label: "巡逻路线只有一个点位",
    expectation: "schema 错误指向 /patrol/waypoints",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "patrol-anchor-mismatch",
    label: "巡逻首点与 NPC 初始位置不一致",
    expectation: "range 错误指向 /patrol/waypoints/0",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "reanchor-bad-quest-ref",
    label: "reanchors 引用不存在的任务",
    expectation: "reference 错误指向 /reanchors/0/questId",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
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
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "safe-zone-zero-extent",
    label: "安全区 halfExtents 为 0",
    expectation: "schema 错误指向 /safeZones/0/halfExtents",
    // 负例的语义：注入的坏数据**必须被 lint 抓到**才算通过。
    status: result.valid ? "failed" : "passed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/regions/green_hollow.json" &&
        issue.code === "schema" &&
        issue.path.startsWith("/safeZones/0/halfExtents"),
    ),
    issues: result.issues.filter((issue) => issue.file === "content/regions/green_hollow.json"),
  });
}

// 14) NPC 引用的立绘文件不存在（资产存在性校验）。
{
  const files = clone(baseFiles);
  const smith = find(files, "content/npcs/smith_qi.json");
  smith.data.portrait = { image: "assets/portraits/does_not_exist.png" };
  const result = validateContent(files, schemas, dialogues, { existingFiles: existingAssets });
  cases.push({
    id: "npc-missing-portrait-asset",
    label: "NPC portrait.image 指向不存在的资产文件",
    expectation: "asset 错误指向 /portrait/image",
    // 负例语义：被 lint 抓到才算通过。
    status: result.valid ? "failed" : "passed",
    caught: result.issues.some(
      (issue) =>
        issue.file === "content/npcs/smith_qi.json" &&
        issue.code === "asset" &&
        issue.path === "/portrait/image",
    ),
    issues: result.issues.filter((issue) => issue.file === "content/npcs/smith_qi.json"),
  });
}

// 15) 对照组：原始内容集必须通过（此时铁七仍引用不存在的立绘，故不适用）。
const control = validateContent(clone(baseFiles), schemas, dialogues, { existingFiles: existingAssets });

const allCaught = cases.every((entry) => entry.caught) && control.valid;
const report = {
  schemaVersion: 1,
  purpose:
    "L2 负向测试：确认色板卡/立绘引用与资产文件存在性（票 29）、等级曲线（票 34）、村庄经济（票 33：vendor/patrol/reanchors/safeZones）、区域出口/敌人掉落引用（票 35）与宝箱/收集品（票 37）的 schema、引用与结构规则会拦截坏数据",
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