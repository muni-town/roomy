<script lang="ts">
  import type { Snippet } from "svelte";
  import { IconChevronRight } from "@roomy/design/icons";

  let {
    title,
    description,
    badge,
    open = $bindable(false),
    children,
  }: {
    /** The section's name, shown in its header row. */
    title: string;
    /** One line saying what the integration does, under the title. */
    description: string;
    /** Optional state marker rendered before the chevron. */
    badge?: Snippet;
    /** Whether the body is expanded; the caller owns the state. */
    open?: boolean;
    children: Snippet;
  } = $props();

  const id = $props.id();
</script>

<section
  class="border-b border-base-200 py-4 first:pt-0 last:border-b-0 dark:border-base-800"
>
  <h2>
    <button
      type="button"
      class="flex w-full items-start justify-between gap-4 text-left"
      aria-expanded={open}
      aria-controls={`${id}-panel`}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onclick={() => (open = !open)}
    >
      <span class="min-w-0">
        <span
          id={`${id}-title`}
          class="block text-base font-semibold text-base-900 dark:text-base-100"
        >
          {title}
        </span>
        <span
          id={`${id}-description`}
          class="mt-0.5 block text-sm text-base-500 dark:text-base-400"
        >
          {description}
        </span>
      </span>
      <span class="flex shrink-0 items-center gap-2 pt-0.5">
        {@render badge?.()}
        <IconChevronRight
          font-size={14}
          class="text-base-500 transition-transform duration-150 dark:text-base-400"
          style={open ? "transform: rotate(90deg)" : undefined}
        />
      </span>
    </button>
  </h2>

  {#if open}
    <div
      id={`${id}-panel`}
      role="region"
      aria-labelledby={`${id}-title`}
      class="pt-4"
    >
      {@render children()}
    </div>
  {/if}
</section>
