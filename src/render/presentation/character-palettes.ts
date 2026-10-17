/**
 * 角色色板卡运行时桥接（票 29）。
 *
 * content/character-palettes/*.json 是「合同」：3D 贴图、立绘、头像
 * 全部按同一张卡生成（见 GLOSSARY「角色色板卡」）。本模块把 JSON 数据
 * 接进表现层：
 * - NPC 3D tint：paletteOf(npcId).primary；
 * - 对话框/名牌/立绘描边：同一张卡的 primary；
 * - 立绘图片：NPC 定义的 portrait.image；资源未生成时为 undefined，
 *   UI 用主色程序化色块占位（见 dialogue-portrait.ts）。
 *
 * 立绘图片通过 Vite 的 glob 导入解析 URL；assets/portraits/ 为空时
 * （生图待办）解析结果为空表，调用方按「无立绘」走占位路径。
 */

import elderMaPalette from "../../../content/character-palettes/elder_ma.json";
import merchantBoPalette from "../../../content/character-palettes/merchant_bo.json";
import playerHeroPalette from "../../../content/character-palettes/player_hero.json";
import scoutLinPalette from "../../../content/character-palettes/scout_lin.json";
import smithQiPalette from "../../../content/character-palettes/smith_qi.json";
import type { CharacterPaletteDefinition } from "../../logic/content/types";

const PALETTES = [
  elderMaPalette,
  playerHeroPalette,
  scoutLinPalette,
  // 票 33：村庄补齐 4 个 NPC（商人老陶 + 铁匠铁七）。
  merchantBoPalette,
  smithQiPalette,
] as CharacterPaletteDefinition[];

/** 色板卡 id → 定义。 */
export const CHARACTER_PALETTES: ReadonlyMap<string, CharacterPaletteDefinition> = new Map(
  PALETTES.map((palette) => [palette.id, palette]),
);

/** NPC 实体 id → 色板卡 id（与 content/npcs/*.json 的 paletteId 对应）。 */
const NPC_PALETTE_IDS: ReadonlyMap<string, string> = new Map([
  ["npc:elder_ma", "character_palette:elder_ma"],
  ["npc:scout_lin", "character_palette:scout_lin"],
  ["npc:merchant_bo", "character_palette:merchant_bo"],
  ["npc:smith_qi", "character_palette:smith_qi"],
]);

/** 玩家实体的色板卡 id（玩家没有 npc 定义，固定挂主角卡）。 */
export const PLAYER_PALETTE_ID = "character_palette:player_hero";

/** 表现层使用的角色色板（主色是 tint/描边/名牌的唯一起源）。 */
export interface CharacterPalette {
  primary: string;
  secondary: string;
  accent: string;
}

/** 取实体的角色色板；未知实体回落到玩家卡（画面不会出现无色块）。 */
export function paletteOf(entityId: string): CharacterPalette {
  const paletteId = NPC_PALETTE_IDS.get(entityId) ?? PLAYER_PALETTE_ID;
  const definition = CHARACTER_PALETTES.get(paletteId);
  return {
    primary: definition?.primary ?? "#7dd3fc",
    secondary: definition?.secondary ?? "#1e3a5f",
    accent: definition?.accent ?? "#fbbf24",
  };
}

/**
 * 立绘文件 → 实体 id 的映射。文件按色板卡 id 的本地部分命名：
 * character-palettes/elder_ma.json ↔ assets/portraits/elder_ma.png ↔ npc:elder_ma；
 * player_hero.png 对应玩家实体（玩家没有 npc 定义，固定挂主角卡）。
 */
const PORTRAIT_FILES: ReadonlyMap<string, string> = new Map([
  ["npc:elder_ma", "elder_ma.png"],
  ["npc:scout_lin", "scout_lin.png"],
  // 票 33：新 NPC 立绘尚未出图，缺省走主色程序化占位（同色板卡主色）。
  ["npc:merchant_bo", "merchant_bo.png"],
  ["npc:smith_qi", "smith_qi.png"],
  ["entity:player", "player_hero.png"],
]);

const PORTRAIT_URLS: ReadonlyMap<string, string> = (() => {
  const files = import.meta.glob("../../../assets/portraits/*.png", {
    eager: true,
    query: "?url",
    import: "default",
  }) as Record<string, string>;
  const byEntity = new Map<string, string>();
  for (const [entityId, fileName] of PORTRAIT_FILES) {
    const entry = Object.entries(files).find(([path]) => path.endsWith(`/${fileName}`));
    if (entry !== undefined) {
      byEntity.set(entityId, entry[1]);
    }
  }
  return byEntity;
})();

/** 取实体的立绘 URL；资源尚未生成时返回 undefined（占位路径）。 */
export function portraitUrlOf(entityId: string): string | undefined {
  return PORTRAIT_URLS.get(entityId);
}
