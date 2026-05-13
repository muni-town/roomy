<script lang="ts">
  import { Tooltip } from "bits-ui";
  import type { Snippet } from "svelte";

  type Props = Tooltip.RootProps & {
    tip: string | Snippet;
    children?: Snippet;
    trigger?: Snippet<[Record<string, unknown>]>;
    contentProps?: Tooltip.ContentProps;
  };

  let { tip, children, trigger, contentProps = {}, ...restProps }: Props = $props();
</script>

<Tooltip.Root delayDuration={200} {...restProps}>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      {#if trigger}
        {@render trigger(props)}
      {:else}
        {@render children?.()}
      {/if}
    {/snippet}
  </Tooltip.Trigger>

  <Tooltip.Portal>
    <Tooltip.Content
      sideOffset={contentProps.sideOffset ?? 6}
      side={contentProps.side ?? "top"}
      class={contentProps.class}
    >
      <span
        class="rounded-lg border-base-200 dark:border-base-800 shadow-xs bg-base-100/80 dark:bg-base-900/80 text-base-800/75 dark:text-base-200/75 outline-hidden z-0 flex items-center justify-center border p-1 px-2 text-sm"
      >
        {#if typeof tip === "string"}
          {tip}
        {:else}
          {@render tip()}
        {/if}
      </span>
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>
