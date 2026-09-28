/**
 * What to tell a device that cannot do web push.
 *
 * **The bug these reasons exist for.** The notifications page rendered one
 * message for every browser without `PushManager`: *"Use a supported browser
 * (Firefox, Chrome, Edge, Brave, or Safari 16.1+)"*. On iOS, `PushManager` is
 * only injected into an app installed on the Home Screen, so a user reading
 * that message in Safari — the one mobile browser that *does* support push —
 * was told to switch to the browser they were already using, with no mention
 * of the install step they actually need (community report, Roomy Space
 * `#general`, 2026-09-24). The remedy differs per population, so the message
 * is chosen by capability rather than by browser name.
 *
 * **iOS is detected by capability, not by UA string.** Two reads combine:
 * `navigator.standalone` — a non-standard WebKit property, so an engine test
 * that keeps Blink and Gecko out — and `navigator.maxTouchPoints`, because
 * WebKit exposes `standalone` on *every* Cocoa port including macOS Safari,
 * where it is always false. A Mac reports 0 touch points (so does visionOS),
 * an iPhone/iPad reports 5, which is what separates them. No UA string is
 * parsed — iPadOS 13+ reports itself as macOS precisely because it asks for
 * desktop sites, so a UA sniff would misclassify iPads outright.
 *
 * Sources: WebKit `Navigator.idl` (`standalone`, non-standard,
 * `ENABLE_NAVIGATOR_STANDALONE`; enabled for `PLATFORM(COCOA)` via
 * `PlatformEnableCocoa.h`), `Navigator::standalone()` returning the page's
 * standalone setting; MDN `Navigator.maxTouchPoints`.
 */

/** Reason a device cannot receive push, and therefore which advice applies. */
export type PushUnavailableReason =
  | "ios-needs-install"
  | "ios-outdated"
  | "browser-unsupported";

/** The iOS-specific capabilities the classification reads, as plain data. */
export interface IosStandaloneCapabilities {
  /** `"standalone" in navigator` — WebKit-only (Blink/Gecko don't ship it). */
  standaloneFlag: boolean;
  /** `navigator.standalone === true` — launched from the iOS Home Screen. */
  standalone: boolean;
  /** `navigator.maxTouchPoints` — 0 on a Mac, 5 on an iPhone/iPad. */
  maxTouchPoints: number;
}

/**
 * Snapshot those capabilities from the current document. Only meaningful on
 * the client; the page is `ssr = false`, but a non-browser caller gets the
 * "not iOS" values rather than a throw.
 */
export function readIosStandaloneCapabilities(): IosStandaloneCapabilities {
  if (typeof navigator === "undefined") {
    return { standaloneFlag: false, standalone: false, maxTouchPoints: 0 };
  }
  // `standalone` is non-standard, so `lib.dom` does not declare it.
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    standaloneFlag: "standalone" in nav,
    standalone: nav.standalone === true,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
  };
}

/**
 * Classify a device that lacks `PushManager`. Callers only reach here once
 * `PushManager` is known to be absent; the iOS distinction is whether the app
 * still has an install step to offer.
 */
export function classifyPushUnavailable(
  caps: IosStandaloneCapabilities,
): PushUnavailableReason {
  const isIos = caps.standaloneFlag && caps.maxTouchPoints > 1;
  if (!isIos) return "browser-unsupported";
  return caps.standalone ? "ios-outdated" : "ios-needs-install";
}

/** The copy for each unavailable reason — the page renders it verbatim. */
export const PUSH_UNAVAILABLE_MESSAGES: Record<PushUnavailableReason, string> = {
  // Already in Safari, so naming Safari (or any other browser) is useless
  // advice — the missing piece is the Home Screen install.
  "ios-needs-install":
    "On iPhone and iPad, Roomy can only send notifications from the app " +
    "installed on your Home Screen. Tap Share → Add to Home Screen, then " +
    "open Roomy from your Home Screen and enable notifications there.",
  // Installed already, so the install step is behind them; Web Push on iOS
  // starts at 16.4.
  "ios-outdated":
    "Notifications on iPhone and iPad need iOS 16.4 or later. Update iOS in " +
    "Settings → General → Software Update, then reopen Roomy from your Home " +
    "Screen.",
  "browser-unsupported":
    "Web push isn't supported in this browser. Use a supported browser " +
    "(Firefox, Chrome, Edge, Brave, or Safari 16.1+) to receive " +
    "notifications.",
}
