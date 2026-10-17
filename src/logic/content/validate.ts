/**
 * content/ 数据 L2 校验：JSON schema + 引用完整性。
 *
 * 纯逻辑（仅依赖 ajv），可被 vitest 直接测试；文件扫描与 ink 编译由
 * tools/content/lint.mjs 负责。schema 是 P2 Agent 内容生产的合同，
 * 本模块只做机械校验，不解释业务规则。
 *
 * 注意：lint 脚本用 Node 的类型剥离直接 import 本文件。请保持
 * erasable-only 语法（不要使用 enum / namespace / 参数属性）。
 */

import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

import { validateLevelCurve } from "../leveling.ts";
import type {
  ContentFileInput,
  ContentIssue,
  ContentKind,
  ContentSchemas,
  ContentValidationResult,
  DialogueInput,
} from "./types";

const KIND_SCHEMA_KEY: Record<ContentKind, Exclude<keyof ContentSchemas, "common">> = {
  region: "region",
  npc: "npc",
  "enemy-template": "enemyTemplate",
  enemy: "enemy",
  item: "item",
  quest: "quest",
  "character-palette": "characterPalette",
  "level-curve": "levelCurve",
};

/** id 前缀必须与文件所在目录对应（enemy-template 目录对应 enemy_template: 前缀）。 */
const KIND_ID_PREFIX: Record<ContentKind, string> = {
  region: "region:",
  npc: "npc:",
  "enemy-template": "enemy_template:",
  enemy: "enemy:",
  item: "item:",
  quest: "quest:",
  "character-palette": "character_palette:",
  "level-curve": "level_curve:",
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pointer(...segments: Array<string | number>): string {
  return `/${segments.join("/")}`;
}

function emptySets(): Record<ContentKind, Set<string>> {
  return {
    region: new Set(),
    npc: new Set(),
    "enemy-template": new Set(),
    enemy: new Set(),
    item: new Set(),
    quest: new Set(),
    "character-palette": new Set(),
    "level-curve": new Set(),
  };
}

function checkFileName(file: ContentFileInput, issues: ContentIssue[]): void {
  if (!isRecord(file.data) || typeof file.data.id !== "string") {
    return;
  }
  const id = file.data.id;
  const prefix = KIND_ID_PREFIX[file.kind];
  if (!id.startsWith(prefix)) {
    return; // 前缀错误已由 schema 报告。
  }
  const expected = `${id.slice(prefix.length)}.json`;
  const actual = file.file.split("/").pop() ?? file.file;
  if (actual !== expected) {
    issues.push({
      code: "file-name",
      file: file.file,
      path: "/id",
      message: `文件名应为 ${expected}（与 id ${id} 对应）`,
    });
  }
}

/**
 * 校验一组内容文件。
 *
 * @param files     内容 JSON（kind 由所在目录决定）
 * @param schemas   content/schema/*.schema.json 的解析结果
 * @param dialogues 工具链从 .ink 文件提取的对话元数据（用于对话引用校验）
 */
export function validateContent(
  files: readonly ContentFileInput[],
  schemas: ContentSchemas,
  dialogues: readonly DialogueInput[] = [],
): ContentValidationResult {
  const issues: ContentIssue[] = [];
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schemas.common);

  const validators = new Map<string, ValidateFunction>();
  const scanned: Array<{ file: ContentFileInput; valid: boolean }> = [];

  for (const file of files) {
    const key = KIND_SCHEMA_KEY[file.kind];
    if (key === undefined) {
      issues.push({
        code: "schema",
        file: file.file,
        path: "/",
        message: `未知内容类别：${String(file.kind)}`,
      });
      continue;
    }
    let validate = validators.get(key);
    if (validate === undefined) {
      validate = ajv.compile(schemas[key]);
      validators.set(key, validate);
    }
    const valid = validate(file.data) === true;
    if (!valid) {
      for (const error of validate.errors ?? []) {
        issues.push({
          code: "schema",
          file: file.file,
          path: error.instancePath === "" ? "/" : error.instancePath,
          message: error.message ?? "schema 校验失败",
        });
      }
    }
    scanned.push({ file, valid });
  }

  for (const file of files) {
    checkFileName(file, issues);
  }

  // 收集有效文件的 id：重复检测 + 各类引用的目标集合。
  const ids = new Map<string, ContentFileInput>();
  const idSets = emptySets();
  const npcRecords = new Map<string, JsonRecord>();
  for (const { file, valid } of scanned) {
    if (!valid || !isRecord(file.data) || typeof file.data.id !== "string") {
      continue;
    }
    const id = file.data.id;
    const previous = ids.get(id);
    if (previous !== undefined) {
      issues.push({
        code: "duplicate-id",
        file: file.file,
        path: "/id",
        message: `重复的内容 id：${id}（另一处：${previous.file}）`,
      });
    } else {
      ids.set(id, file);
    }
    idSets[file.kind].add(id);
    if (file.kind === "npc") {
      npcRecords.set(id, file.data);
    }
  }

  const dialogueIds = new Set(dialogues.map((dialogue) => dialogue.id));

  const requireReference = (
    file: ContentFileInput,
    path: string,
    value: unknown,
    known: ReadonlySet<string>,
    label: string,
  ): void => {
    if (typeof value !== "string" || known.has(value)) {
      return;
    }
    issues.push({
      code: "reference",
      file: file.file,
      path,
      message: `${label}不存在：${value}`,
    });
  };

  for (const { file, valid } of scanned) {
    if (!valid || !isRecord(file.data)) {
      continue;
    }
    const data = file.data;
    switch (file.kind) {
      case "region": {
        asArray(data.exits).forEach((exit, index) => {
          if (!isRecord(exit)) {
            return;
          }
          requireReference(
            file,
            pointer("exits", index, "targetRegionId"),
            exit.targetRegionId,
            idSets.region,
            "目标区域",
          );
        });
        break;
      }
      case "npc": {
        requireReference(file, "/regionId", data.regionId, idSets.region, "区域");
        requireReference(
          file,
          "/paletteId",
          data.paletteId,
          idSets["character-palette"],
          "色板卡",
        );
        if (typeof data.dialogueId === "string" && !dialogueIds.has(data.dialogueId)) {
          issues.push({
            code: "reference",
            file: file.file,
            path: "/dialogueId",
            message: `对话文件不存在：content/dialogues/${data.dialogueId}.ink`,
          });
        }
        asArray(data.questIds).forEach((questId, index) => {
          requireReference(file, pointer("questIds", index), questId, idSets.quest, "任务");
        });
        break;
      }
      case "enemy-template": {
        asArray(data.drops).forEach((drop, index) => {
          if (!isRecord(drop)) {
            return;
          }
          requireReference(file, pointer("drops", index, "itemId"), drop.itemId, idSets.item, "物品");
          if (
            typeof drop.min === "number" &&
            typeof drop.max === "number" &&
            drop.max < drop.min
          ) {
            issues.push({
              code: "range",
              file: file.file,
              path: pointer("drops", index, "max"),
              message: `掉落 max（${drop.max}）不能小于 min（${drop.min}）`,
            });
          }
        });
        break;
      }
      case "enemy": {
        requireReference(file, "/regionId", data.regionId, idSets.region, "区域");
        requireReference(
          file,
          "/templateId",
          data.templateId,
          idSets["enemy-template"],
          "敌人模板",
        );
        break;
      }
      case "item": {
        break;
      }
      case "level-curve": {
        // 阈值单调性与等级序号连续性：schema 管不了区间关系，用结构校验兜住。
        for (const message of validateLevelCurve(data)) {
          issues.push({
            code: "level-curve",
            file: file.file,
            path: "/levels",
            message,
          });
        }
        break;
      }
      case "quest": {
        requireReference(file, "/giverNpcId", data.giverNpcId, idSets.npc, "NPC");
        if (data.turnInNpcId !== undefined) {
          requireReference(file, "/turnInNpcId", data.turnInNpcId, idSets.npc, "NPC");
        }
        asArray(data.objectives).forEach((objective, index) => {
          if (!isRecord(objective)) {
            return;
          }
          requireReference(
            file,
            pointer("objectives", index, "enemyTemplateId"),
            objective.enemyTemplateId,
            idSets["enemy-template"],
            "敌人模板",
          );
        });
        if (isRecord(data.rewards)) {
          asArray(data.rewards.items).forEach((reward, index) => {
            if (!isRecord(reward)) {
              return;
            }
            requireReference(
              file,
              pointer("rewards", "items", index, "itemId"),
              reward.itemId,
              idSets.item,
              "物品",
            );
          });
        }
        // 双向登记：giverNpcId 指向的 NPC 必须在 questIds 里列出本任务。
        if (typeof data.giverNpcId === "string" && typeof data.id === "string") {
          const giver = npcRecords.get(data.giverNpcId);
          if (giver !== undefined && !asArray(giver.questIds).includes(data.id)) {
            issues.push({
              code: "reference",
              file: file.file,
              path: "/giverNpcId",
              message: `NPC ${data.giverNpcId} 的 questIds 未登记任务 ${data.id}`,
            });
          }
        }
        break;
      }
    }
  }

  for (const dialogue of dialogues) {
    dialogue.questTags.forEach((tag, index) => {
      if (!idSets.quest.has(tag.questId)) {
        issues.push({
          code: "dialogue-reference",
          file: dialogue.file,
          path: pointer("questTags", index),
          message: `对话标签引用了不存在的任务：${tag.questId}`,
        });
      }
    });
  }

  return { valid: issues.length === 0, issues };
}
