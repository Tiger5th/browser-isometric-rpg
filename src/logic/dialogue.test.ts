import { Compiler } from "inkjs/full";
import type { Story } from "inkjs";
import { describe, expect, it } from "vitest";

import {
  createDialogue,
  parseDialogueSnapshot,
  restoreDialogue,
  serializeDialogueSnapshot,
  snapshotDialogue,
} from "./dialogue";

/** 测试用对话树规模：300 个节点，覆盖编译、执行与快照。 */
const NODE_COUNT = 300;
const SNAPSHOT_AFTER_CHOICES = 150;

function buildStorySource(nodeCount: number): string {
  const lines: string[] = [
    "VAR visits = 0",
    "VAR score = 0",
    'VAR mood = "calm"',
    "-> node_0",
    "",
  ];

  for (let index = 0; index < nodeCount; index += 1) {
    lines.push(`=== node_${index} ===`);
    lines.push("~ visits = visits + 1");
    lines.push("~ score = score + 2");
    if (index === Math.floor(nodeCount / 2)) {
      lines.push('~ mood = "determined"');
    }
    lines.push(`第 ${index} 个节点。你沿着走廊继续前进。`);

    if (index === nodeCount - 1) {
      lines.push("-> END");
    } else {
      lines.push("+ [继续]");
      lines.push(`    -> node_${index + 1}`);
      lines.push("+ [结束]");
      lines.push("    -> END");
    }
    lines.push("");
  }

  return lines.join("\n");
}

interface Timing {
  continueMs: number[];
  chooseMs: number[];
}

type TranscriptEntry =
  | { kind: "text"; value: string }
  | { kind: "choice"; value: string };

function advance(
  story: Story,
  transcript: TranscriptEntry[],
  timing: Timing,
  stopAfterChoices = Number.POSITIVE_INFINITY,
): number {
  let choicesMade = 0;

  while (true) {
    while (story.canContinue) {
      const startedAt = performance.now();
      const text = story.Continue() ?? "";
      timing.continueMs.push(performance.now() - startedAt);
      if (text.length > 0) {
        transcript.push({ kind: "text", value: text });
      }
    }

    if (story.currentChoices.length === 0) {
      return choicesMade;
    }
    if (choicesMade >= stopAfterChoices) {
      return choicesMade;
    }

    const choice = story.currentChoices[0];
    const startedAt = performance.now();
    story.ChooseChoiceIndex(0);
    timing.chooseMs.push(performance.now() - startedAt);
    transcript.push({ kind: "choice", value: choice.text });
    choicesMade += 1;
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

function buildAndCompile(): { compiledJson: string; compileMs: number; sourceBytes: number } {
  const source = buildStorySource(NODE_COUNT);
  const startedAt = performance.now();
  const compiler = new Compiler(source);
  const story = compiler.Compile();
  const compileMs = performance.now() - startedAt;

  if (compiler.errors.length > 0) {
    throw new Error(`ink 编译失败：\n${compiler.errors.join("\n")}`);
  }

  const compiledJson = story.ToJson();
  if (typeof compiledJson !== "string") {
    throw new Error("ink 编译结果无法序列化");
  }

  return {
    compiledJson,
    compileMs,
    sourceBytes: new TextEncoder().encode(source).length,
  };
}

describe("inkjs：几百节点对话树", () => {
  it("可编译、可完整执行，并满足每步耗时预算", () => {
    const compiled = buildAndCompile();
    const story = createDialogue(compiled.compiledJson);
    const transcript: TranscriptEntry[] = [];
    const timing: Timing = { continueMs: [], chooseMs: [] };

    const playStartedAt = performance.now();
    const choicesMade = advance(story, transcript, timing);
    const playMs = performance.now() - playStartedAt;

    const textCount = transcript.filter((entry) => entry.kind === "text").length;
    const choiceCount = transcript.filter((entry) => entry.kind === "choice").length;

    expect(textCount).toBe(NODE_COUNT);
    expect(choicesMade).toBe(NODE_COUNT - 1);
    expect(choiceCount).toBe(NODE_COUNT - 1);
    expect(story.variablesState.$("visits")).toBe(NODE_COUNT);
    expect(story.variablesState.$("score")).toBe(NODE_COUNT * 2);
    expect(story.variablesState.$("mood")).toBe("determined");

    const metrics = {
      nodes: NODE_COUNT,
      sourceBytes: compiled.sourceBytes,
      compiledJsonBytes: new TextEncoder().encode(compiled.compiledJson).length,
      compileMs: Number(compiled.compileMs.toFixed(3)),
      playMs: Number(playMs.toFixed(3)),
      continueCalls: timing.continueMs.length,
      continueMeanMs: Number(mean(timing.continueMs).toFixed(4)),
      continueP95Ms: Number(percentile(timing.continueMs, 0.95).toFixed(4)),
      continueMaxMs: Number(Math.max(...timing.continueMs).toFixed(4)),
      chooseCalls: timing.chooseMs.length,
      chooseMeanMs: Number(mean(timing.chooseMs).toFixed(4)),
      chooseP95Ms: Number(percentile(timing.chooseMs, 0.95).toFixed(4)),
    };
    console.info(`[p0-ink] ${JSON.stringify(metrics)}`);

    // 宽松上限：只拦截数量级级别的性能退化，精确预算留给 L5 夜测。
    expect(compiled.compileMs).toBeLessThan(5_000);
    expect(mean(timing.continueMs)).toBeLessThan(5);
    expect(percentile(timing.continueMs, 0.95)).toBeLessThan(20);
    expect(mean(timing.chooseMs)).toBeLessThan(5);
  });

  it("variablesState 快照往返后可继续执行且结果一致", () => {
    const compiled = buildAndCompile();
    const story = createDialogue(compiled.compiledJson);
    const beforeSnapshot: TranscriptEntry[] = [];
    const beforeTiming: Timing = { continueMs: [], chooseMs: [] };

    advance(story, beforeSnapshot, beforeTiming, SNAPSHOT_AFTER_CHOICES);

    const visitsAtSnapshot = story.variablesState.$("visits");
    const moodAtSnapshot = story.variablesState.$("mood");
    const choicesAtSnapshot = story.currentChoices.map((choice) => choice.text);
    expect(choicesAtSnapshot.length).toBeGreaterThan(0);

    const snapshotStartedAt = performance.now();
    const snapshot = snapshotDialogue(story);
    const snapshotMs = performance.now() - snapshotStartedAt;

    const serialized = serializeDialogueSnapshot(snapshot);
    const parsed = parseDialogueSnapshot(serialized);
    expect(parsed.formatVersion).toBe(1);
    expect(() => JSON.parse(parsed.inkState)).not.toThrow();

    // 原故事继续到结尾，作为对照组。
    const tailOriginal: TranscriptEntry[] = [];
    const tailTiming: Timing = { continueMs: [], chooseMs: [] };
    advance(story, tailOriginal, tailTiming);

    // 新运行时 + 快照恢复，继续执行。
    const restored = createDialogue(compiled.compiledJson);
    const restoreStartedAt = performance.now();
    restoreDialogue(restored, parsed);
    const restoreMs = performance.now() - restoreStartedAt;

    expect(restored.variablesState.$("visits")).toBe(visitsAtSnapshot);
    expect(restored.variablesState.$("mood")).toBe(moodAtSnapshot);
    expect(restored.currentChoices.map((choice) => choice.text)).toEqual(choicesAtSnapshot);

    const tailRestored: TranscriptEntry[] = [];
    const restoredTiming: Timing = { continueMs: [], chooseMs: [] };
    advance(restored, tailRestored, restoredTiming);

    expect(tailRestored).toEqual(tailOriginal);
    expect(restored.variablesState.$("visits")).toBe(story.variablesState.$("visits"));
    expect(restored.variablesState.$("score")).toBe(story.variablesState.$("score"));
    expect(restored.variablesState.$("mood")).toBe(story.variablesState.$("mood"));
    expect(restored.variablesState.$("visits")).toBe(NODE_COUNT);

    const metrics = {
      nodes: NODE_COUNT,
      snapshotAfterChoices: SNAPSHOT_AFTER_CHOICES,
      visitsAtSnapshot,
      inkStateBytes: new TextEncoder().encode(snapshot.inkState).length,
      snapshotBytes: new TextEncoder().encode(serialized).length,
      snapshotMs: Number(snapshotMs.toFixed(3)),
      restoreMs: Number(restoreMs.toFixed(3)),
      tailEntries: tailOriginal.length,
    };
    console.info(`[p0-ink-snapshot] ${JSON.stringify(metrics)}`);

    expect(snapshotMs).toBeLessThan(100);
    expect(restoreMs).toBeLessThan(100);
  });

  it("拒绝版本不符或缺少 inkState 的快照", () => {
    const story = createDialogue(buildAndCompile().compiledJson);

    expect(() =>
      restoreDialogue(story, { formatVersion: 2, inkState: "{}" } as never),
    ).toThrow(/不支持的对话快照版本/);
    expect(() => restoreDialogue(story, { formatVersion: 1, inkState: "  " })).toThrow(
      /缺少 inkState/,
    );
    expect(() => parseDialogueSnapshot('{"formatVersion":1}')).toThrow(/格式非法/);
  });
});
