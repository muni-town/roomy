<script lang="ts">
  import MainLayout from "$lib/components/layout/MainLayout.svelte";

  let { children } = $props();
</script>

<MainLayout>
  <div class="max-w-3xl mx-auto w-full p-4">
    {@render children?.()}
  </div>
</MainLayout>
