/**
 * 敌人精灵贴图加载（票 36）。
 *
 * 两种新敌人各有**独立外形贴图**（assets/enemies/*.png），规格与 prop_* 一致
 * （1024×765 白底立面图，加载时洪水填充抠白），因此同一套 keyOut 与 billboard
 * 基建可以直接复用。史莱姆没有专属精灵，沿用程序化球体（createSlimeEnemy）。
 *
 * 生成脚本：tools/pipeline/build-enemy-textures.mjs；产物留档 artifacts/enemies/。
 */
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Scene } from "@babylonjs/core/scene";

import { keyOutNearWhiteBackground } from "./texture-key";

/** 敌人的 AI 档案种类 → 精灵文件；null/chaser = 史莱姆程序化球体。 */
export type EnemySpriteKind = "windup-charge" | "ranged-kite";

export const ENEMY_SPRITE_FILES: Record<EnemySpriteKind, string> = {
  "windup-charge": "enemy_charger.png",
  "ranged-kite": "enemy_spitter.png",
};

const SPRITE_URLS = import.meta.glob("../../../assets/enemies/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export interface EnemySprite {
  texture: DynamicTexture;
  /** 抠白后的透明像素占比，写入场景报告。 */
  transparentRatio: number;
}

function resolveSpriteUrl(kind: EnemySpriteKind): string {
  const fileName = ENEMY_SPRITE_FILES[kind];
  const entry = Object.entries(SPRITE_URLS).find(([path]) => path.endsWith(`/${fileName}`));
  if (!entry) {
    throw new Error(
      `缺少敌人贴图 assets/enemies/${fileName}（先运行 npm run enemies:textures）`,
    );
  }
  return entry[1];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`敌人贴图加载失败：${url}`));
    image.src = url;
  });
}

/** 加载并抠白一张敌人精灵（与 environment 的 prop 贴图同一流程）。 */
export async function loadEnemySprite(
  scene: Scene,
  kind: EnemySpriteKind,
): Promise<EnemySprite> {
  const fileName = ENEMY_SPRITE_FILES[kind];
  const image = await loadImage(resolveSpriteUrl(kind));
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const dynamic = new DynamicTexture(
    `enemy.texture.${kind}`,
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
  const result = keyOutNearWhiteBackground({
    width,
    height,
    data: imageData.data,
  });
  context.putImageData(imageData, 0, 0);
  dynamic.update(false);
  dynamic.hasAlpha = true;
  dynamic.name = `enemy.texture.${kind}.${fileName}`;
  return { texture: dynamic, transparentRatio: result.transparentRatio };
}
