/**
 * 环境贴图加载（票 25）。
 *
 * 资产位于 assets/textures/，文件名遵循 05 管线约定：
 * - environment_*_tile：1024² 正俯视可平铺地面
 * - prop_*：1024×765 白底 45° 等距单件（加载时洪水填充抠白）
 *
 * 原始 PNG 保持 1024 直接可用（Web 压缩/降采样留到后续），
 * billboard 的透明背景在运行时生成，避免在仓库里维护第二套贴图。
 */
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

import {
  loadKeyedTexture,
  resolvePngUrl,
  type KeyedTextureUrlLookup,
} from "./keyed-texture";
import type { KeyOutResult } from "./texture-key";
import type { GroundTextureId, PropKind } from "./green-hollow-layout";

const TEXTURE_URLS = import.meta.glob("../../../assets/textures/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export const GROUND_TEXTURE_FILES: Record<GroundTextureId, string> = {
  grass: "environment_grass_tile.png",
  "stone-path": "environment_stone_path_tile.png",
  "dirt-path": "environment_dirt_path_tile.png",
  water: "environment_water_tile.png",
  // 巢穴地面（票 35）：artifacts/region2/ground-c1 落到 assets/textures/。
  "cave-floor": "environment_cave_floor.png",
};

/**
 * 区域 2「史莱姆巢穴」专用贴图（票 35）。
 *
 * 资产来自 artifacts/region2/（票 35 资产 agent 的 Gemini 候选 c1），
 * 落到 assets/textures/ 后与区域 1 共用同一条抠白/平铺管线。
 * 地面用 ground-c1（1024² 正俯视可平铺），环境件用 1024×765 白底立面。
 */
export const DEN_PROP_TEXTURE_FILES = {
  crystal: "prop_den_crystal.png",
  cocoon: "prop_den_cocoon.png",
  eggs: "prop_den_eggs.png",
} as const;

export const PROP_TEXTURE_FILES: Record<PropKind, string> = {
  "tree-large": "prop_tree_large.png",
  bush: "prop_bush.png",
  "stone-wall": "prop_stone_wall.png",
  barrel: "prop_barrel.png",
  crate: "prop_crate.png",
  // 巢穴件复用 artifacts/region2/ 的贴图（票 35）。
  "den-crystal": DEN_PROP_TEXTURE_FILES.crystal,
  "den-cocoon": DEN_PROP_TEXTURE_FILES.cocoon,
  "den-eggs": DEN_PROP_TEXTURE_FILES.eggs,
};

export interface TextureLoadStats extends KeyOutResult {
  file: string;
}

export interface EnvironmentTextures {
  ground: Record<GroundTextureId, Texture>;
  props: Record<PropKind, DynamicTexture>;
  /** 白底抠除结果，写入场景报告。 */
  keyStats: TextureLoadStats[];
  textures: Texture[];
  dispose(): void;
}

const TEXTURE_LOOKUP: KeyedTextureUrlLookup = {
  urls: TEXTURE_URLS,
  assetsDir: "assets/textures",
};

function resolveTextureUrl(fileName: string): string {
  try {
    return resolvePngUrl(TEXTURE_LOOKUP, fileName);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}（先运行 npm run assets:lint 检查资产清单）`,
    );
  }
}

function createTiledTexture(
  scene: Scene,
  name: string,
  fileName: string,
): Texture {
  const texture = new Texture(resolveTextureUrl(fileName), scene, false, false);
  texture.name = name;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 4;
  return texture;
}

/**
 * 加载白底立面贴图并在 CPU 侧抠白：
 * canvas 尺寸与图片一致（1024×765），保证美术细节不缩放。
 */
async function createKeyedTexture(
  scene: Scene,
  name: string,
  fileName: string,
): Promise<{ texture: DynamicTexture; stats: TextureLoadStats }> {
  const { texture, stats } = await loadKeyedTexture(
    scene,
    name,
    resolveTextureUrl(fileName),
    `贴图加载失败：${fileName}`,
  );
  return { texture, stats: { file: fileName, ...stats } };
}

export async function loadEnvironmentTextures(
  scene: Scene,
): Promise<EnvironmentTextures> {
  const groundEntries = Object.entries(GROUND_TEXTURE_FILES) as Array<
    [GroundTextureId, string]
  >;
  const propEntries = Object.entries(PROP_TEXTURE_FILES) as Array<
    [PropKind, string]
  >;

  const ground = {} as Record<GroundTextureId, Texture>;
  for (const [id, fileName] of groundEntries) {
    ground[id] = createTiledTexture(scene, `texture.environment.${id}`, fileName);
  }

  const props = {} as Record<PropKind, DynamicTexture>;
  const keyStats: TextureLoadStats[] = [];
  const keyed = await Promise.all(
    propEntries.map(async ([id, fileName]) => {
      const result = await createKeyedTexture(
        scene,
        `texture.prop.${id}`,
        fileName,
      );
      return { id, ...result };
    }),
  );
  for (const entry of keyed) {
    props[entry.id] = entry.texture;
    keyStats.push(entry.stats);
  }

  return {
    ground,
    props,
    keyStats,
    textures: [...Object.values(ground), ...Object.values(props)],
    dispose() {
      for (const texture of Object.values(ground)) {
        texture.dispose();
      }
      for (const texture of Object.values(props)) {
        texture.dispose();
      }
    },
  };
}

/** 无贴图材质的共享白色兜底（toon shader 必须有 sampler）。 */
export function createWhiteTexture(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture(
    "texture.toon.white",
    { width: 2, height: 2 },
    scene,
    false,
  );
  const context = texture.getContext() as CanvasRenderingContext2D;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 2, 2);
  texture.update(false);
  return texture;
}
