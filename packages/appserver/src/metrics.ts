/**
 * Minimal Prometheus text-format metrics registry.
 *
 * The appserver exposes a `/metrics` endpoint (Prometheus scrape) so the
 * observability stack can collect the signals that diagnose pool saturation
 * and N+1 bottlenecks: request latency by endpoint, DB pool queue depth per
 * worker, query-cache hit rate, embed backlog, and DB request timeouts.
 * Alloy scrapes it and remote-writes to Grafana Cloud Mimir (see
 * deploy/alloy/config.alloy).
 *
 * Deliberately dependency-free and synchronous: `render()` is a pure string
 * build, so the scrape path never touches a DB worker or the event loop.
 */

export type LabelSet = Record<string, string>;

type FamilyType = "counter" | "gauge" | "histogram";

interface Family {
  name: string;
  help: string;
  type: FamilyType;
  labelNames: string[];
}

interface CounterFamily extends Family {
  type: "counter";
  values: Map<string, { labels: LabelSet; value: number }>;
}

interface GaugeFamily extends Family {
  type: "gauge";
  values: Map<string, { labels: LabelSet; value: number }>;
}

interface HistogramFamily extends Family {
  type: "histogram";
  buckets: number[];
  values: Map<string, { labels: LabelSet; counts: number[]; sum: number; count: number }>;
}

type AnyFamily = CounterFamily | GaugeFamily | HistogramFamily;

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function labelKey(labelNames: string[], labels: LabelSet): string {
  return labelNames.map((n) => String(labels[n] ?? "")).join("\u0000");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labelNames: string[], labels: LabelSet): string {
  if (labelNames.length === 0) return "";
  return labelNames.map((n) => `${n}="${escapeLabel(labels[n] ?? "")}"`).join(",");
}

export interface CounterHandle {
  inc(labels?: LabelSet, n?: number): void;
}
export interface GaugeHandle {
  set(labels: LabelSet, value: number): void;
  inc(labels?: LabelSet, n?: number): void;
}
export interface HistogramHandle {
  observe(labels: LabelSet, value: number): void;
}

export class Metrics {
  private families = new Map<string, AnyFamily>();

  counter(name: string, help: string, labelNames: string[] = []): CounterHandle {
    const fam: CounterFamily = { name, help, type: "counter", labelNames, values: new Map() };
    this.families.set(name, fam);
    return {
      inc: (labels: LabelSet = {}, n = 1) => {
        const key = labelKey(labelNames, labels);
        const cur = fam.values.get(key);
        if (cur) cur.value += n;
        else fam.values.set(key, { labels, value: n });
      },
    };
  }

  gauge(name: string, help: string, labelNames: string[] = []): GaugeHandle {
    const fam: GaugeFamily = { name, help, type: "gauge", labelNames, values: new Map() };
    this.families.set(name, fam);
    return {
      set: (labels: LabelSet = {}, value: number) => {
        const key = labelKey(labelNames, labels);
        fam.values.set(key, { labels, value });
      },
      inc: (labels: LabelSet = {}, n = 1) => {
        const key = labelKey(labelNames, labels);
        const cur = fam.values.get(key);
        if (cur) cur.value += n;
        else fam.values.set(key, { labels, value: n });
      },
    };
  }

  histogram(
    name: string,
    help: string,
    labelNames: string[] = [],
    buckets: number[] = DEFAULT_BUCKETS,
  ): HistogramHandle {
    const fam: HistogramFamily = { name, help, type: "histogram", labelNames, buckets, values: new Map() };
    this.families.set(name, fam);
    return {
      observe: (labels: LabelSet = {}, value: number) => {
        const key = labelKey(labelNames, labels);
        let h = fam.values.get(key);
        if (!h) {
          h = { labels, counts: new Array(fam.buckets.length).fill(0), sum: 0, count: 0 };
          fam.values.set(key, h);
        }
        h.count += 1;
        h.sum += value;
        for (let i = 0; i < fam.buckets.length; i++) {
          if (value <= fam.buckets[i]!) h.counts[i]! += 1;
        }
      },
    };
  }

  /** Render all families in Prometheus text exposition format. */
  render(): string {
    if (this.families.size === 0) return "";
    const lines: string[] = [];
    for (const fam of this.families.values()) {
      lines.push(`# HELP ${fam.name} ${fam.help}`);
      lines.push(`# TYPE ${fam.name} ${fam.type}`);
      if (fam.type === "histogram") {
        for (const h of fam.values.values()) {
          const base = formatLabels(fam.labelNames, h.labels);
          const prefix = base === "" ? "{" : `{${base},`;
          for (let i = 0; i < fam.buckets.length; i++) {
            lines.push(`${fam.name}_bucket${prefix}le="${fam.buckets[i]}"} ${h.counts[i]}`);
          }
          lines.push(`${fam.name}_bucket${prefix}le="+Inf"} ${h.count}`);
          lines.push(`${fam.name}_sum${base === "" ? "" : `{${base}}`} ${h.sum}`);
          lines.push(`${fam.name}_count${base === "" ? "" : `{${base}}`} ${h.count}`);
        }
      } else {
        for (const v of fam.values.values()) {
          const labels = formatLabels(fam.labelNames, v.labels);
          lines.push(`${fam.name}${labels === "" ? "" : `{${labels}}`} ${v.value}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  /** Test-only: clear all families. */
  reset(): void {
    this.families.clear();
  }
}

/** Process-wide singleton used by the appserver. */
export const metrics = new Metrics();
