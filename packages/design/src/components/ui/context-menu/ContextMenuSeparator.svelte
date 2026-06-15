<script lang="ts">
  import { cn } from "../../../utils/index.js";

  let {
    class: className,
    ...restProps
  }: {
    class?: string;
  } = $props();
</script>

<hr
  class={cn("mx-1 my-1 h-px border-none bg-base-200 dark:bg-base-800", className)}
  {...restProps}
/>
