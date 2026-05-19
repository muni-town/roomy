<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { queryClient } from "$lib/client";
  import { init } from "$lib/auth.svelte";

  let { children } = $props();

  onMount(() => {
    init();
  });
</script>

<QueryClientProvider client={queryClient}>
  {@render children()}
</QueryClientProvider>
