<script lang="ts">
  import { page } from "$app/state";
  import type { NamedEntity } from "@roomy-chat/sdk";
  import type { Snippet } from "svelte";

  let {
    title,
    items,
    route,
    children,
    header,
  }: {
    title: string;
    items: NamedEntity[];
    route: string;
    selected?: boolean;
    children?: Snippet;
    header?: Snippet;
  } = $props();
</script>

<div class="flex justify-between items-center">
  <h3 class="text-xl font-bold text-base-content">{title}</h3>
  {@render header?.()}
</div>
<ul class="list w-full join join-vertical rounded">
  {#each items as item}
    <a href={`/${page.params.space}/${route}/${item.id}`}>
      <li
        class="list-row card-title join-item bg-base-200 text-md group w-full text-content-primary"
      >
        {item.name}
      </li>
    </a>
  {:else}
    {@render children?.()}
  {/each}
</ul>
