import { describe, expect, test } from "bun:test";
import { Metrics } from "./metrics.ts";

describe("metrics registry", () => {
  test("counter increments and renders", () => {
    const m = new Metrics();
    const c = m.counter("roomy_test_total", "test counter", ["endpoint"]);
    c.inc({ endpoint: "/a" });
    c.inc({ endpoint: "/a" });
    c.inc({ endpoint: "/b" });
    const out = m.render();
    expect(out).toContain("# TYPE roomy_test_total counter");
    expect(out).toContain('roomy_test_total{endpoint="/a"} 2');
    expect(out).toContain('roomy_test_total{endpoint="/b"} 1');
  });

  test("gauge set and inc", () => {
    const m = new Metrics();
    const g = m.gauge("roomy_test_gauge", "test gauge", ["worker"]);
    g.set({ worker: "system" }, 8);
    g.inc({ worker: "system" }, 1);
    const out = m.render();
    expect(out).toContain("# TYPE roomy_test_gauge gauge");
    expect(out).toContain('roomy_test_gauge{worker="system"} 9');
  });

  test("histogram buckets, sum, count", () => {
    const m = new Metrics();
    const h = m.histogram("roomy_test_seconds", "test hist", ["endpoint"], [0.1, 0.5, 1]);
    h.observe({ endpoint: "/a" }, 0.05);
    h.observe({ endpoint: "/a" }, 0.2);
    h.observe({ endpoint: "/a" }, 2);
    const out = m.render();
    expect(out).toContain("# TYPE roomy_test_seconds histogram");
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="0.1"} 1');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="0.5"} 2');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="1"} 2');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="+Inf"} 3');
    expect(out).toContain('roomy_test_seconds_sum{endpoint="/a"} 2.25');
    expect(out).toContain('roomy_test_seconds_count{endpoint="/a"} 3');
  });

  test("empty registry renders empty string", () => {
    const m = new Metrics();
    expect(m.render()).toBe("");
  });
});
