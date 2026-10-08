<script lang="ts">
  /**
   * The multi-select tick that occupies `MessageBubble`'s avatar slot.
   *
   * Presentational only: the wrapper owns whether a row is in select mode and
   * what its checked state is. It renders as a checkbox in the round avatar's
   * footprint, so a selection never moves the message body — and so the state
   * reads where the eye already goes for a row's identity.
   */
  import { IconCheck } from "../../../../icons/index";

  let { checked = false }: { checked?: boolean } = $props();
</script>

<span
  class={[
    "flex size-8 sm:size-10 items-center justify-center rounded-full border transition-colors duration-75",
    checked
      ? "bg-accent-500 border-accent-500 text-accent-50"
      : "border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 text-transparent",
  ]}
  aria-hidden="true"
>
  <IconCheck class="size-4 sm:size-5" />
</span>
