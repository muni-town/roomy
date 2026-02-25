<script lang="ts">
  /***
   * From Fox UI by Flo-bit
   * https://github.com/flo-bit/ui-kit/tree/main/packages/text/src/lib/components/rich-text-editor
   */

  import { cn, toggleVariants } from "@foxui/core";
  import { Select, type WithoutChildren } from "bits-ui";
  import Icon from "./Icon.svelte";

  type Props = WithoutChildren<Select.RootProps> & {
    placeholder?: string;
    items: { value: string; label: string; disabled?: boolean }[];
    contentProps?: WithoutChildren<Select.ContentProps>;
  };

  let {
    value = $bindable(),
    items,
    contentProps,
    placeholder,
    ...restProps
  }: Props = $props();
</script>

<Select.Root bind:value={value as never} {...restProps}>
  <Select.Trigger>
    {#snippet child({ props })}
      <button {...props} class={cn(toggleVariants({ size: "sm" }), "gap-1")}>
        {#if value}
          <Icon name={value as any} />
        {:else}
          <span class="size-3.5">?</span>
        {/if}

        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          class="!size-2.5"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="m19.5 8.25-7.5 7.5-7.5-7.5"
          />
        </svg>
      </button>
    {/snippet}
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      {...contentProps}
      class={cn(
        "bg-base-50/50 border-base-500/20 overflow-hidden rounded-2xl border shadow-lg backdrop-blur-xl",
        "dark:bg-base-900/50 dark:border-base-500/10",
        "motion-safe:animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        contentProps?.class,
      )}
      sideOffset={6}
    >
      <Select.ScrollUpButton>up</Select.ScrollUpButton>
      <Select.Viewport
        class="divide-base-300/30 dark:divide-base-800 divide-y text-sm"
      >
        {#each items as { value, label, disabled } (value)}
          <Select.Item {value} {label} {disabled}>
            {#snippet children({ selected })}
              <div
                class={cn(
                  "text-base-900 dark:text-base-200 group relative isolate flex min-w-28 cursor-pointer items-center gap-3 px-3 py-2 font-medium [&_svg]:size-3.5",
                  selected
                    ? "text-accent-700 dark:text-accent-400 bg-accent-500/10"
                    : "hover:bg-accent-500/10",
                )}
              >
                <Icon name={value as any} />
                {label}
              </div>
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
      <Select.ScrollDownButton>down</Select.ScrollDownButton>
    </Select.Content>
  </Select.Portal>
</Select.Root>
