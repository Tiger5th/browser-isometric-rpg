/**
 * inkjs 运行时封装：加载编译后的 ink JSON、推进对话、存档快照。
 *
 * 编译器（inkjs/full）只在内容构建/测试阶段使用；运行时只依赖
 * "inkjs" 的精简入口，避免把编译器打进游戏包。
 */

import { Story } from "inkjs";

export const DIALOGUE_SNAPSHOT_VERSION = 1;

/** 从编译后的 ink JSON 创建故事运行时。 */
export function createDialogue(json: string | Record<string, unknown>): Story {
  return typeof json === "string" ? new Story(json) : new Story(json);
}

export interface DialogueSnapshot {
  formatVersion: 1;
  /**
   * ink StoryState.ToJson()：包含 variablesState、调用栈、访问计数等
   * 完整执行状态，可直接 JSON 序列化。
   */
  inkState: string;
}

export function snapshotDialogue(story: Story): DialogueSnapshot {
  return {
    formatVersion: DIALOGUE_SNAPSHOT_VERSION,
    inkState: story.state.ToJson(),
  };
}

export function restoreDialogue(story: Story, snapshot: DialogueSnapshot): void {
  if (snapshot.formatVersion !== DIALOGUE_SNAPSHOT_VERSION) {
    throw new Error(`不支持的对话快照版本：${String(snapshot.formatVersion)}`);
  }
  if (typeof snapshot.inkState !== "string" || snapshot.inkState.trim() === "") {
    throw new Error("对话快照缺少 inkState");
  }
  story.state.LoadJson(snapshot.inkState);
}

export function serializeDialogueSnapshot(snapshot: DialogueSnapshot): string {
  return JSON.stringify(snapshot);
}

export function parseDialogueSnapshot(json: string): DialogueSnapshot {
  const parsed = JSON.parse(json) as Partial<DialogueSnapshot> | null;
  if (
    parsed === null ||
    parsed.formatVersion !== DIALOGUE_SNAPSHOT_VERSION ||
    typeof parsed.inkState !== "string"
  ) {
    throw new Error("对话快照格式非法");
  }
  return { formatVersion: DIALOGUE_SNAPSHOT_VERSION, inkState: parsed.inkState };
}

export interface ContinueResult {
  /** 本次推进产生的全部文本。 */
  text: string;
  /** 停在选择点时可见的选项文本。 */
  choices: string[];
}

/**
 * 推进结果：除文本/选项外，还收集本次推进经过的 ink 标签。
 *
 * 标签与文本按 ink 的行模型一一对应（`story.currentTags` 属于最近一次
 * Continue 返回的行），任务标签据此在 GameSession 内触发状态转移。
 */
export interface DialogueStep extends ContinueResult {
  tags: string[];
  /** 故事已结束且没有待选选项。 */
  ended: boolean;
}

/** 持续 Continue 直到需要玩家选择或故事结束，并收集沿途标签。 */
export function continueDialogue(story: Story): DialogueStep {
  let text = "";
  const tags: string[] = [];
  while (story.canContinue) {
    text += story.Continue() ?? "";
    tags.push(...(story.currentTags ?? []));
  }
  return {
    text,
    tags,
    choices: story.currentChoices.map((choice) => choice.text),
    ended: story.currentChoices.length === 0,
  };
}

/** 持续 Continue 直到需要玩家选择或故事结束。 */
export function continueToChoices(story: Story): ContinueResult {
  const { text, choices } = continueDialogue(story);
  return { text, choices };
}
