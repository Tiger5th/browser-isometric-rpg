#!/usr/bin/env node
/**
 * L2 内容校验（content/ 数据合同）。
 *
 * 检查：
 * - 每个 JSON 文件的 schema（content/schema/*.schema.json）
 * - id 唯一 + 文件名与 id 对应
 * - 引用完整性：区域/NPC/敌人模板/敌人/物品/任务之间的交叉引用
 * - ink 对话可编译，任务标签引用的任务存在
 *
 * 用法：node tools/content/lint.mjs
 * 结果写入 reports/content-lint.json；有错误时退出码为 1。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Compiler } from "inkjs/full";

import { validateContent } from "../../src/logic/content/validate.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CONTENT_DIR = join(ROOT, "content");
const SCHEMA_DIR = join(CONTENT_DIR, "schema");
const REPORT_PATH = join(ROOT, "reports/content-lint.json");

const KIND_DIRS = [
  { kind: "region", dir: "regions" },
  { kind: "npc", dir: "npcs" },
  { kind: "enemy-template", dir: "enemy-templates" },
  { kind: "enemy", dir: "enemies" },
  { kind: "item", dir: "items" },
  { kind: "quest", dir: "quests" },
];

const SCHEMA_FILES = [
  ["common", "common.schema.json"],
  ["region", "region.schema.json"],
  ["npc", "npc.schema.json"],
  ["enemyTemplate", "enemy-template.schema.json"],
  ["enemy", "enemy.schema.json"],
  ["item", "item.schema.json"],
  ["quest", "quest.schema.json"],
];

/** ink 任务标签约定：# quest:offer:<questId> / # quest:turnin:<questId>（独占一行）。 */
const QUEST_TAG_PATTERN = /^[ \t]*#[ \t]*quest:(offer|turnin):([a-z0-9_]+:[a-z0-9_]+)[ \t]*$/gm;

async function loadSchemas() {
  const schemas = {};
  await Promise.all(
    SCHEMA_FILES.map(async ([key, name]) => {
      schemas[key] = JSON.parse(await readFile(join(SCHEMA_DIR, name), "utf8"));
    }),
  );
  return schemas;
}

async function loadContentFiles(issues) {
  const files = [];
  for (const { kind, dir } of KIND_DIRS) {
    const absoluteDir = join(CONTENT_DIR, dir);
    let names;
    try {
      names = await readdir(absoluteDir);
    } catch (error) {
      issues.push({
        code: "json",
        file: `content/${dir}`,
        path: "/",
        message: `内容目录不可读：${error.message}`,
      });
      continue;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const file = `content/${dir}/${name}`;
      try {
        files.push({
          kind,
          file,
          data: JSON.parse(await readFile(join(absoluteDir, name), "utf8")),
        });
      } catch (error) {
        issues.push({
          code: "json",
          file,
          path: "/",
          message: `JSON 解析失败：${error.message}`,
        });
      }
    }
  }
  return files;
}

async function loadDialogues(issues) {
  const absoluteDir = join(CONTENT_DIR, "dialogues");
  let names;
  try {
    names = await readdir(absoluteDir);
  } catch (error) {
    issues.push({
      code: "ink",
      file: "content/dialogues",
      path: "/",
      message: `对话目录不可读：${error.message}`,
    });
    return [];
  }

  const dialogues = [];
  for (const name of names.filter((entry) => entry.endsWith(".ink")).sort()) {
    const file = `content/dialogues/${name}`;
    const source = await readFile(join(absoluteDir, name), "utf8");
    const compiler = new Compiler(source);
    const story = compiler.Compile();
    if (story === null || compiler.errors.length > 0) {
      const errors =
        compiler.errors.length > 0 ? compiler.errors : [{ message: "未知编译错误" }];
      for (const error of errors) {
        issues.push({
          code: "ink",
          file,
          path: "/",
          message: `ink 编译失败：${error.message}`,
        });
      }
    }

    const questTags = [];
    for (const match of source.matchAll(QUEST_TAG_PATTERN)) {
      questTags.push({ kind: match[1], questId: match[2] });
    }
    dialogues.push({ id: name.slice(0, -".ink".length), file, questTags });
  }
  return dialogues;
}

const toolIssues = [];
const schemas = await loadSchemas();
const files = await loadContentFiles(toolIssues);
const dialogues = await loadDialogues(toolIssues);

const result = validateContent(files, schemas, dialogues);
const issues = [...toolIssues, ...result.issues];
const valid = issues.length === 0;

const report = {
  schemaVersion: 1,
  valid,
  counts: { files: files.length, dialogues: dialogues.length },
  issues,
};
await mkdir(join(ROOT, "reports"), { recursive: true });
await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

if (valid) {
  console.log(
    `content lint 通过：${files.length} 个内容文件、${dialogues.length} 个对话，报告 ${REPORT_PATH}`,
  );
} else {
  console.error(`content lint 失败：${issues.length} 个问题`);
  for (const issue of issues) {
    console.error(`- [${issue.code}] ${issue.file}${issue.path}：${issue.message}`);
  }
  process.exitCode = 1;
}
