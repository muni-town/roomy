<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { Alert, Button, cn } from "@fuxui/base";
  import { onMount } from "svelte";

  const {
    class: className,
    children,
    hasSidebar = false,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    hasSidebar?: boolean;
  } = $props();

  let showAlphaWarning = $state(false);
  onMount(() => {
    showAlphaWarning = localStorage.getItem("showAlphaWarning") !== "false";
  });
</script>

{#if showAlphaWarning}
  <div class="p-1.5">
    <Alert type="warning" class="text-sm">
      <span class="flex items-center gap-2"
        >Roomy is in an early "Alpha" state. This means that it is a
        work-in-progress and is under heavy development. Many things may not
        work as expected and data is preserved on a best-effort basis for the
        time being.
        <span class="flex flex-row-reverse grow">
          <Button
            size="sm"
            onclick={() => {
              showAlphaWarning = false;
              localStorage.setItem("showAlphaWarning", "false");
            }}>Dismiss</Button
          >
        </span>
      </span>
    </Alert>
  </div>
{/if}

<div
  class={cn(
    "w-full flex h-16 items-center justify-between p-2 overflow-hidden flex-shrink-0 bg-base-100 dark:bg-base-950 border-b border-base-800/10 dark:border-base-300/10",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
