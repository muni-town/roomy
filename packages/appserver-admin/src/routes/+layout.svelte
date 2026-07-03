<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { auth, init } from "$lib/auth.svelte";
  let { children } = $props();

  onMount(() => {
    init();
  });
</script>

{#if auth.initializing}
  <div class="flex items-center justify-center min-h-screen text-base-400">
    Initializing…
  </div>
{:else}
  {@render children()}
{/if}
