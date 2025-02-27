<script lang="ts">
  import { Button } from "bits-ui";

  interface Item {
    value: string;
    label: string;
    disabled?: boolean;
    [x: string]: unknown;
  }

  type Props = { 
    items: Item[];
    callback: ({ id, label }: { id: string, label: string }) => void;
  }

  let activeIndex = $state(0);
  
  let { items, callback }: Props = $props();
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
        const selected = items[activeIndex];
        callback({ id: selected.value, label: selected.label });
        return true;
      }
    }

    return false;
  }
</script>

<menu class="bg-violet-900 p-4 flex flex-col gap-3">
  {#each items as { value, label, disabled }, i (i + value)}
    <Button.Root 
      {disabled}
      class={[
        i === activeIndex && "!border-red-500", 
        "border border-violet-800 px-3 py-2 flex gap-4 bg-violet-800 text-white rounded cursor-pointer"
      ]}
      onmouseover={() => activeIndex = i}
      onclick={() => callback({ id: value, label })}
    >
      {label}
    </Button.Root>
  {/each}
</menu>