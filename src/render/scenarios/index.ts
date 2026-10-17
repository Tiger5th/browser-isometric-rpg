import type { P0Harness } from "../harness";
import { animePipelineScenario } from "./animePipeline";
import { assetPipelineScenario } from "./assetPipeline";
import { charactersScenario } from "./characters";
import { clickMoveScenario } from "./click-move";
import { combatLoopScenario } from "./combat-loop";
import { crowdHotSwapScenario } from "./crowd-hot-swap";
import { crowdNavScenario } from "./crowd-nav";
import { helloScenario } from "./hello";
import { occlusionOutlineScenario } from "./occlusion-outline";
import { regionGateScenario } from "./regionGate";
import { regionLoadingScenario } from "./regionLoading";

/**
 * 内置 scenario 注册表。
 * 11–17 号票在此追加各自的验证场景；Harness 本身不需要改动。
 */
export function registerBuiltinScenarios(harness: P0Harness): void {
  harness.registerScenario(helloScenario);
  harness.registerScenario(regionLoadingScenario);
  harness.registerScenario(regionGateScenario);
  harness.registerScenario(charactersScenario);
  harness.registerScenario(crowdNavScenario);
  harness.registerScenario(clickMoveScenario);
  harness.registerScenario(combatLoopScenario);
  harness.registerScenario(crowdHotSwapScenario);
  harness.registerScenario(assetPipelineScenario);
  harness.registerScenario(animePipelineScenario);
  harness.registerScenario(occlusionOutlineScenario);
}
