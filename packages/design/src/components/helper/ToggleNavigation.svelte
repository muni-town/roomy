<script lang="ts">
  import { IconBars } from "@roomy/design/icons";
  import { Button } from "bits-ui";

  let { isSidebarVisible = $bindable() }: { isSidebarVisible: boolean } =
    $props();
</script>

<Button.Root
  onclick={() => (isSidebarVisible = !isSidebarVisible)}
  class="shrink-0 p-1 cursor-pointer text-base-900 dark:text-base-100"
>
  <IconBars font-size="1.5rem" />
</Button.Root>
