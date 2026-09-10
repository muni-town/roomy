<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import { init } from "$lib/auth.svelte";

  let { children } = $props();

  // Fire auth init on mount so interactive pages (endpoint "Try it", playground,
  // dashboard) can use the session. Prose pages render immediately regardless.
  onMount(() => {
    init();
  });
</script>

<div class="flex h-screen overflow-hidden">
  <Sidebar />
  <main class="flex-1 overflow-y-auto">
    <div class="max-w-4xl mx-auto px-6 py-8">
      {@render children()}
    </div>
  </main>
</div>
