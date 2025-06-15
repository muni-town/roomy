<script lang="ts">
  import { page } from "$app/state";
  // import type { NamedEntity } from "@roomy-chat/sdk";
  import type { Snippet } from "svelte";

  let {
    title,
    items,
    route,
    children,
    header,
  }: {
    title: string;
    items: any[];
    route: string;
    selected?: boolean;
    children?: Snippet;
    header?: Snippet;
  } = $props();
  let itemLink = (item: { id: string }) =>
    `${page.params.space?.includes(".") ? "/-" : ""}/${page.params.space}/${route}/${item.id}`;
</script>

<div class="flex justify-between items-center">
  <h3 class="text-xl font-bold text-base-content">{title}</h3>
  {@render header?.()}
</div>
<ul class="dz-list w-full dz-join dz-join-vertical rounded">
  {#each items as item}
    {#if item}
      <a href={itemLink(item)}>
        <li
          class="dz-list-row dz-card-title dz-join-item bg-base-200 text-md group w-full"
        >
          {item.name}
        </li>
      </a>
    {/if}
  {:else}
    {@render children?.()}
  {/each}
</ul>
