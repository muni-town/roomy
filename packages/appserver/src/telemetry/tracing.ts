/**
 * OpenTelemetry tracing for the appserver.
 *
 * Exports OTLP traces to the Alloy collector (deploy/alloy/config.alloy),
 * which forwards them to Grafana Cloud Tempo. Disabled unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set — the default is a no-op: no SDK is
 * constructed, no timer runs, and `withSpan` still executes its callback
 * (the `@opentelemetry/api` tracer is a no-op until a provider is
 * registered, at ~2µs per span). This mirrors `telemetry/loki.ts`, so a
 * deployment that doesn't want traces pays nothing for them.
 *
 * Endpoint resolution: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used verbatim)
 * takes precedence over the base `OTEL_EXPORTER_OTLP_ENDPOINT` (to which
 * `/v1/traces` is appended), matching the OTel spec. This lets the standard
 * Grafana Cloud env vars work unchanged.
 *
 * Sampling defaults to 100% (`OTEL_TRACES_SAMPLER_ARG` scales it). Traces
 * are sampled per-request at the root span and the decision is inherited by
 * children (`ParentBasedSampler`), so a request is traced end-to-end or not
 * at all.
 */

import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  AlwaysOnSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { resolveEnvName } from "./build.ts";

const SERVICE_NAME = "appserver";

let provider: BasicTracerProvider | null = null;
let initialised = false;

/**
 * Resolve the OTLP/HTTP traces endpoint from env, or null when tracing is
 * off. Signal-specific wins over the base endpoint (OTel spec §exporter).
 */
export function resolveTraceEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const signalSpecific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (signalSpecific) return signalSpecific;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/v1/traces`;
}

function resolveSampler(env: NodeJS.ProcessEnv): Sampler {
  // Default to always-on: these are three low-volume endpoints and the whole
  // point is to see slow requests, not a statistical sample of them. A
  // deployment can dial it down with the standard OTel env vars.
  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  const clamp = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1;
  return clamp >= 1
    ? new AlwaysOnSampler()
    : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(clamp) });
}

/**
 * Start the tracer provider. Idempotent, and a no-op when no endpoint is
 * configured. Returns true when tracing is active.
 *
 * Called from `createAppserver` so the provider is installed before any
 * request is served; a process that never calls it (most unit tests) keeps
 * the zero-cost default.
 */
export function initTracing(env: NodeJS.ProcessEnv = process.env): boolean {
  if (initialised) return provider !== null;
  initialised = true;

  const endpoint = resolveTraceEndpoint(env);
  if (!endpoint) return false;

  // Context propagation across await boundaries is what makes child spans
  // (and the trace-context log correlation below) work — without it every
  // span would be its own root.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    // Read from the `env` argument, not `process.env`: a test that inits
    // tracing with an explicit env expects the whole resource to follow it.
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: resolveEnvName(env),
    ...(process.env.RAILWAY_SERVICE_NAME
      ? { [ATTR_SERVICE_VERSION]: process.env.RAILWAY_SERVICE_NAME }
      : {}),
    ...(process.env.RAILWAY_REPLICA_ID
      ? { "service.instance.id": process.env.RAILWAY_REPLICA_ID }
      : {}),
  });

  provider = new BasicTracerProvider({
    resource,
    sampler: resolveSampler(env),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: endpoint,
          // A dead collector must not pile up spans in memory. The batch
          // processor drops on overflow by default and never throws into
          // request handling.
        }),
      ),
    ],
  });

  trace.setGlobalTracerProvider(provider);
  return true;
}

/**
 * The tracer `withSpan` opens spans with. Tests substitute their own so a
 * handler's span and its attributes can be asserted without installing a
 * process-global provider — registration is one-shot per process, so a second
 * test file doing that would capture or silence the first one's spans.
 */
let tracer: Tracer = trace.getTracer(SERVICE_NAME);

/** Test-only: replace `withSpan`'s tracer, or pass null to restore it. */
export function _setTestSpanTracer(replacement: Tracer | null): void {
  tracer = replacement ?? trace.getTracer(SERVICE_NAME);
}

/** True when a tracer provider is installed (spans are being recorded). */
export const isTracingEnabled = (): boolean => provider !== null;

/** The tracer handlers use for ad-hoc `setAttribute`/`addEvent` calls. */
export { tracer };

/**
 * Run `fn` inside a span. The span is ended (and errors recorded) in a
 * finally block, so a throwing handler still produces a span carrying the
 * failure.
 *
 * With tracing unconfigured this still calls `fn` but allocates no SDK
 * state — the no-op tracer returns a non-recording span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}


/**
 * The active span's trace/span IDs — used by `log.ts` to stamp log records
 * so Grafana can pivot from a log line to its trace. Returns null when no
 * span is active (tracing off, or outside a request).
 */
export function currentTraceContext(): {
  traceId: string;
  spanId: string;
} | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  // A no-op span reports an all-zero trace id; treat that as "no trace".
  if (ctx.traceId === "00000000000000000000000000000000") return null;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/**
 * Flush buffered spans and shut the provider down. Awaited during appserver
 * close so spans produced by in-flight requests are not lost on redeploy.
 */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  const p = provider;
  provider = null;
  try {
    await p.shutdown();
  } catch {
    // Shutdown must never break teardown; a failed flush is reported by the
    // collector side, not fatal here.
  }
}

/** Test-only: reset module state so a test can re-init with new env. */
export function _resetTracing(): void {
  provider = null;
  initialised = false;
}
