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
  keyOutNearWhiteBackground,
  type KeyOutResult,
} from "./texture-key";
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
};

export const PROP_TEXTURE_FILES: Record<PropKind, string> = {
  "tree-large": "prop_tree_large.png",
  bush: "prop_bush.png",
  "stone-wall": "prop_stone_wall.png",
  barrel: "prop_barrel.png",
  crate: "prop_crate.png",
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

function resolveTextureUrl(fileName: string): string {
  const entry = Object.entries(TEXTURE_URLS).find(([path]) =>
    path.endsWith(`/${fileName}`),
  );
  if (!entry) {
    throw new Error(
      `缺少环境贴图 assets/textures/${fileName}（先运行 npm run assets:lint 检查资产清单）`,
    );
  }
  return entry[1];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`贴图加载失败：${url}`));
    image.src = url;
  });
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
  const image = await loadImage(resolveTextureUrl(fileName));
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const dynamic = new DynamicTexture(name, { width, height }, scene, true);
  const context = dynamic.getContext() as CanvasRenderingContext2D;
  context.clearRect(0, 0, width, height);
  // DynamicTexture 的 canvas 坐标 Y 向下，而 plane UV 原点在左下（Y 向上），
  // 直接 drawImage 会垂直翻转贴图（树冠朝下、石墙倒挂）；此处预翻转抵消。
  context.translate(0, height);
  context.scale(1, -1);
  context.drawImage(image, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);

  const imageData = context.getImageData(0, 0, width, height);
  const result = keyOutNearWhiteBackground({
    width,
    height,
    data: imageData.data,
  });
  context.putImageData(imageData, 0, 0);
  dynamic.update(false);
  dynamic.hasAlpha = true;
  dynamic.wrapU = Texture.CLAMP_ADDRESSMODE;
  dynamic.wrapV = Texture.CLAMP_ADDRESSMODE;

  return {
    texture: dynamic,
    stats: { file: fileName, ...result },
  };
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
