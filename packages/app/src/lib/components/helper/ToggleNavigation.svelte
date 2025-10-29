<script lang="ts">
  import IconHeroiconsBars4 from "~icons/heroicons/bars-4";
  import { Button } from "bits-ui";

  let { isSidebarVisible = $bindable() }: { isSidebarVisible: boolean } =
    $props();
</script>

<Button.Root
  onclick={() => (isSidebarVisible = !isSidebarVisible)}
  class="shrink-0 p-1 cursor-pointer text-base-900 dark:text-base-100"
>
  <IconHeroiconsBars4 font-size="1.5rem" />
</Button.Root>
