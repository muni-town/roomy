<script>
  import Icon from "@iconify/svelte";
  import { Button } from "bits-ui";
  import { getContext } from "svelte";
  const isSidebarVisible = getContext("isSidebarVisible");
</script>

<Button.Root
  onclick={() => isSidebarVisible.toggle()}
  class="shrink-0 p-1 cursor-pointer sm:hidden text-base-900 dark:text-base-100"
>
  <Icon icon="basil:menu-outline" font-size="1.75rem" />
</Button.Root>
