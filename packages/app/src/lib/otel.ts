import {
  ConsoleInstrumentation,
  type Faro,
  getWebInstrumentations,
  initializeFaro as init,
} from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import type { Tracer } from "@opentelemetry/api";

type WorkerInfo =
  | {
      worker: "main";
    }
  | {
      worker: "sqlite";
    };

export function initializeFaro(opts: WorkerInfo): Faro & { tracer: Tracer } {
  const faro = init({
    app: { name: "roomy", version: __APP_VERSION__ },
    apiKey: "bad_api_key",
    url: "http://localhost:12345/collect",
    dedupe: false,
    logArgsSerializer(args) {
      return args
        .map((x) => {
          try {
            return typeof x == "string" ? x : JSON.stringify(x);
          } catch (e) {
            return "[serialization failed]";
          }
        })
        .join(" ");
    },
    beforeSend(event) {
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
        });
      }
      return event;
    },
    instrumentations: [
      ...(opts.worker == "main"
        ? getWebInstrumentations()
        : [new ConsoleInstrumentation()]),
      new TracingInstrumentation(),
    ],
  });

  if (opts.worker == "sqlite") {
    // TODO: we need to get the session info from the main thread.
    faro.api.setSession({
      attributes: { isSampled: "true" },
    });
  }

  (faro as any).tracer = faro.api
    .getOTEL()!
    .trace.getTracer("roomy", __APP_VERSION__);

  return faro as any;
}
