import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";

import {
  assertValidMeasurementReport,
  createMeasurementReport,
  serializeMeasurementReport,
  type MeasurementReport,
  type Metric,
} from "../logic/report";
import { collectEnvironmentInfo } from "./environment";

/**
 * 单个 Harness 场景可用的上下文。
 * regions / entities 是 11–17 号票的扩展点：场景登记后即可进入报告。
 */
export interface ScenarioContext {
  readonly scene: Scene;
  readonly engine: AbstractEngine;
  readonly regions: ReadonlySet<string>;
  readonly entities: ReadonlySet<string>;
  registerRegion(regionId: string): void;
  registerEntity(entityId: string): void;
  /** 场景自行追加指标（例如后续性能场景的帧时间）。 */
  addMetric(metric: Metric): void;
}

export interface ScenarioDefinition {
  /** 场景在 Harness 中的唯一具名标识。 */
  name: string;
  description: string;
  /**
   * 交互式场景：measure 结束后保留场景（点击/动画可继续演示），
   * 直到运行下一个 scenario 或显式调用 disposeActiveScenario 时才执行 teardown。
   */
  interactive?: boolean;
  setup(context: ScenarioContext): void | Promise<void>;
  measure(context: ScenarioContext): Metric[] | Promise<Metric[]>;
  teardown?(context: ScenarioContext): void | Promise<void>;
}

export interface ScenarioSummary {
  name: string;
  description: string;
}

interface MutableScenarioContext extends ScenarioContext {
  regions: Set<string>;
  entities: Set<string>;
  metrics: Metric[];
}

function createScenarioContext(scene: Scene, engine: AbstractEngine): MutableScenarioContext {
  const regions = new Set<string>();
  const entities = new Set<string>();
  const metrics: Metric[] = [];

  return {
    scene,
    engine,
    regions,
    entities,
    metrics,
    registerRegion: (regionId) => {
      regions.add(regionId);
    },
    registerEntity: (entityId) => {
      entities.add(entityId);
    },
    addMetric: (metric) => {
      metrics.push(metric);
    },
  };
}

/**
 * P0Harness：注册具名 scenario，统一执行并输出 JSON 测量报告。
 * 渲染类场景由浏览器驱动（ego-browser）；报告格式为后续 L5 夜测复用。
 */
export class P0Harness {
  private readonly scenarios = new Map<string, ScenarioDefinition>();
  private lastReport: MeasurementReport | null = null;
  private activeScenario: {
    definition: ScenarioDefinition;
    context: MutableScenarioContext;
  } | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly engine: AbstractEngine,
  ) {}

  registerScenario(scenario: ScenarioDefinition): void {
    if (scenario.name.trim() === "") {
      throw new Error("scenario 必须有非空名称");
    }
    if (this.scenarios.has(scenario.name)) {
      throw new Error(`scenario 已注册：${scenario.name}`);
    }
    this.scenarios.set(scenario.name, scenario);
  }

  listScenarios(): ScenarioSummary[] {
    return [...this.scenarios.values()].map(({ name, description }) => ({ name, description }));
  }

  getLastReport(): MeasurementReport | null {
    return this.lastReport;
  }

  serialize(report: MeasurementReport): string {
    return serializeMeasurementReport(report);
  }

  /** 交互式场景的延迟 teardown；运行其它场景或页面卸载时调用。 */
  async disposeActiveScenario(): Promise<void> {
    const active = this.activeScenario;
    if (!active) {
      return;
    }
    this.activeScenario = null;
    await active.definition.teardown?.(active.context);
  }

  async runScenario(name: string): Promise<MeasurementReport> {
    const scenario = this.scenarios.get(name);
    if (!scenario) {
      throw new Error(`未知 scenario：${name}`);
    }

    await this.disposeActiveScenario();

    const startedAt = new Date();
    const context = createScenarioContext(this.scene, this.engine);
    let keepAlive = false;

    try {
      await scenario.setup(context);
      const scenarioMetrics = await scenario.measure(context);

      const report = createMeasurementReport({
        scenario: scenario.name,
        environment: collectEnvironmentInfo(this.engine),
        metrics: [...context.metrics, ...scenarioMetrics],
        startedAt,
      });
      assertValidMeasurementReport(report);
      this.lastReport = report;

      if (scenario.interactive) {
        keepAlive = true;
        this.activeScenario = { definition: scenario, context };
      }

      return report;
    } finally {
      if (!keepAlive) {
        await scenario.teardown?.(context);
      }
    }
  }
}
