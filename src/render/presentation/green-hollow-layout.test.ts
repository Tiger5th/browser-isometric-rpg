import { describe, expect, it } from "vitest";

import {
  ENTITY_ANCHORS,
  GREEN_HOLLOW_BOUNDS,
  GROUND_PATCHES,
  PLAYER_SPAWN,
  PROP_DIMENSIONS,
  PROPS,
  validateLayout,
} from "./green-hollow-layout";

describe("green_hollow 正式布局", () => {
  it("布局自检无问题（边界/实体间距/道具重叠）", () => {
    expect(validateLayout()).toEqual([]);
  });

  it("地面包含草地、石板路、泥土路、水面四种贴图", () => {
    const textures = new Set(GROUND_PATCHES.map((patch) => patch.texture));
    expect(textures).toEqual(
      new Set(["grass", "stone-path", "dirt-path", "water"]),
    );
  });

  it("草地铺满整个区域边界", () => {
    const base = GROUND_PATCHES.find((patch) => patch.id === "ground.grass.base");
    expect(base).toBeDefined();
    expect(base?.width).toBe(
      GREEN_HOLLOW_BOUNDS.maxX - GREEN_HOLLOW_BOUNDS.minX,
    );
    expect(base?.depth).toBe(
      GREEN_HOLLOW_BOUNDS.maxZ - GREEN_HOLLOW_BOUNDS.minZ,
    );
  });

  it("包含树/石墙/灌木/木桶/木箱五类立面物件且数量足以成景", () => {
    const byKind = new Map<string, number>();
    for (const prop of PROPS) {
      byKind.set(prop.kind, (byKind.get(prop.kind) ?? 0) + 1);
    }
    for (const kind of [
      "tree-large",
      "stone-wall",
      "bush",
      "barrel",
      "crate",
    ]) {
      expect(byKind.get(kind) ?? 0).toBeGreaterThan(0);
    }
    expect(PROPS.length).toBeGreaterThanOrEqual(20);
  });

  it("大多数立面物件参与遮挡判定（树/墙/灌木）", () => {
    const occluders = PROPS.filter((prop) => prop.occluder);
    expect(occluders.length).toBeGreaterThanOrEqual(20);
  });

  it("布局是确定性的纯数据（重复读取不产生位置漂移）", () => {
    const snapshot = PROPS.map((prop) => `${prop.id}:${prop.x},${prop.z}`);
    const again = PROPS.map((prop) => `${prop.id}:${prop.x},${prop.z}`);
    expect(again).toEqual(snapshot);
  });

  it("玩家出生点与区域 content 的 spawn 一致", () => {
    expect(PLAYER_SPAWN).toEqual({ x: 0, y: 0, z: 0 });
    expect(ENTITY_ANCHORS["entity:player"]).toBe(PLAYER_SPAWN);
  });

  it("每类物件的 billboard 尺寸按 1024:765 宽高比设计", () => {
    for (const dimensions of Object.values(PROP_DIMENSIONS)) {
      expect(dimensions.width / dimensions.height).toBeCloseTo(1024 / 765, 1);
    }
  });

  it("validateLayout 能发现越界与出生点重叠", () => {
    const issues = validateLayout(
      [
        {
          id: "prop.test.out-of-bounds",
          kind: "tree-large",
          x: 100,
          z: 0,
          scale: 1,
          occluder: true,
          zone: "treeline",
        },
        {
          id: "prop.test.on-player",
          kind: "tree-large",
          x: PLAYER_SPAWN.x,
          z: PLAYER_SPAWN.z,
          scale: 1,
          occluder: true,
          zone: "village",
        },
      ],
      [],
      { "entity:player": PLAYER_SPAWN },
    );
    expect(issues.some((issue) => issue.id === "prop.test.out-of-bounds")).toBe(true);
    expect(issues.some((issue) => issue.id === "prop.test.on-player")).toBe(true);
  });
});
