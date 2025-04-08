<script lang="ts">
  import { Button } from "bits-ui";
  import type { Item } from "$lib/tiptap/editor";

  type Option = Item & { category: string };

  type Props = { 
    items: Option[];
    callback: ({ id, label }: { id: string, label: string }) => void;
  }

  let activeIndex = $state(0);
  
  let { items, callback }: Props = $props();

  let categories = $derived.by(() => {
    const name = new Set<string>();
    items.map((i) => name.add(i.category));
    return [...name.values()];
  });

  export function setItems(value: any[]) { items = value; }
  export function onKeyDown(event: KeyboardEvent) {
    if (event.repeat) { return false; }
    switch (event.key) {
      case "ArrowUp": {
        if (activeIndex <= 0) { 
          activeIndex = items.length - 1;
        }
        else {
          activeIndex--;
        }
        return true;
      }
      case "ArrowDown": {
        if (activeIndex >= items.length - 1) { 
          activeIndex = 0;
        }
        else {
          activeIndex++;
        }
        return true;
      }
      case "Enter": {
        const selected = items[activeIndex]!;
        callback({ id: selected.value, label: selected.label });
        return true;
      }
    }

    return false;
  }
</script>

<menu class="bg-violet-900 p-4 flex flex-col gap-3">
  {#each categories as category, c}
    {@const prevCategoryLength = c === 0 ? 0 : items.filter((i) => i.category === categories[c-1]).length}
    <h5 class="uppercase text-gray-300">{category}</h5>
    {#each items.filter((i) => i.category === category) as { value, label, disabled }, i (i + value)}
      {@const actualIndex = i + prevCategoryLength}
      <Button.Root 
        {disabled}
        class={[
          actualIndex === activeIndex && "!border-white", 
          "border border-violet-800 px-3 py-2 flex gap-4 bg-violet-800 text-white rounded cursor-pointer"
        ]}
        onmouseover={() => activeIndex = actualIndex}
        onclick={() => callback({ id: value, label })}
      >
        {label}
      </Button.Root>
    {/each}
  {/each}
</menu>