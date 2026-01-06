import {
  BaseInstrumentation,
  ErrorsInstrumentation,
  type Faro,
  getWebInstrumentations,
  initializeFaro as init,
  LogLevel,
} from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import type { Tracer } from "@opentelemetry/api";
import { CONFIG } from "./config";

type WorkerInfo =
  | {
      worker: "main";
    }
  | {
      worker: "sqlite";
    };

class CustomConsoleInstrumentation extends BaseInstrumentation {
  readonly name = "@muni-town/roomy:instrumentation-console";
  readonly version = "0.1";

  initialize() {
    const levels = ["info", "warn", "error"] as LogLevel[];
    const origConsoleFns: { [key: string]: (...args: any[]) => void } = {};
    levels.forEach((level) => {
      origConsoleFns[level] = console[level];
      /* eslint-disable-next-line no-console */
      console[level] = (...args) => {
        if (
          args.length == 2 &&
          typeof args[0] == "string" &&
          typeof args[1] == "object"
        ) {
          this.api.pushLog([args[0]], {
            level,
            context: args[1],
          });
        } else {
          this.api.pushLog(
            [args.map((x) => (typeof x == "string" ? x : JSON.stringify(x)))],
            {
              level,
            },
          );
        }
        if (level == "info" && typeof args[0] == "string") {
          origConsoleFns[level]!(
            ...args.flatMap((x) =>
              typeof x == "string" ? ["%c" + x, "color:chartreuse"] : [x],
            ),
          );
        } else {
          origConsoleFns[level]!(...args);
        }
      };
    });
  }
}

export function initializeFaro(opts: WorkerInfo): Faro & { tracer: Tracer } {
  const faro = init({
    app: { name: "roomy", version: __APP_VERSION__ },
    apiKey: "bad_api_key",
    url: CONFIG.faroEndpoint,
    dedupe: false,
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
        ? [
            ...getWebInstrumentations({
              captureConsole: false,
            }),
            new CustomConsoleInstrumentation(),
          ]
        : [new CustomConsoleInstrumentation(), new ErrorsInstrumentation()]),
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
