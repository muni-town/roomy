/**
 * Regression tests for the push-unavailable copy shown by the notifications
 * settings page.
 *
 * The bug: every device without `PushManager` got the same sentence naming
 * "Safari 16.1+" as the remedy. On iOS, `PushManager` is only present in an
 * app installed on the Home Screen, so users reading that page in Safari were
 * told to use Safari (community report, Roomy Space #general, 2026-09-24).
 * These tests pin the capability classification that replaces the single
 * message, and pin that a non-iOS device still gets the original sentence.
 *
 * Written against `node:test` + `node:assert` so the file runs under both
 * `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PUSH_UNAVAILABLE_MESSAGES,
  classifyPushUnavailable,
  readIosStandaloneCapabilities,
  type IosStandaloneCapabilities,
} from "./push-support.ts";

/** `navigator` as WebKit on iOS exposes it in a plain Safari tab. */
const IOS_SAFARI_TAB: IosStandaloneCapabilities = {
  standaloneFlag: true,
  standalone: false,
  maxTouchPoints: 5,
};

/** The same WebKit, launched from the Home Screen (still no PushManager => too old iOS). */
const IOS_INSTALLED_OLD: IosStandaloneCapabilities = {
  standaloneFlag: true,
  standalone: true,
  maxTouchPoints: 5,
};

/** Desktop browser: no `standalone` extension, no touch screen. */
const DESKTOP: IosStandaloneCapabilities = {
  standaloneFlag: false,
  standalone: false,
  maxTouchPoints: 0,
};

/** macOS Safari: WebKit exposes `standalone` here too, but it has no touch screen. */
const MAC_SAFARI: IosStandaloneCapabilities = {
  standaloneFlag: true,
  standalone: false,
  maxTouchPoints: 0,
};

describe("classifyPushUnavailable", () => {
  test("a Home Screen install missing push is told to install", () => {
    assert.equal(classifyPushUnavailable(IOS_SAFARI_TAB), "ios-needs-install");
  });

  test("an installed iOS app missing push is told to update iOS", () => {
    assert.equal(classifyPushUnavailable(IOS_INSTALLED_OLD), "ios-outdated");
  });

  test("a desktop browser without push keeps the generic remedy", () => {
    assert.equal(classifyPushUnavailable(DESKTOP), "browser-unsupported");
  });

  test("macOS Safari is not treated as iOS despite exposing standalone", () => {
    // WebKit ships `standalone` on macOS too (always false), so the property
    // alone must not classify the desktop browser as an iPhone.
    assert.equal(classifyPushUnavailable(MAC_SAFARI), "browser-unsupported");
  });
});

describe("PUSH_UNAVAILABLE_MESSAGES", () => {
  test("the install message names the install step and not a browser to switch to", () => {
    const msg = PUSH_UNAVAILABLE_MESSAGES["ios-needs-install"];
    assert.match(msg, /Add to Home Screen/);
    assert.doesNotMatch(msg, /Safari|Firefox|Chrome|Edge|Brave/);
  });

  test("the unsupported-browser message still names the supported browsers", () => {
    const msg = PUSH_UNAVAILABLE_MESSAGES["browser-unsupported"];
    assert.match(msg, /Firefox, Chrome, Edge, Brave, or Safari 16\.1\+/);
  });

  test("every reason has distinct copy", () => {
    const msgs = Object.values(PUSH_UNAVAILABLE_MESSAGES);
    assert.equal(new Set(msgs).size, msgs.length);
    for (const msg of msgs) assert.ok(msg.length > 0);
  });
});

describe("readIosStandaloneCapabilities", () => {
  test("reports an iOS Home Screen tab from the platform globals", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { standalone: true, maxTouchPoints: 5 },
    });
    try {
      assert.deepEqual(readIosStandaloneCapabilities(), {
        standaloneFlag: true,
        standalone: true,
        maxTouchPoints: 5,
      });
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  test("reports a non-iOS browser as neither standalone nor touch-capable", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { maxTouchPoints: 0 },
    });
    try {
      assert.deepEqual(readIosStandaloneCapabilities(), {
        standaloneFlag: false,
        standalone: false,
        maxTouchPoints: 0,
      });
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});
