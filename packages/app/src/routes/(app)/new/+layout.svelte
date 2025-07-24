<script lang="ts">
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { ScrollArea } from "@fuxui/base";

  let { children } = $props();
</script>

<MainLayout>
  <ScrollArea>
    <div class="max-w-3xl mx-auto w-full p-4">
      {@render children?.()}
    </div>
  </ScrollArea>
</MainLayout>
