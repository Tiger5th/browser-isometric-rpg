import { describe, expect, it } from "vitest";

import {
  assertValidMeasurementReport,
  createMeasurementReport,
  serializeMeasurementReport,
  type EnvironmentInfo,
} from "./report";

const environment: EnvironmentInfo = {
  userAgent: "vitest-agent/1.0",
  renderBackend: "webgl2",
  gpuRenderer: "Test GPU",
  capturedAt: "2026-10-17T04:00:00.000Z",
  devicePixelRatio: 2,
  hardwareConcurrency: 8,
};

describe("createMeasurementReport", () => {
  it("records the scenario, metrics, environment and elapsed time of a run", () => {
    const report = createMeasurementReport({
      scenario: "hello",
      environment,
      metrics: [
        { name: "drawCalls", value: 12, unit: "calls" },
        { name: "frameRate", value: 60, unit: "fps", threshold: 30, comparison: "gte" },
      ],
      startedAt: new Date("2026-10-17T04:00:00.000Z"),
      finishedAt: new Date("2026-10-17T04:00:01.500Z"),
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.harness).toBe("P0Harness");
    expect(report.scenario).toBe("hello");
    expect(report.durationMs).toBe(1500);
    expect(report.status).toBe("passed");
    expect(report.metrics).toEqual([
      { name: "drawCalls", value: 12, unit: "calls" },
      { name: "frameRate", value: 60, unit: "fps", threshold: 30, comparison: "gte", passed: true },
    ]);
    expect(report.environment).toEqual(environment);
  });
});

describe("assertValidMeasurementReport", () => {
  it("accepts a report created by the Harness", () => {
    const report = createMeasurementReport({
      scenario: "hello",
      environment,
      metrics: [{ name: "drawCalls", value: 12, unit: "calls" }],
      startedAt: new Date("2026-10-17T04:00:00.000Z"),
      finishedAt: new Date("2026-10-17T04:00:00.100Z"),
    });

    expect(() => assertValidMeasurementReport(report)).not.toThrow();
  });

  it("rejects a report whose metric value is not finite and names the field", () => {
    const report = createMeasurementReport({
      scenario: "hello",
      environment,
      metrics: [{ name: "drawCalls", value: 12, unit: "calls" }],
      startedAt: new Date("2026-10-17T04:00:00.000Z"),
      finishedAt: new Date("2026-10-17T04:00:00.100Z"),
    });
    report.metrics[0].value = Number.POSITIVE_INFINITY;

    expect(() => assertValidMeasurementReport(report)).toThrow("metrics[0].value");
  });

  it("rejects a report without a scenario name", () => {
    const report = createMeasurementReport({
      scenario: "hello",
      environment,
      metrics: [{ name: "drawCalls", value: 12, unit: "calls" }],
      startedAt: new Date("2026-10-17T04:00:00.000Z"),
      finishedAt: new Date("2026-10-17T04:00:00.100Z"),
    });
    report.scenario = "  ";

    expect(() => assertValidMeasurementReport(report)).toThrow("scenario");
  });
});

describe("serializeMeasurementReport", () => {
  it("emits stable JSON with metrics sorted by name", () => {
    const report = createMeasurementReport({
      scenario: "hello",
      environment,
      metrics: [
        { name: "timeToFirstFrame", value: 120, unit: "ms" },
        { name: "drawCalls", value: 12, unit: "calls" },
      ],
      startedAt: new Date("2026-10-17T04:00:00.000Z"),
      finishedAt: new Date("2026-10-17T04:00:00.100Z"),
    });

    const json = serializeMeasurementReport(report);

    expect(json.endsWith("\n")).toBe(true);
    expect(json).toBe(serializeMeasurementReport(report));
    const parsed = JSON.parse(json) as typeof report;
    expect(parsed.scenario).toBe("hello");
    expect(parsed.metrics.map((metric) => metric.name)).toEqual([
      "drawCalls",
      "timeToFirstFrame",
    ]);
  });
});
