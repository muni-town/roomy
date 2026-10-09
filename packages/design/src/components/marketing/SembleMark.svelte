<script lang="ts">
  /**
   * SembleMark — Semble's brand glyph, for the actions that hand a link to
   * Semble (`network.cosmik.card`). A vendor mark, so it is inlined like
   * {@link RoomyMark} rather than fetched: no asset pipeline, no network, and
   * it inherits the caller's size.
   *
   * This is a third-party logo and keeps Semble's own colour on purpose. The
   * design system's "swappable accent" rule governs Roomy's surfaces; a
   * vendor mark is identity the way a favicon is, and tinting it with the
   * current accent would stop it reading as Semble. `currentColor` is
   * deliberately not used.
   *
   * Sized by the caller via `class` (the menu items pass `size-4`, matching
   * the Phosphor icons beside it). The viewBox is taller than wide — the
   * glyph is a sprout — so it centres in a square slot.
   */
  let { class: className = "" }: { class?: string } = $props();
</script>

<svg
  viewBox="0 0 24 33"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  class="shrink-0 {className}"
>
  <path
    d="M24 25.4263C24 29.6092 19.9545 33.0001 12.2727 33.0001C4.59095 33.0001 0 28.7977 0 24.6148C0 20.4319 4.59095 17.8524 12.2727 17.8524C19.9545 17.8524 24 21.2433 24 25.4263Z"
    fill="#FF6400"
  />
  <path
    d="M19.9093 14.8773C19.9093 17.2675 16.0921 17.0413 11.7274 17.0413C7.3628 17.0413 3.81836 16.997 3.81836 14.6068C3.81836 12.2166 7.51776 9.73792 11.8824 9.73792C16.2471 9.73792 19.9093 12.4871 19.9093 14.8773Z"
    fill="#FF6400"
  />
  <path
    d="M19.3637 8.38505C19.3637 10.7753 16.092 9.19653 11.7274 9.19653C7.36271 9.19653 4.90918 10.5048 4.90918 8.11455C4.90918 5.72432 7.36271 4.32764 11.7274 4.32764C16.092 4.32764 19.3637 5.99481 19.3637 8.38505Z"
    fill="#FF6400"
  />
  <path
    d="M15.818 2.74402C15.818 4.47599 14.0896 3.24593 11.7837 3.24593C9.47785 3.24593 8.18164 4.47599 8.18164 2.74402C8.18164 1.01204 9.47785 0 11.7837 0C14.0896 0 15.818 1.01204 15.818 2.74402Z"
    fill="#FF6400"
  />
</svg>
