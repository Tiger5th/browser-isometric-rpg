/**
 * 全部地面贴图 id 的运行时代码视图。
 *
 * 与 textures.ts 的 GROUND_TEXTURE_FILES 一一对应。单独成文件是为了让
 * 纯布局模块（slime-den-layout）能在不加载贴图、不碰 DOM 的前提下
 * 断言「我用到的贴图 id 都真实存在」——L1 可直接测。
 */

export const ALL_GROUND_TEXTURE_IDS = [
  "grass",
  "stone-path",
  "dirt-path",
  "water",
  "cave-floor",
] as const;

export type AllGroundTextureId = (typeof ALL_GROUND_TEXTURE_IDS)[number];
