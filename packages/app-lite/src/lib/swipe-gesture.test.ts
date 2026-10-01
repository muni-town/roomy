/**
 * The guard that keeps a text-selection drag from opening the mobile sidebar.
 *
 * What these tests pin is the decision, not the wiring: which combinations of
 * "the touch landed in a text field", "a text field has focus" and "a soft
 * keyboard is up" permit the swipe, and how the viewport numbers that stand
 * for "a keyboard is up" are read. The element classification is driven with
 * the tags and types real markup produces, since those are what the app hands
 * the guard.
 *
 * Deliberate limits of this coverage:
 *
 * 1. No browser is booted here, so this cannot prove a real soft keyboard
 *    changes `visualViewport`; it pins what the app does with the numbers.
 * 2. The threshold is exercised either side of its boundary, not on a real
 *    device. The phone-sized gesture that motivates the guard is covered by
 *    the Playwright spec beside the e2e harness.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isSoftKeyboardOpen,
  mayStartSidebarSwipe,
  shouldIgnoreSwipeStart,
} from "./swipe-gesture.ts";

/** A target of one tag, answering `closest` for the editable ancestors given. */
function target(
  tagName: string,
  { type, editable }: { type?: string; editable?: boolean } = {},
) {
  return {
    tagName,
    type,
    closest: (selectors: string) =>
      selectors === '[contenteditable="true"]' && editable ? {} : null,
  };
}

/** A paragraph inside the composer's editable region. */
const composerParagraph = target("P", { editable: true });
/** The composer's own editable root. */
const composerRoot = target("DIV", { editable: true });
/** Anything in the panel that is not text entry — a message body, a button. */
const messageText = target("P");

describe("mayStartSidebarSwipe", () => {
  test("nothing selected and no keyboard", () => {
    assert.equal(
      mayStartSidebarSwipe({ textEntryActive: false, keyboardOpen: false }),
      true,
    );
  });

  test("a selection drag inside a field", () => {
    assert.equal(
      mayStartSidebarSwipe({ textEntryActive: true, keyboardOpen: false }),
      false,
    );
  });

  test("a keyboard up over a non-field area", () => {
    assert.equal(
      mayStartSidebarSwipe({ textEntryActive: false, keyboardOpen: true }),
      false,
    );
  });
});

describe("shouldIgnoreSwipeStart", () => {
  test("a touch on a paragraph inside the composer", () => {
    assert.equal(shouldIgnoreSwipeStart(composerParagraph, null), true);
  });

  test("a touch on the composer's own editable root", () => {
    assert.equal(shouldIgnoreSwipeStart(composerRoot, null), true);
  });

  test("a touch on a message while the composer holds focus", () => {
    assert.equal(shouldIgnoreSwipeStart(messageText, composerRoot), true);
  });

  test("a touch on a message with nothing focused", () => {
    assert.equal(shouldIgnoreSwipeStart(messageText, null), false);
  });

  test("a text input, and one whose type attribute is absent", () => {
    assert.equal(shouldIgnoreSwipeStart(target("INPUT", { type: "text" }), null), true);
    assert.equal(shouldIgnoreSwipeStart(target("INPUT"), null), true);
  });

  test("a slider, a checkbox and a file picker are not text entry", () => {
    for (const type of ["range", "checkbox", "file"]) {
      assert.equal(shouldIgnoreSwipeStart(target("INPUT", { type }), null), false, type);
    }
  });

  test("a textarea", () => {
    assert.equal(shouldIgnoreSwipeStart(target("TEXTAREA"), null), true);
  });

  test("no target and no focus", () => {
    assert.equal(shouldIgnoreSwipeStart(null, null), false);
  });
});

describe("isSoftKeyboardOpen", () => {
  /** An iPhone-sized layout viewport, whose chrome occludes ~110px. */
  const PHONE_INNER_HEIGHT = 780;

  test("no visual viewport reports no keyboard", () => {
    assert.equal(isSoftKeyboardOpen(PHONE_INNER_HEIGHT, null), false);
  });

  test("a visual viewport matching the layout viewport", () => {
    assert.equal(
      isSoftKeyboardOpen(PHONE_INNER_HEIGHT, {
        height: PHONE_INNER_HEIGHT,
        offsetTop: 0,
        scale: 1,
      }),
      false,
    );
  });

  test("Safari's collapsing URL bar does not read as a keyboard", () => {
    assert.equal(
      isSoftKeyboardOpen(PHONE_INNER_HEIGHT, {
        height: 670,
        offsetTop: 0,
        scale: 1,
      }),
      false,
    );
  });

  test("a phone soft keyboard does", () => {
    assert.equal(
      isSoftKeyboardOpen(PHONE_INNER_HEIGHT, {
        height: 444,
        offsetTop: 0,
        scale: 1,
      }),
      true,
    );
  });

  test("the keyboard's own offset counts as occlusion", () => {
    assert.equal(
      isSoftKeyboardOpen(PHONE_INNER_HEIGHT, {
        height: 560,
        offsetTop: 90,
        scale: 1,
      }),
      true,
    );
  });

  test("a pinch-zoomed page is not read as a keyboard", () => {
    assert.equal(
      isSoftKeyboardOpen(PHONE_INNER_HEIGHT, {
        height: 390,
        offsetTop: 0,
        scale: 2,
      }),
      false,
    );
  });
});
