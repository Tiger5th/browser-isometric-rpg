import { describe, expect, it } from "vitest";

import { PROP_DIMENSIONS, PROPS, type PropKind } from "./green-hollow-layout";
import { SLIME_DEN_PROPS } from "./slime-den-layout";
import {
  MESHED_PROP_KINDS,
  PROP_MESH_RECIPES,
  getPropMeshRecipe,
  totalRecipeTriangles,
  validateAllPropMeshRecipes,
  validatePropMeshRecipe,
  type PropMeshRecipe,
} from "./prop-mesh-recipe";

describe("环境件网格配方（user story 15）", () => {
  it("硬碰撞件有配方，灌木没有（保持 billboard）", () => {
    // 区域 1 的四类 + 区域 2 的三类巢穴件（票 35）。
    expect(MESHED_PROP_KINDS).toEqual([
      "tree-large",
      "stone-wall",
      "barrel",
      "crate",
      "den-crystal",
      "den-cocoon",
      "den-eggs",
    ]);
    expect(
      (PROP_MESH_RECIPES as Record<string, PropMeshRecipe | undefined>).bush,
    ).toBeUndefined();
  });

  it("每类配方自检通过（零件不穿地/不越界/UV 合法/id 唯一）", () => {
    expect(validateAllPropMeshRecipes()).toEqual([]);
    for (const kind of MESHED_PROP_KINDS) {
      expect(validatePropMeshRecipe(getPropMeshRecipe(kind))).toEqual([]);
    }
  });

  it("配方视觉尺寸与布局常量一致（网格与碰撞用同一组尺寸）", () => {
    for (const kind of MESHED_PROP_KINDS) {
      const recipe = getPropMeshRecipe(kind);
      const dimensions = PROP_DIMENSIONS[kind as PropKind];
      expect(recipe.width).toBeCloseTo(dimensions.width, 5);
      expect(recipe.height).toBeCloseTo(dimensions.height, 5);
    }
  });

  it("巢穴件（票 35）三种都配了网格配方：晶簇 / 茧 / 蛋", () => {
    for (const kind of ["den-crystal", "den-cocoon", "den-eggs"] as const) {
      expect(MESHED_PROP_KINDS).toContain(kind);
      expect(getPropMeshRecipe(kind).parts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("树由树干 + 至少三团树冠组成（圆润团块，贴合锚定图）", () => {
    const tree = getPropMeshRecipe("tree-large");
    const canopy = tree.parts.filter((part) => part.id.startsWith("canopy."));
    expect(canopy.length).toBeGreaterThanOrEqual(3);
    expect(tree.parts.filter((part) => part.id === "trunk")).toHaveLength(1);
    // 树冠最高点接近视觉高度（树比贴图留白高一点点没关系，但不许矮一半）。
    const canopyTop = Math.max(
      ...canopy.map((part) => part.offset.y + part.size.height / 2),
    );
    expect(canopyTop).toBeGreaterThan(tree.height * 0.75);
  });

  it("木桶有桶身 + 顶盖 + 两道铁箍", () => {
    const barrel = getPropMeshRecipe("barrel");
    const ids = barrel.parts.map((part) => part.id);
    expect(ids).toContain("body");
    expect(ids).toContain("rim.top");
    expect(ids.filter((id) => id.startsWith("band.")).length).toBe(2);
  });

  it("木箱有箱体 + 盖板", () => {
    const crate = getPropMeshRecipe("crate");
    expect(crate.parts.map((part) => part.id)).toEqual(["body", "lid"]);
  });

  it("石墙是单块长方体（贴图整幅，横向多块拼连续墙）", () => {
    const wall = getPropMeshRecipe("stone-wall");
    expect(wall.parts).toHaveLength(1);
    expect(wall.parts[0].primitive).toBe("box");
    expect(wall.parts[0].uv).toBeUndefined();
  });

  it("每个零件的 UV 窗口都落在贴图内且面积合理", () => {
    for (const kind of MESHED_PROP_KINDS) {
      for (const part of getPropMeshRecipe(kind).parts) {
        if (!part.uv) {
          continue;
        }
        expect(part.uv.width).toBeGreaterThanOrEqual(0.1);
        expect(part.uv.height).toBeGreaterThanOrEqual(0.1);
        expect(part.uv.u + part.uv.width).toBeLessThanOrEqual(1);
        expect(part.uv.v + part.uv.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it("配方三角数在逐件 LOD 预算内（单类 ≤ 120，区域 1 的四类合计 ≤ 210）", () => {
    for (const kind of MESHED_PROP_KINDS) {
      expect(getPropMeshRecipe(kind).estimatedTriangles).toBeLessThanOrEqual(120);
    }
    // 票 35 起预算分区域算：巢穴三件只出现在区域 2，不占区域 1 的预算。
    const regionOneKinds = MESHED_PROP_KINDS.filter((kind) => !kind.startsWith("den-"));
    const regionOneTotal = regionOneKinds.reduce(
      (sum, kind) => sum + getPropMeshRecipe(kind).estimatedTriangles,
      0,
    );
    expect(regionOneTotal).toBeLessThanOrEqual(210);
    expect(totalRecipeTriangles()).toBeGreaterThan(regionOneTotal);
  });

  it("validatePropMeshRecipe 能抓出坏配方", () => {
    const broken: PropMeshRecipe = {
      kind: "barrel",
      height: 1,
      width: 1,
      estimatedTriangles: 1,
      parts: [
        {
          id: "dup",
          primitive: "box",
          size: { width: 1, height: -1, depth: 1 },
          offset: { x: 0, y: -5, z: 0 },
          face: "side",
          uv: { u: 0.5, v: 0.5, width: 0.9, height: 0.9 },
        },
        { id: "dup", primitive: "box", size: { width: 1, height: 1, depth: 1 }, offset: { x: 0, y: 0.5, z: 0 }, face: "side" },
      ],
    };
    const messages = validatePropMeshRecipe(broken).map((issue) => issue.message);
    expect(messages).toContain("零件 id 重复");
    expect(messages).toContain("零件尺寸必须为正");
    expect(messages).toContain("零件穿到地面以下");
    expect(messages).toContain("UV 窗口越界");
  });

  it("两个区域的布局里各自出现的硬碰撞件都有对应配方（网格化不遗漏）", () => {
    const regionOne = new Set(PROPS.map((prop) => prop.kind));
    const regionTwo = new Set(SLIME_DEN_PROPS.map((prop) => prop.kind));
    for (const kind of MESHED_PROP_KINDS) {
      expect(regionOne.has(kind) || regionTwo.has(kind)).toBe(true);
    }
  });

  it("getPropMeshRecipe 对未知种类抛错", () => {
    expect(() => getPropMeshRecipe("bush" as never)).toThrow();
  });
});
