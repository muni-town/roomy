<script lang="ts">
  import IconBasilMenuOutline from "~icons/basil/menu-outline";
  import { Button } from "bits-ui";

  let { isSidebarVisible = $bindable() }: { isSidebarVisible: boolean } =
    $props();
</script>

<Button.Root
  onclick={() => (isSidebarVisible = !isSidebarVisible)}
  class="shrink-0 p-1 cursor-pointer text-base-900 dark:text-base-100"
>
  <IconBasilMenuOutline font-size="1.75rem" />
</Button.Root>
