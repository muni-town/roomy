<script lang="ts">
  import { globalState } from "$lib/global.svelte";

  let { children } = $props();

</script>

{#if globalState.space}
  <!-- Events/Room Content -->
  <main
    class="flex flex-col gap-4 p-4 grow min-w-0 h-full overflow-clip bg-base-100"
  >
    {@render children()}
  </main>

  <!-- If there is no space. -->
{:else}
  <span class="dz-loading dz-loading-spinner mx-auto"></span>
{/if}