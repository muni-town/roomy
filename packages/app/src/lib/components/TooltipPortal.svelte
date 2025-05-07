<script lang="ts">
  let { text, visible = false, x = 0, y = 0 } = $props();
</script>

{#if visible}
  <div
    class="fixed px-2 py-1 bg-base-300 rounded shadow-md text-sm whitespace-nowrap pointer-events-none z-50 border border-base-content/20 opacity-100"
    style="left: {x}px; top: {y}px; transform: translateY(-50%);"
  >
    {text}
  </div>
{/if}
