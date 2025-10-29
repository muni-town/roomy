<script lang="ts">
  /***
   * From Fox UI by Flo-bit
   * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
   */

  import type { RichTextTypes } from ".";

  let {
    name,
  }: {
    name: RichTextTypes;
  } = $props();
</script>

/*** * From Fox UI by Flo-bit *
https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
*/

{#if name === "paragraph"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><path d="M13 4v16" /><path d="M17 4v16" /><path
      d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"
    /></svg
  >
{:else if name === "heading-1"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><path d="M4 12h8" /><path d="M4 18V6" /><path d="M12 18V6" /><path
      d="m17 12 3-2v8"
    /></svg
  >
{:else if name === "heading-2"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><path d="M4 12h8" /><path d="M4 18V6" /><path d="M12 18V6" /><path
      d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"
    /></svg
  >
{:else if name === "heading-3"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><path d="M4 12h8" /><path d="M4 18V6" /><path d="M12 18V6" /><path
      d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"
    /><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2" /></svg
  >
{:else if name === "blockquote"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><path d="M17 6H3" /><path d="M21 12H8" /><path d="M21 18H8" /><path
      d="M3 12v6"
    /></svg
  >
{:else if name === "code"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><polyline points="16 18 22 12 16 6" /><polyline
      points="8 6 2 12 8 18"
    /></svg
  >
{:else if name === "bullet-list"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><path d="M3 12h.01" /><path d="M3 18h.01" /><path d="M3 6h.01" /><path
      d="M8 12h13"
    /><path d="M8 18h13" /><path d="M8 6h13" /></svg
  >
{:else if name === "ordered-list"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><path d="M10 12h11" /><path d="M10 18h11" /><path d="M10 6h11" /><path
      d="M4 10h2"
    /><path d="M4 6h1v4" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></svg
  >
{:else if name === "image"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    ><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle
      cx="9"
      cy="9"
      r="2"
    /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg
  >
{/if}
