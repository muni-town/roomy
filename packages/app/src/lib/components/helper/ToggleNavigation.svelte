<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Button } from "bits-ui";

  let { isSidebarVisible = $bindable() }: { isSidebarVisible: boolean } =
    $props();
</script>

<Button.Root
  onclick={() => (isSidebarVisible = !isSidebarVisible)}
  class="shrink-0 p-1 cursor-pointer text-base-900 dark:text-base-100"
>
  <Icon icon="basil:menu-outline" font-size="1.75rem" />
</Button.Root>
