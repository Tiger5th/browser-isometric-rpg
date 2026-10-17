/**
 * 白底立面贴图加载公共管线（票 25/36/37 共用）。
 *
 * environment prop_*、敌人精灵（enemy_*.png）与探索件（chest_/glow_grass.png）
 * 走同一套流程：import.meta.glob 找 URL → Image 加载 → DynamicTexture 上
 * 预翻转（canvas Y 向下 vs plane UV 左下原点）→ 洪水填充抠白。
 * 之前这三段逻辑逐字复制在 textures.ts / enemy-textures.ts /
 * exploration-textures.ts，这里收敛成一份。
 */
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

import { keyOutNearWhiteBackground, type KeyOutResult } from "./texture-key";

export interface KeyedTextureUrlLookup {
  /** glob 表（import.meta.glob eager 结果）：源路径 → URL。 */
  urls: Record<string, string>;
  /** 报错时提示的资产目录（如 assets/textures）。 */
  assetsDir: string;
}

/** 在 glob 表里按文件名解析 URL；找不到时抛带目录提示的错误。 */
export function resolvePngUrl(
  { urls, assetsDir }: KeyedTextureUrlLookup,
  fileName: string,
): string {
  const entry = Object.entries(urls).find(([path]) => path.endsWith(`/${fileName}`));
  if (!entry) {
    throw new Error(`缺少贴图 ${assetsDir}/${fileName}`);
  }
  return entry[1];
}

export function loadImage(url: string, errorMessage: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(errorMessage));
    image.src = url;
  });
}

export interface KeyedTexture {
  texture: DynamicTexture;
  /** 抠白结果（透明像素占比等），供场景报告使用。 */
  stats: KeyOutResult;
}

/**
 * 加载白底立面贴图并在 CPU 侧抠白：canvas 尺寸与图片一致，保证美术细节不缩放。
 * 输出纹理固定 CLAMP 寻址（立面图不平铺）。
 */
export async function loadKeyedTexture(
  scene: Scene,
  name: string,
  url: string,
  loadImageError: string,
): Promise<KeyedTexture> {
  const image = await loadImage(url, loadImageError);
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

  return { texture: dynamic, stats: result };
}
