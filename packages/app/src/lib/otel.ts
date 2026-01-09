import {
  BaseInstrumentation,
  BaseTransport,
  getWebInstrumentations,
  initializeFaro as init,
  LogLevel,
  TransportItemType,
  type TransportItem,
} from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { CONFIG } from "./config";

let telemetryDisabled = false;
let failureCount = 0;
const MAX_FAILURES = 3;

type WorkerInfo =
  | {
      worker: "main";
    }
  | {
      worker: "sqlite";
    }
  | {
      worker: "backend";
    };

class CustomConsoleInstrumentation extends BaseInstrumentation {
  readonly name = "@muni-town/roomy:instrumentation-console";
  readonly version = "0.1";

  initialize() {
    const levels = [
      "trace",
      "debug",
      "log",
      "info",
      "warn",
      "error",
    ] as LogLevel[];
    const telemetryLevels = ["info", "warn", "error"];
    const origConsoleFns: { [key: string]: (...args: any[]) => void } = {};
    levels.forEach((level) => {
      origConsoleFns[level] = console[level];
      /* eslint-disable-next-line no-console */
      console[level] = (...args) => {
        if (telemetryLevels.includes(level)) {
          if (
            args.length == 2 &&
            typeof args[0] == "string" &&
            typeof args[1] == "object"
          ) {
            this.api.pushLog([args[0]], {
              level,
              context: args[1],
            });

            const span = trace.getActiveSpan();
            if (span) {
              if (level == "error") {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: args[0],
                });
              }
              span.addEvent(args[0], { level, ...args[1] });
            }
          } else {
            const logArgs = args.map((x) =>
              typeof x == "string" ? x : JSON.stringify(x),
            );
            this.api.pushLog(logArgs, {
              level,
            });
            const span = trace.getActiveSpan();
            if (span) {
              if (level == "error") {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: logArgs.join(" "),
                });
              }
              span.addEvent(logArgs.join(" "), { level });
            }
          }
        }

        if (level == "info") {
          origConsoleFns[level]!(
            ...args.flatMap((x) =>
              typeof x == "string" && !x.includes("%c")
                ? ["%c" + x, "color:MediumSeaGreen"]
                : [x],
            ),
          );
        } else if (level == "debug" || level == "trace") {
          origConsoleFns[level]!(
            ...args.flatMap((x) =>
              typeof x == "string" && !x.includes("%c")
                ? ["%c" + x, "color:gray"]
                : [x],
            ),
          );
        } else {
          origConsoleFns[level]!(...args);
        }
      };
    });
  }
}

export function initializeFaro(opts: WorkerInfo) {
  if (CONFIG.faroEndpoint) {
    init({
      app: { name: "roomy", version: __APP_VERSION__ },
      dedupe: false,
      globalObjectKey: "faro",
      transports: [new ResilientFetchTransport()],
      beforeSend(event) {
        // If telemetry has been disabled due to blocked requests, drop all events
        if (telemetryDisabled) {
          return null;
        }

        if ("context" in event.payload) {
          event.payload.context = {
            ...(event.payload.context || {}),
            worker: opts.worker,
          };
        } else if ("resourceSpans" in event.payload) {
          event.payload.resourceSpans?.forEach((span) => {
            span.resource?.attributes.push({
              key: "app.worker",
              value: { stringValue: opts.worker },
            });
            if (event.meta.session?.id) {
              span.resource?.attributes.push({
                key: "session.id",
                value: { stringValue: event.meta.session?.id },
              });
            }
          });
        }
        return event;
      },
      instrumentations: [
        ...(opts.worker == "main"
          ? [
              ...getWebInstrumentations({
                captureConsole: false,
              }),
            ]
          : []),
        new CustomConsoleInstrumentation(),
        new TracingInstrumentation({
          contextManager: new ZoneContextManager(),
        }),
      ],
    });
  }

  faro?.api.setSession({ attributes: { isSampled: "true" } });

  (globalThis as any).tracer = faro?.api
    .getOTEL()
    ?.trace.getTracer("roomy", __APP_VERSION__);
}

class ResilientFetchTransport extends BaseTransport {
  readonly name = "resilient-fetch";
  readonly version = "0.1";

  override send(items: TransportItem | TransportItem[]): void {
    const payload = this.makePayload(Array.isArray(items) ? items : [items]);
    if (!payload) return;

    fetch(CONFIG.faroEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "bad_api_key",
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      failureCount++;
      if (failureCount >= MAX_FAILURES && faro) {
        faro.pause();
        console.debug("Telemetry paused due to blocked requests");
      }
    });
  }

  private makePayload(items: TransportItem[]) {
    if (items.length === 0) return null;

    const body: Record<string, unknown> = { meta: items[0]!.meta };

    for (const item of items) {
      const key = this.getPayloadKey(item.type);
      if (key) {
        (body[key] ??= [] as unknown[]) as unknown[];
        (body[key] as unknown[]).push(item.payload);
      }
    }
    return body;
  }

  private getPayloadKey(type: TransportItemType): string | null {
    return type;
  }

  override getIgnoreUrls() {
    return [CONFIG.faroEndpoint];
  }

  override isBatched() {
    return false;
  }
}

export async function trackUncaughtExceptions<T>(
  f: () => T,
): Promise<Awaited<T> | undefined> {
  const ctx = context.active();
  try {
    return await f();
  } catch (e) {
    console.error("Otel Uncaught:", e);
    context.with(ctx, () => {
      const span = trace.getActiveSpan();
      if (span) {
        if (e instanceof Error) {
          span.recordException(e);
        }
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
    });
  }
}
