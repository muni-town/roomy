/**
 * Grafana Faro browser telemetry (frontend log collection + session + user).
 *
 * app-lite is a static SPA — there is no server stdout to collect, so
 * client-side logs/errors/spans are shipped via the Faro browser agent to an
 * Alloy `faro.receiver` (production: deploy/alloy/config.alloy, dev:
 * compose.yaml) which forwards logs to Loki and browser spans to Tempo. The
 * agent POSTs to `<url>/collect`; PUBLIC_FARO_URL should include the path
 * (e.g. http://127.0.0.1:12345/collect).
 *
 * Initialization is a no-op unless PUBLIC_FARO_URL is set — dev/build
 * default is disabled (zero network, zero errors, SDK never loaded).
 * Browser-only: guards against SSR/prerender via $app/environment.
 *
 * Scope: console.* interception, error instrumentation, web vitals
 * (LCP/CLS/INP/FCP/TTFB) and browser tracing, plus the session
 * (`SessionInstrumentation`) that names a visit. Every signal then carries a
 * session id, so signals group per visit and time-in-app is readable as
 * first→last event per id — Faro emits no `session_end`, so the duration is
 * derived rather than reported.
 *
 * That visit is attributed to a salted DID hash, never the DID itself:
 * `setFaroUser` takes a DID and applies the mapping from `./scrub.ts` here, so
 * no caller can hand the SDK a raw identifier.
 *
 * Every item is passed through `beforeSend` (`./scrub.ts`) before it leaves
 * the browser: logged errors routinely carry a request URL, which for a
 * `com.atproto.server.getServiceAuth` call is a signed capability.
 */
import type { Faro } from "@grafana/faro-web-sdk";
import { browser } from "$app/environment";
import { CONFIG } from "$lib/config";
import { pseudonymiseDid, scrubTelemetryItem } from "./scrub";

let initialized = false;

/**
 * The live Faro instance. Held here rather than read back from `window.faro`:
 * that global is an SDK option (`preventGlobalExposure`), not a contract, so
 * this reference is the one handle the app owns.
 */
let faroInstance: Faro | undefined;

/**
 * Pseudonymised user id set before the SDK finished loading. `initFaro` starts
 * a dynamic import that resolves after its caller returns, so `setFaroUser`
 * can land first; without this the id would be dropped.
 */
let pendingUser: string | undefined;

/**
 * Initialize Faro once, lazily. Safe to call multiple times (e.g. from
 * route-level bootstrap and hot-reload during dev) — the SDK is only ever
 * loaded and initialized on the first call when PUBLIC_FARO_URL is set.
 */
export function initFaro(): void {
  if (!browser || initialized || !CONFIG.faroUrl) return;
  initialized = true;

  // Dynamic imports keep the telemetry SDKs out of the main bundle when
  // telemetry is disabled (the default) — zero payload cost for the 99% of
  // deployments that run without PUBLIC_FARO_URL.
  void Promise.all([
    import("@grafana/faro-web-sdk"),
    // Browser spans (page load, fetches): exported to the collector's
    // `faro.receiver`, which forwards them to Tempo.
    import("@grafana/faro-web-tracing"),
  ]).then(
    ([
      {
        initializeFaro,
        ConsoleInstrumentation,
        ErrorsInstrumentation,
        SessionInstrumentation,
        WebVitalsInstrumentation,
      },
      { TracingInstrumentation },
    ]) => {
      faroInstance = initializeFaro({
        url: CONFIG.faroUrl!,
        app: {
          name: "roomy-app-lite",
          version: __APP_VERSION__,
        },
        // One session spans reloads — a reload is the same visit, so a new
        // session per load would overstate visit count and understate time in
        // app. `persistent` uses the SDK's sticky-session store. The
        // instrumentation below is what actually stamps `metas.value.session`
        // onto every signal; the config alone leaves it undefined.
        sessionTracking: {
          enabled: true,
          persistent: true,
          samplingRate: 1,
        },
        ...(CONFIG.faroApiKey ? { apiKey: CONFIG.faroApiKey } : {}),
        // Errors arrive here from code that logs them whole, including
        // third-party messages that embed the request URL (a
        // `getServiceAuth` URL carries a signed token's `exp`/`lxm`). Every
        // item is scrubbed on its way out — see ./scrub.ts.
        beforeSend: scrubTelemetryItem,
        instrumentations: [
          // Captures console.* calls as log messages.
          new ConsoleInstrumentation(),
          // Captures uncaught errors + unhandled promise rejections.
          new ErrorsInstrumentation(),
          // Names the visit: sets the session meta carried by every signal and
          // emits session_start / session_resume.
          new SessionInstrumentation(),
          // Reports LCP, CLS, INP, FCP and TTFB as measurements, so page speed
          // is visible per session instead of inferred from log timing.
          new WebVitalsInstrumentation(),
          // Emits spans for navigations and fetches, and stamps the trace
          // context onto logs and errors so they join the same trace.
          new TracingInstrumentation(),
        ],
      });
      // Flush in arrival order: a buffered event happened before anything the
      // app reports from here on.
      for (const event of pendingEvents.splice(0)) {
        faroInstance.api.pushEvent(event.name, event.attributes);
      }
      if (pendingUser !== undefined) faroInstance.api.setUser({ id: pendingUser });
    },
  );
}

/**
 * Name the telemetry user for a signed-in DID. No-op when there is no id to
 * report, so a missing DID or salt leaves the session anonymous.
 *
 * The SDK is given a salted hash of the DID, never the DID: a stored DID is a
 * durable, cross-service identifier and the log store has no business holding
 * one (`pseudonymiseDid`, ./scrub.ts). Applying the mapping here — the single
 * place that calls `setUser` — is what keeps raw DIDs from reaching the SDK at
 * all.
 */
export async function setFaroUser(did: string | undefined): Promise<void> {
  const id = await pseudonymiseDid(did ?? "", CONFIG.analyticsSalt ?? undefined);
  if (id === undefined) return;
  pendingUser = id;
  faroInstance?.api.setUser({ id });
}

/** A product event's attributes. Faro stores event attributes as strings. */
export type EventAttributes = Record<string, string>;

/**
 * Events raised before the SDK finished loading. `initFaro` starts a dynamic
 * import that resolves after its caller returns, and tiles can render before
 * it does — those reports would otherwise be dropped for being early.
 */
const pendingEvents: Array<{ name: string; attributes: EventAttributes }> = [];

/** How many early events are held. Beyond this the oldest are not kept. */
const MAX_PENDING_EVENTS = 32;

/**
 * Record a product event (tile engagement, and whatever else needs counting
 * that is not an error or a log line).
 *
 * A no-op when telemetry is not configured: `initFaro` returns without
 * initialising, so nothing is ever flushed and the buffer fills and stops.
 * Events raised while the SDK is still loading are buffered and flushed on
 * initialisation, in order; beyond the cap they are dropped rather than
 * growing without bound.
 */
export function trackEvent(name: string, attributes: EventAttributes): void {
  if (faroInstance) {
    faroInstance.api.pushEvent(name, attributes);
    return;
  }
  if (pendingEvents.length < MAX_PENDING_EVENTS) {
    pendingEvents.push({ name, attributes });
  }
}
