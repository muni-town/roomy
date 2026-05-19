<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { queryClient } from "$lib/client";
  import { auth, init } from "$lib/auth.svelte";
  import { startSync, stopSync } from "$lib/sync.svelte";

  let { children } = $props();

  onMount(() => {
    init();
  });

  $effect(() => {
    if (auth.authenticated) {
      startSync();
      return () => stopSync();
    }
  });
</script>

<QueryClientProvider client={queryClient}>
  {@render children()}
</QueryClientProvider>
