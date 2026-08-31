/**
 * Grafana Faro browser telemetry (frontend log collection).
 *
 * app-lite is a static SPA — there is no server stdout to collect, so
 * client-side logs/errors are shipped via the Faro browser agent to an
 * Alloy `faro.receiver` (production: deploy/alloy/config.alloy, dev:
 * compose.yaml) which forwards to Loki. The agent POSTs to `<url>/collect`;
 * PUBLIC_FARO_URL should include the path (e.g. http://127.0.0.1:12345/collect).
 *
 * Initialization is a no-op unless PUBLIC_FARO_URL is set — dev/build
 * default is disabled (zero network, zero errors, SDK never loaded).
 * Browser-only: guards against SSR/prerender via $app/environment.
 *
 * v1 scope: console.* interception + error instrumentation. No web vitals
 * or tracing.
 */
import { browser } from "$app/environment";
import { CONFIG } from "$lib/config";

let initialized = false;

/**
 * Initialize Faro once, lazily. Safe to call multiple times (e.g. from
 * route-level bootstrap and hot-reload during dev) — the SDK is only ever
 * loaded and initialized on the first call when PUBLIC_FARO_URL is set.
 */
export function initFaro(): void {
  if (!browser || initialized || !CONFIG.faroUrl) return;
  initialized = true;

  // Dynamic import keeps @grafana/faro-web-sdk out of the main bundle when
  // telemetry is disabled (the default) — zero payload cost for the 99% of
  // deployments that run without PUBLIC_FARO_URL.
  void import("@grafana/faro-web-sdk").then(({ initializeFaro, ConsoleInstrumentation, ErrorsInstrumentation }) => {
    initializeFaro({
      url: CONFIG.faroUrl!,
      app: {
        name: "roomy-app-lite",
        version: __APP_VERSION__,
      },
      ...(CONFIG.faroApiKey ? { apiKey: CONFIG.faroApiKey } : {}),
      instrumentations: [
        // Captures console.* calls as log messages.
        new ConsoleInstrumentation(),
        // Captures uncaught errors + unhandled promise rejections.
        new ErrorsInstrumentation(),
      ],
    });
  });
}
