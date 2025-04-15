import { tick } from "svelte";

/**
 * Svelte action to focus an element after it is rendered.
 * Add use:focusOnRender to HTML element to focus it after it is rendered.
 * @param elementRef The HTML element to focus.
 */
export function focusOnRender(elementRef: HTMLElement | null) {
  async function update() {
    await tick(); // Wait for the DOM to update
    if (elementRef) {
      // Wait another tick.
      // This is necessary to ensure that the element is fully rendered.
      tick().then(() => elementRef.focus());
    }
  }

  update();
}
