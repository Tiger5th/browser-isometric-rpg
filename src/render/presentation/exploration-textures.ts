/**
 * 探索件贴图加载（票 37）。
 *
 * 资产来自资产 agent 的产出（artifacts/exploration/ 留档，选中的候选复制到
 * assets/exploration/）：
 * - `chest_closed.png` / `chest_open.png`：宝箱关闭态与开启态（1024² 白底立面图）
 * - `glow_grass.png`：萤光草（billboard 用）
 *
 * 规格与 prop_* / 敌人精灵一致（白底 + 洪水填充抠白 + Y 预翻转），因此直接复用
 * `keyOutNearWhiteBackground` 与 billboard 基建，不需要单独的抠图管线。
 */
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Scene } from "@babylonjs/core/scene";

import { keyOutNearWhiteBackground } from "./texture-key";

export type ExplorationTextureKind = "chest-closed" | "chest-open" | "glow-grass";

export const EXPLORATION_TEXTURE_FILES: Record<ExplorationTextureKind, string> = {
  "chest-closed": "chest_closed.png",
  "chest-open": "chest_open.png",
  "glow-grass": "glow_grass.png",
};

const TEXTURE_URLS = import.meta.glob("../../../assets/exploration/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export interface ExplorationTexture {
  texture: DynamicTexture;
  /** 抠白后的透明像素占比，写入场景报告。 */
  transparentRatio: number;
}

function resolveTextureUrl(kind: ExplorationTextureKind): string {
  const fileName = EXPLORATION_TEXTURE_FILES[kind];
  const entry = Object.entries(TEXTURE_URLS).find(([path]) => path.endsWith(`/${fileName}`));
  if (!entry) {
    throw new Error(`缺少探索件贴图 assets/exploration/${fileName}`);
  }
  return entry[1];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`探索件贴图加载失败：${url}`));
    image.src = url;
  });
}

/** 加载并抠白一张探索件贴图（与 prop/敌人精灵同一流程）。 */
export async function loadExplorationTexture(
  scene: Scene,
  kind: ExplorationTextureKind,
): Promise<ExplorationTexture> {
  const fileName = EXPLORATION_TEXTURE_FILES[kind];
  const image = await loadImage(resolveTextureUrl(kind));
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const dynamic = new DynamicTexture(
    `exploration.texture.${kind}`,
    { width, height },
    scene,
    true,
  );
  const context = dynamic.getContext() as CanvasRenderingContext2D;
  context.clearRect(0, 0, width, height);
  // DynamicTexture 的 canvas Y 向下，plane UV 原点在左下：预翻转抵消。
  context.translate(0, height);
  context.scale(1, -1);
  context.drawImage(image, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);

  const imageData = context.getImageData(0, 0, width, height);
  const result = keyOutNearWhiteBackground({ width, height, data: imageData.data });
  context.putImageData(imageData, 0, 0);
  dynamic.update(false);
  dynamic.hasAlpha = true;
  dynamic.name = `exploration.texture.${kind}.${fileName}`;
  return { texture: dynamic, transparentRatio: result.transparentRatio };
}