<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    name,
    description,
    href,
    avatar,
  }: {
    name: string | undefined;
    description?: string | undefined;
    href: string | undefined;
    avatar: Snippet;
  } = $props();
</script>

<div class="relative flex flex-col items-center justify-start gap-2 max-w-42">
  {@render avatar()}

  <span class="text-lg font-semibold text-center">{name}</span>

  {#if description}
    <p
      class="text-sm text-base-500 dark:text-base-400 max-w-full text-center line-clamp-3"
    >
      {description}
    </p>
  {/if}

  {#if href}
    <a
      {href}
      class="absolute -inset-2 hover:bg-accent-500/5 rounded-xl"
    >
      <span class="sr-only">Go to {name}</span>
    </a>
  {/if}
</div>
