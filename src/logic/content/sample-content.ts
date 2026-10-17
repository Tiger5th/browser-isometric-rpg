/**
 * 完整示例内容包（票 35 起含第二区域「史莱姆巢穴」；含票 34/36 的等级曲线与新敌人）。
 *
 * 内容 JSON 本身就是纯数据，逻辑层与渲染层共用同一份组装结果，
 * 避免「测试里少配一个任务、场景里多配一个敌人」这类漂移。
 * 引用完整性由 L2（npm run content:lint）把关，这里只做类型转换。
 */

import denCullData from "../../../content/quests/den_cull.json";
import levelCurveData from "../../../content/level-curves/standard.json";
import slimeDenTemplateData from "../../../content/enemy-templates/slime_den.json";
import chargerTemplateData from "../../../content/enemy-templates/charger.json";
import slimeTemplateData from "../../../content/enemy-templates/slime.json";
import spitterTemplateData from "../../../content/enemy-templates/spitter.json";
import denChargerData from "../../../content/enemies/den_charger.json";
import denSpitterData from "../../../content/enemies/den_spitter.json";
import slimeDenBroodData from "../../../content/enemies/slime_den_brood.json";
import slimeDenCoreData from "../../../content/enemies/slime_den_core.json";
import slimeDenWatcherData from "../../../content/enemies/slime_den_watcher.json";
import slimeBlueData from "../../../content/enemies/slime_blue.json";
import slimeElderData from "../../../content/enemies/slime_elder.json";
import slimeMeadowData from "../../../content/enemies/slime_meadow.json";
import chargerMeadowData from "../../../content/enemies/charger_meadow.json";
import spitterPondData from "../../../content/enemies/spitter_pond.json";
import slimeCoreData from "../../../content/items/slime_core.json";
import healingHerbData from "../../../content/items/healing_herb.json";
import oldCoinData from "../../../content/items/old_coin.json";
import slimeGelData from "../../../content/items/slime_gel.json";
import travelerSwordData from "../../../content/items/traveler_sword.json";
import npcElderData from "../../../content/npcs/elder_ma.json";
import npcMerchantData from "../../../content/npcs/merchant_bo.json";
import npcScoutData from "../../../content/npcs/scout_lin.json";
import npcSmithData from "../../../content/npcs/smith_qi.json";
import cullSlimesData from "../../../content/quests/cull_slimes.json";
import greenHollowData from "../../../content/regions/green_hollow.json";
import slimeDenData from "../../../content/regions/slime_den.json";
import type { ContentBundle } from "./types";

export const SAMPLE_CONTENT_BUNDLE = {
  regions: [greenHollowData, slimeDenData],
  // 村庄 4 个 NPC（票 33）：马婆婆（任务）、林斥候（氛围）、老陶（商人）、铁七（铁匠/伏笔）。
  npcs: [npcElderData, npcScoutData, npcMerchantData, npcSmithData],
  enemyTemplates: [slimeTemplateData, slimeDenTemplateData, chargerTemplateData, spitterTemplateData],
  enemies: [
    slimeMeadowData,
    slimeBlueData,
    slimeElderData,
    chargerMeadowData,
    spitterPondData,
    slimeDenWatcherData,
    slimeDenBroodData,
    slimeDenCoreData,
    denChargerData,
    denSpitterData,
  ],
  items: [healingHerbData, oldCoinData, slimeGelData, slimeCoreData, travelerSwordData],
  quests: [cullSlimesData, denCullData],
  levelCurves: [levelCurveData],
} as unknown as ContentBundle;

export const GREEN_HOLLOW_REGION_ID = greenHollowData.id;
export const GREEN_HOLLOW_REGION = greenHollowData;
export const SLIME_DEN_REGION = slimeDenData;
export const SLIME_DEN_REGION_ID = slimeDenData.id;