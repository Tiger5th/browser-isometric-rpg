import type { P0Harness } from "../harness";
import { helloScenario } from "./hello";
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
}
