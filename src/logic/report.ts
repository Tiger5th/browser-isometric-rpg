/**
 * P0Harness 测量报告：零引擎依赖的纯 TypeScript 模块。
 * 报告 schema 同时供渲染层场景与后续 L5 夜测复用。
 */

export type RenderBackend = "webgl2" | "webgl1" | "webgpu" | "unknown";

export interface EnvironmentInfo {
  /** 浏览器 User-Agent。 */
  userAgent: string;
  /** Babylon 实际使用的渲染后端。 */
  renderBackend: RenderBackend;
  /** WebGL 报告的 GPU 渲染器字符串；WebGPU 下可为 null。 */
  gpuRenderer: string | null;
  /** 环境信息采集时刻（ISO 8601）。 */
  capturedAt: string;
  devicePixelRatio: number;
  hardwareConcurrency: number;
}

export type MetricComparison = "lte" | "gte" | "eq";

export interface Metric {
  name: string;
  value: number;
  unit: string;
  threshold?: number;
  comparison?: MetricComparison;
  passed?: boolean;
}

export type ReportStatus = "passed" | "failed";

export interface MeasurementReport {
  schemaVersion: 1;
  harness: "P0Harness";
  scenario: string;
  status: ReportStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: EnvironmentInfo;
  metrics: Metric[];
}

export interface CreateMeasurementReportInput {
  scenario: string;
  environment: EnvironmentInfo;
  metrics: Metric[];
  startedAt: Date;
  finishedAt?: Date;
}

function judgeMetric(metric: Metric): Metric {
  if (metric.threshold === undefined || metric.comparison === undefined) {
    return { ...metric };
  }

  const passed =
    metric.comparison === "gte"
      ? metric.value >= metric.threshold
      : metric.comparison === "lte"
        ? metric.value <= metric.threshold
        : metric.value === metric.threshold;

  return { ...metric, passed };
}

export function createMeasurementReport(
  input: CreateMeasurementReportInput,
): MeasurementReport {
  const finishedAt = input.finishedAt ?? new Date();
  const metrics = input.metrics.map(judgeMetric);
  const status: ReportStatus = metrics.some((metric) => metric.passed === false)
    ? "failed"
    : "passed";

  return {
    schemaVersion: 1,
    harness: "P0Harness",
    scenario: input.scenario,
    status,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - input.startedAt.getTime(),
    environment: { ...input.environment },
    metrics,
  };
}

export class ReportValidationError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "ReportValidationError";
  }
}

const RENDER_BACKENDS: readonly RenderBackend[] = ["webgl2", "webgl1", "webgpu", "unknown"];
const COMPARISONS: readonly MetricComparison[] = ["lte", "gte", "eq"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReportValidationError(path, "必须是非空字符串");
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReportValidationError(path, "必须是有限数值");
  }
  return value;
}

function requireIsoTimestamp(value: unknown, path: string): number {
  requireNonEmptyString(value, path);
  const timestamp = Date.parse(value as string);
  if (Number.isNaN(timestamp)) {
    throw new ReportValidationError(path, "必须是可解析的 ISO 8601 时间戳");
  }
  return timestamp;
}

/** 校验报告结构；不合法时抛出带字段路径的 ReportValidationError。 */
export function assertValidMeasurementReport(
  report: unknown,
): asserts report is MeasurementReport {
  if (!isRecord(report)) {
    throw new ReportValidationError("report", "必须是对象");
  }
  if (report.schemaVersion !== 1) {
    throw new ReportValidationError("schemaVersion", "当前只支持版本 1");
  }
  if (report.harness !== "P0Harness") {
    throw new ReportValidationError("harness", "必须为 P0Harness");
  }
  requireNonEmptyString(report.scenario, "scenario");
  if (report.status !== "passed" && report.status !== "failed") {
    throw new ReportValidationError("status", "必须为 passed 或 failed");
  }

  const startedAt = requireIsoTimestamp(report.startedAt, "startedAt");
  const finishedAt = requireIsoTimestamp(report.finishedAt, "finishedAt");
  if (finishedAt < startedAt) {
    throw new ReportValidationError("finishedAt", "不能早于 startedAt");
  }
  if (requireFiniteNumber(report.durationMs, "durationMs") < 0) {
    throw new ReportValidationError("durationMs", "不能为负数");
  }

  const environment = report.environment;
  if (!isRecord(environment)) {
    throw new ReportValidationError("environment", "必须是对象");
  }
  requireNonEmptyString(environment.userAgent, "environment.userAgent");
  if (!RENDER_BACKENDS.includes(environment.renderBackend as RenderBackend)) {
    throw new ReportValidationError(
      "environment.renderBackend",
      `必须为 ${RENDER_BACKENDS.join(" / ")}`,
    );
  }
  if (environment.gpuRenderer !== null && typeof environment.gpuRenderer !== "string") {
    throw new ReportValidationError("environment.gpuRenderer", "必须是字符串或 null");
  }
  requireIsoTimestamp(environment.capturedAt, "environment.capturedAt");
  if (requireFiniteNumber(environment.devicePixelRatio, "environment.devicePixelRatio") <= 0) {
    throw new ReportValidationError("environment.devicePixelRatio", "必须大于 0");
  }
  const hardwareConcurrency = requireFiniteNumber(
    environment.hardwareConcurrency,
    "environment.hardwareConcurrency",
  );
  if (!Number.isInteger(hardwareConcurrency) || hardwareConcurrency < 1) {
    throw new ReportValidationError(
      "environment.hardwareConcurrency",
      "必须是大于 0 的整数",
    );
  }

  const metrics = report.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new ReportValidationError("metrics", "必须是非空数组");
  }

  const names = new Set<string>();
  metrics.forEach((metric, index) => {
    const path = `metrics[${index}]`;
    if (!isRecord(metric)) {
      throw new ReportValidationError(path, "必须是对象");
    }
    const name = requireNonEmptyString(metric.name, `${path}.name`);
    if (names.has(name)) {
      throw new ReportValidationError(`${path}.name`, `指标名重复：${name}`);
    }
    names.add(name);
    requireFiniteNumber(metric.value, `${path}.value`);
    requireNonEmptyString(metric.unit, `${path}.unit`);

    const hasThreshold = metric.threshold !== undefined;
    const hasComparison = metric.comparison !== undefined;
    if (hasThreshold !== hasComparison) {
      throw new ReportValidationError(
        path,
        "threshold 与 comparison 必须同时出现或同时缺省",
      );
    }
    if (hasThreshold) {
      requireFiniteNumber(metric.threshold, `${path}.threshold`);
    }
    if (hasComparison && !COMPARISONS.includes(metric.comparison as MetricComparison)) {
      throw new ReportValidationError(
        `${path}.comparison`,
        `必须为 ${COMPARISONS.join(" / ")}`,
      );
    }
    if (metric.passed !== undefined && typeof metric.passed !== "boolean") {
      throw new ReportValidationError(`${path}.passed`, "必须是布尔值");
    }
  });

  const hasFailedMetric = metrics.some(
    (metric) => isRecord(metric) && metric.passed === false,
  );
  if (hasFailedMetric && report.status !== "failed") {
    throw new ReportValidationError("status", "存在未达标指标时必须为 failed");
  }
}

/**
 * 输出确定性 JSON（固定字段顺序、指标按名称排序、末尾换行），
 * 便于报告文件 diff 与后续 L5 夜测归档。
 */
export function serializeMeasurementReport(report: MeasurementReport): string {
  assertValidMeasurementReport(report);

  const normalized: MeasurementReport = {
    schemaVersion: 1,
    harness: "P0Harness",
    scenario: report.scenario,
    status: report.status,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    environment: {
      userAgent: report.environment.userAgent,
      renderBackend: report.environment.renderBackend,
      gpuRenderer: report.environment.gpuRenderer,
      capturedAt: report.environment.capturedAt,
      devicePixelRatio: report.environment.devicePixelRatio,
      hardwareConcurrency: report.environment.hardwareConcurrency,
    },
    metrics: [...report.metrics]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map((metric) => ({
        name: metric.name,
        value: metric.value,
        unit: metric.unit,
        ...(metric.threshold !== undefined ? { threshold: metric.threshold } : {}),
        ...(metric.comparison !== undefined ? { comparison: metric.comparison } : {}),
        ...(metric.passed !== undefined ? { passed: metric.passed } : {}),
      })),
  };

  return `${JSON.stringify(normalized, null, 2)}\n`;
}
