/**
 * Signals that decide whether a touch on the main panel may start the
 * open-sidebar swipe.
 *
 * The panel's touch handlers sit on an ancestor of everything inside it, so a
 * touch that starts inside the composer reaches them too — and a long-press
 * drag that extends a text selection is exactly a large, nearly horizontal
 * drag. Only the start of the gesture can tell the two apart: a swipe begins
 * on the panel, a selection drag begins on the text it selects. The decision
 * is therefore taken on `touchstart` and never revisited as the touch moves,
 * and it does not consult the geometry thresholds.
 *
 * Two signals answer "the user is typing, not swiping", and they cover
 * different failures, so both are required:
 *
 * - `textEntryActive` (from `shouldIgnoreSwipeStart`): the touch landed in a
 *   text field, or one holds focus. It is a selection drag whichever way it
 *   travels — including the rightward drag that extends a selection made
 *   leftward.
 * - `keyboardOpen`: a soft keyboard is up over something else in the panel (a
 *   menu, a dialog, a page body that is not a field). Nothing about the
 *   gesture's geometry says the panel is occluded, so the keyboard's height is
 *   the only signal.
 *
 * The pure decisions live here so they are unit-testable without a DOM (the
 * convention `input-device.ts` sets); `MainLayout.svelte` supplies the live
 * values and the element the touch landed on.
 */

export function mayStartSidebarSwipe({
  textEntryActive,
  keyboardOpen,
}: {
  textEntryActive: boolean;
  keyboardOpen: boolean;
}): boolean {
  return !textEntryActive && !keyboardOpen;
}

/**
 * The parts of a touch target this module reads. Structural rather than the
 * DOM interfaces, so the decision is testable in a runtime without a document
 * (`HTMLElement` and friends do not exist in Node); a real `Element` satisfies
 * it.
 */
type TouchTarget = {
  tagName: string;
  /** An `input`'s effective type, which defaults to `text` in the DOM. */
  type?: string;
  closest(selectors: string): unknown;
};

/** A `checkbox` still takes focus, but the user is not typing into it. */
const NON_TEXT_INPUT_TYPES: Record<string, true> = {
  button: true,
  checkbox: true,
  file: true,
  hidden: true,
  image: true,
  radio: true,
  range: true,
  reset: true,
  submit: true,
};

/**
 * Whether the touch that started the gesture is manipulating text entry, or
 * whether a text-entry element holds focus at all.
 *
 * `target` is the element the touch landed on: focus can sit on a field the
 * touch never touched (the composer, after pressing Send), and a drag in the
 * message list is a panel swipe.
 *
 * Tiptap's composer is a `contenteditable` div rather than a form control, and
 * a selection drag can report one of its descendants as the target, so the
 * whole ancestor chain is asked. An `input` with no type reads as text, which
 * is the DOM's own default.
 */
export function shouldIgnoreSwipeStart(
  target: TouchTarget | null,
  activeElement: TouchTarget | null,
): boolean {
  const isTextEntry = (element: TouchTarget | null): boolean => {
    if (!element) return false;
    if (element.tagName === "TEXTAREA") return true;
    if (element.tagName === "INPUT") {
      return NON_TEXT_INPUT_TYPES[element.type ?? "text"] !== true;
    }
    return element.closest('[contenteditable="true"]') != null;
  };
  return isTextEntry(target) || isTextEntry(activeElement);
}

/**
 * Whether a soft keyboard is up over the panel.
 *
 * The visual viewport shrinks when a keyboard opens while the layout viewport
 * (`innerHeight`) stays put, so the shortfall is what the keyboard covers —
 * measured in CSS pixels when the page is not zoomed, which is how both
 * viewports report. A browser without a visual viewport reports no keyboard,
 * which is the pre-existing behaviour rather than a new failure.
 *
 * The threshold keeps browser chrome from reading as a keyboard. Every
 * measurement of what the keyboard covers is confounded by UI that overlays
 * the layout viewport without being a keyboard: Safari's collapsing URL bar
 * reaches ~110px on an iPhone, while a soft keyboard is 216px or more even on
 * the smallest phone. Requiring a keyboard-sized shortfall leaves the
 * collapsing toolbar free to do as it likes.
 *
 * A zoomed page reports the same shortfall for a reason that is not a
 * keyboard — a 2x pinch shrinks the visual viewport to about half the layout
 * viewport — so a scale above 1 is read as zoom and never as a keyboard.
 *
 * What this cannot see: a browser that resizes the *layout* viewport for the
 * keyboard (Chrome's `interactive-widget=resizes-content`) leaves no
 * shortfall to measure. The gesture is still suppressed there by the
 * text-entry signal, which is what the composer case needs.
 */
export function isSoftKeyboardOpen(
  innerHeight: number,
  visualViewport:
    | { height: number; offsetTop: number; scale: number }
    | null
    | undefined,
): boolean {
  if (!visualViewport || visualViewport.scale > 1.01) return false;
  const occlusion =
    innerHeight - visualViewport.height - visualViewport.offsetTop;
  return occlusion >= 130;
}
