/**
 * 环境件的程序化网格配方（票 28，user story 15）。
 *
 * 决策背景（specs/p2-gameplay.md「世界表现」）：
 * - 树/石墙/木桶/木箱从 billboard 升级为「Babylon 内置几何拼装的真网格」，
 *   贴图沿用既有 Gemini 资产（assets/textures/prop_*.png）；
 * - 配方是**纯数据**：每类环境件 = 一组零件（基元 + 尺寸 + 贴图 UV 窗口）。
 *   渲染层按配方实例化几何，逻辑测试直接断言配方本身——
 *   这样「网格化」这一事实可被 L1 锁定，不需要浏览器。
 *
 * 贴图坐标：Gemini 立绘是 1024×765 的 45° 等距单件，u/v 取 0–1。
 * 每个零件声明它使用贴图的哪一块（uvWindow），因此圆柱的顶面用贴图顶部的
 * 椭圆口、侧面用桶身的木纹区、底面用底部暗部——四张贴图全部被利用。
 */

import type { PropKind } from "./green-hollow-layout";

/** Babylon MeshBuilder 支持的基元子集（本配方只用这些）。 */
export type PrimitiveKind = "cylinder" | "box" | "sphere" | "disc" | "torus";

export interface UvWindow {
  /** u 起点（0–1）。 */
  u: number;
  /** v 起点（0–1，0 = 贴图底部）。 */
  v: number;
  /** u 宽度（0–1）。 */
  width: number;
  /** v 高度（0–1）。 */
  height: number;
}

export interface PropPart {
  /** 零件 id（同一环境件内唯一）。 */
  id: string;
  primitive: PrimitiveKind;
  /** 零件尺寸（米）。 */
  size: { width: number; height: number; depth: number };
  /** 零件原点相对环境件根节点（米；Y=0 为地面）。 */
  offset: { x: number; y: number; z: number };
  /** 顶面/侧面/底面等朝向，决定 UV 窗口的取法。 */
  face: "side" | "top" | "bottom" | "band";
  /** 贴图窗口；缺省表示整张贴图。 */
  uv?: UvWindow;
  /** 是否参与渲染（false 的零件只用于碰撞/占位，当前无此类）。 */
  render?: boolean;
}

export interface PropMeshRecipe {
  kind: PropKind;
  /** 整件的视觉高度（米，scale=1）。 */
  height: number;
  /** 整件的视觉半径/宽度（米，scale=1）。 */
  width: number;
  parts: readonly PropPart[];
  /**
   * 三角数估算（LOD 预算用）：圆柱侧面段数固定，可精确算出。
   * 渲染层的真实三角数以 mesh.getTotalIndices()/3 为准，这里给预算值。
   */
  estimatedTriangles: number;
}

/** 圆柱侧面段数：低模风格，8 段足够圆润且省三角。 */
export const CYLINDER_SEGMENTS = 8;
/** 球体段数：灌木/树冠用。4×4 已能读出圆润团块，且把单棵树的三角数压在预算内。 */
export const SPHERE_SEGMENTS = 4;

/** 把 UV 窗口字面量收敛成 UvWindow（避免每处重复写键名）。 */
function window(spec: {
  u: number;
  v: number;
  width: number;
  height: number;
}): UvWindow {
  return { u: spec.u, v: spec.v, width: spec.width, height: spec.height };
}

/* ------------------------------------------------------------------ */
/* 树：树干（圆柱）+ 三团树冠（球体）                                  */
/* ------------------------------------------------------------------ */

const TREE_RECIPE: PropMeshRecipe = {
  kind: "tree-large",
  height: 3.81,
  width: 5.1,
  estimatedTriangles: CYLINDER_SEGMENTS * 2 + 3 * (SPHERE_SEGMENTS * SPHERE_SEGMENTS * 2),
  parts: [
    // 树干：贴图中央的木干区（约占贴图宽 22%、高 45%，位于下半幅）。
    {
      id: "trunk",
      primitive: "cylinder",
      size: { width: 0.42, height: 1.95, depth: 0.42 },
      offset: { x: 0, y: 0.975, z: 0 },
      face: "side",
      uv: window({ u: 0.4, v: 0.08, width: 0.2, height: 0.44 }),
    },
    // 树冠三团：主冠居中偏上，两侧各一团，形成锚定图里的圆润团块。
    {
      id: "canopy.main",
      primitive: "sphere",
      size: { width: 2.3, height: 1.9, depth: 2.3 },
      offset: { x: 0, y: 2.55, z: 0 },
      face: "top",
      uv: window({ u: 0.22, v: 0.5, width: 0.56, height: 0.48 }),
    },
    {
      id: "canopy.left",
      primitive: "sphere",
      size: { width: 1.6, height: 1.35, depth: 1.6 },
      offset: { x: -0.95, y: 2.1, z: 0.1 },
      face: "top",
      uv: window({ u: 0.08, v: 0.52, width: 0.42, height: 0.44 }),
    },
    {
      id: "canopy.right",
      primitive: "sphere",
      size: { width: 1.5, height: 1.3, depth: 1.5 },
      offset: { x: 1.0, y: 2.2, z: -0.05 },
      face: "top",
      uv: window({ u: 0.52, v: 0.52, width: 0.4, height: 0.44 }),
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 石墙：长方体（贴图石墙区），可横向排列成连续墙                      */
/* ------------------------------------------------------------------ */

const STONE_WALL_RECIPE: PropMeshRecipe = {
  kind: "stone-wall",
  height: 3.21,
  width: 4.3,
  estimatedTriangles: 12,
  parts: [
    {
      id: "body",
      primitive: "box",
      size: { width: 2.0, height: 1.05, depth: 0.55 },
      offset: { x: 0, y: 0.525, z: 0 },
      face: "side",
      // 不设 uv：整幅石墙贴图铺满这个长方体（六面同一张贴图）。
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 木桶：桶身（圆柱）+ 顶盖（圆盘）+ 两道铁箍（圆环）                  */
/* ------------------------------------------------------------------ */

const BARREL_RECIPE: PropMeshRecipe = {
  kind: "barrel",
  height: 1.05,
  width: 1.4,
  // 桶身侧面 8 段 = 16 三角；顶盖 1 个扇形 8 三角；两道铁箍各 8 段 = 16 三角。
  estimatedTriangles: CYLINDER_SEGMENTS * 2 + CYLINDER_SEGMENTS + 2 * CYLINDER_SEGMENTS * 2,
  parts: [
    {
      id: "body",
      primitive: "cylinder",
      size: { width: 0.72, height: 0.78, depth: 0.72 },
      offset: { x: 0, y: 0.39, z: 0 },
      face: "side",
      uv: window({ u: 0.18, v: 0.06, width: 0.64, height: 0.7 }),
    },
    {
      id: "rim.top",
      primitive: "disc",
      size: { width: 0.74, height: 0.06, depth: 0.74 },
      offset: { x: 0, y: 0.79, z: 0 },
      face: "top",
      uv: window({ u: 0.16, v: 0.76, width: 0.68, height: 0.22 }),
    },
    {
      id: "band.upper",
      primitive: "torus",
      size: { width: 0.78, height: 0.09, depth: 0.78 },
      offset: { x: 0, y: 0.62, z: 0 },
      face: "band",
      uv: window({ u: 0.1, v: 0.4, width: 0.8, height: 0.12 }),
    },
    {
      id: "band.lower",
      primitive: "torus",
      size: { width: 0.8, height: 0.09, depth: 0.8 },
      offset: { x: 0, y: 0.2, z: 0 },
      face: "band",
      uv: window({ u: 0.1, v: 0.4, width: 0.8, height: 0.12 }),
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 木箱：箱体（立方）+ 盖板边框（略大的薄盒）                          */
/* ------------------------------------------------------------------ */

const CRATE_RECIPE: PropMeshRecipe = {
  kind: "crate",
  height: 1.05,
  width: 1.4,
  estimatedTriangles: 24,
  parts: [
    {
      id: "body",
      primitive: "box",
      size: { width: 0.82, height: 0.8, depth: 0.82 },
      offset: { x: 0, y: 0.4, z: 0 },
      face: "side",
      uv: window({ u: 0.14, v: 0.1, width: 0.72, height: 0.78 }),
    },
    {
      id: "lid",
      primitive: "box",
      size: { width: 0.9, height: 0.08, depth: 0.9 },
      offset: { x: 0, y: 0.84, z: 0 },
      face: "top",
      uv: window({ u: 0.2, v: 0.82, width: 0.6, height: 0.16 }),
    },
  ],
};

/* ------------------------------------------------------------------ */
/* 巢穴件（票 35）：晶簇 / 茧 / 蛋                                    */
/*                                                                    */
/* 几何刻意做得比木箱木桶更「有尖角」——锥体与扁球贴上巢穴的暗紫贴图 */
/* 后轮廓与区域 1 的家具类件明显不同，玩家一眼能分出「这是巢穴的东西」。 */
/* ------------------------------------------------------------------ */

/** 晶簇：三根高低不一的锥体聚在一起，是巢穴最显眼的剪影。 */
const DEN_CRYSTAL_RECIPE: PropMeshRecipe = {
  kind: "den-crystal",
  height: 1.42,
  width: 1.9,
  estimatedTriangles: 42,
  parts: [
    {
      id: "shard.center",
      primitive: "cylinder",
      size: { width: 0.34, height: 1.3, depth: 0.34 },
      offset: { x: 0, y: 0.65, z: 0 },
      face: "side",
      // UV 窗口取自贴图实测内容包围盒（artifacts/region2/crystal-c1，
      // u 0.273–0.729 / v 0.131–0.877），窗口只取内容内的子矩形，
      // 避免整块网格采样到白底而被 alphaCutoff 裁成细条。
      uv: window({ u: 0.28, v: 0.45, width: 0.4, height: 0.4 }),
    },
    {
      id: "shard.left",
      primitive: "cylinder",
      size: { width: 0.26, height: 0.9, depth: 0.26 },
      offset: { x: -0.34, y: 0.45, z: 0.1 },
      face: "side",
      uv: window({ u: 0.27, v: 0.2, width: 0.26, height: 0.32 }),
    },
    {
      id: "shard.right",
      primitive: "cylinder",
      size: { width: 0.24, height: 0.72, depth: 0.24 },
      offset: { x: 0.32, y: 0.36, z: -0.12 },
      face: "side",
      uv: window({ u: 0.5, v: 0.25, width: 0.22, height: 0.28 }),
    },
  ],
};

/** 茧：悬吊的椭球 + 顶部小环，贴上茧的贴图。 */
const DEN_COCOON_RECIPE: PropMeshRecipe = {
  kind: "den-cocoon",
  height: 1.57,
  width: 2.1,
  estimatedTriangles: 40,
  parts: [
    {
      id: "stalk",
      primitive: "cylinder",
      size: { width: 0.12, height: 0.55, depth: 0.12 },
      offset: { x: 0, y: 0.28, z: 0 },
      face: "side",
      // cocoon-c1 内容包围盒：u 0.285–0.774 / v 0.077–0.931。
      uv: window({ u: 0.47, v: 0.1, width: 0.12, height: 0.22 }),
    },
    {
      id: "sac",
      primitive: "sphere",
      size: { width: 0.78, height: 1.0, depth: 0.78 },
      offset: { x: 0, y: 0.95, z: 0 },
      face: "side",
      uv: window({ u: 0.29, v: 0.3, width: 0.48, height: 0.6 }),
    },
  ],
};

/** 蛋：三枚高低错落的扁球挤成一堆。 */
const DEN_EGGS_RECIPE: PropMeshRecipe = {
  kind: "den-eggs",
  height: 1.2,
  width: 1.6,
  estimatedTriangles: 36,
  parts: [
    {
      id: "egg.left",
      primitive: "sphere",
      size: { width: 0.6, height: 0.82, depth: 0.6 },
      offset: { x: -0.26, y: 0.41, z: 0.08 },
      face: "side",
      // eggs-c1 内容包围盒：u 0.138–0.863 / v 0.105–0.905。
      uv: window({ u: 0.16, v: 0.2, width: 0.26, height: 0.45 }),
    },
    {
      id: "egg.center",
      primitive: "sphere",
      size: { width: 0.66, height: 0.95, depth: 0.66 },
      offset: { x: 0.06, y: 0.48, z: -0.06 },
      face: "side",
      uv: window({ u: 0.4, v: 0.13, width: 0.28, height: 0.5 }),
    },
    {
      id: "egg.right",
      primitive: "sphere",
      size: { width: 0.52, height: 0.7, depth: 0.52 },
      offset: { x: 0.34, y: 0.35, z: 0.14 },
      face: "side",
      uv: window({ u: 0.62, v: 0.25, width: 0.22, height: 0.4 }),
    },
  ],
};

/**
 * 全部硬碰撞环境件的网格配方。
 * 灌木**不在表内**：它保持 billboard 可穿（user story 16），
 * 因此这份表本身就是「哪些件已网格化」的权威清单。
 */
export const PROP_MESH_RECIPES: Record<
  "tree-large" | "stone-wall" | "barrel" | "crate" | "den-crystal" | "den-cocoon" | "den-eggs",
  PropMeshRecipe
> = {
  "tree-large": TREE_RECIPE,
  "stone-wall": STONE_WALL_RECIPE,
  barrel: BARREL_RECIPE,
  crate: CRATE_RECIPE,
  "den-crystal": DEN_CRYSTAL_RECIPE,
  "den-cocoon": DEN_COCOON_RECIPE,
  "den-eggs": DEN_EGGS_RECIPE,
};

/** 网格化的环境件种类（硬碰撞 4 类）。 */
export const MESHED_PROP_KINDS = Object.keys(PROP_MESH_RECIPES) as Array<
  keyof typeof PROP_MESH_RECIPES
>;

export function getPropMeshRecipe(kind: keyof typeof PROP_MESH_RECIPES): PropMeshRecipe {
  const recipe = PROP_MESH_RECIPES[kind];
  if (!recipe) {
    throw new Error(`没有 ${kind} 的网格配方`);
  }
  return recipe;
}

/* ------------------------------------------------------------------ */
/* 配方自检（L1 直测）                                                 */
/* ------------------------------------------------------------------ */

export interface RecipeIssue {
  kind: string;
  partId: string;
  message: string;
}

/** 单类配方的自检：零件不越出视觉包围盒、UV 窗口合法、零件 id 唯一。 */
export function validatePropMeshRecipe(recipe: PropMeshRecipe): RecipeIssue[] {
  const issues: RecipeIssue[] = [];
  const seen = new Set<string>();
  const halfWidth = recipe.width / 2;

  for (const part of recipe.parts) {
    if (seen.has(part.id)) {
      issues.push({ kind: recipe.kind, partId: part.id, message: "零件 id 重复" });
    }
    seen.add(part.id);

    if (part.size.width <= 0 || part.size.height <= 0 || part.size.depth <= 0) {
      issues.push({ kind: recipe.kind, partId: part.id, message: "零件尺寸必须为正" });
    }

    // 零件不得低于地面（悬空）或高出整件视觉高度 + 0.35m 余量。
    const bottom = part.offset.y - part.size.height / 2;
    const top = part.offset.y + part.size.height / 2;
    if (bottom < -0.05) {
      issues.push({ kind: recipe.kind, partId: part.id, message: "零件穿到地面以下" });
    }
    if (top > recipe.height + 0.35) {
      issues.push({ kind: recipe.kind, partId: part.id, message: "零件高出视觉包围盒" });
    }

    // 水平方向不得越出视觉宽度（避免零件飘在贴图外）。
    const reach = Math.max(part.size.width, part.size.depth) / 2;
    if (Math.abs(part.offset.x) + reach > halfWidth + 0.35) {
      issues.push({ kind: recipe.kind, partId: part.id, message: "零件横向越界" });
    }

    if (part.uv) {
      const { u, v, width, height } = part.uv;
      if (u < 0 || v < 0 || width <= 0 || height <= 0 || u + width > 1 || v + height > 1) {
        issues.push({ kind: recipe.kind, partId: part.id, message: "UV 窗口越界" });
      }
    }
  }

  if (recipe.parts.length === 0) {
    issues.push({ kind: recipe.kind, partId: "*", message: "配方没有零件" });
  }
  return issues;
}

/** 全部配方自检；空数组 = 通过。 */
export function validateAllPropMeshRecipes(): RecipeIssue[] {
  return MESHED_PROP_KINDS.flatMap((kind) => validatePropMeshRecipe(getPropMeshRecipe(kind)));
}

/** 配方总三角数（LOD 预算：逐件 LOD 时按这个数砍）。 */
export function totalRecipeTriangles(): number {
  return MESHED_PROP_KINDS.reduce(
    (sum, kind) => sum + getPropMeshRecipe(kind).estimatedTriangles,
    0,
  );
}
