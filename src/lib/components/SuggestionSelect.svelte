<script lang="ts">
  let { items, callback }: { items: any[], callback: (item: any) => void } = $props();
  let activeIdx = $state(0);
  let isOpen = $state(false);

  export function setItems(value: any[]) { items = value; }

  export function getIsOpen() { return isOpen; }
  export function setIsOpen(value: boolean) { isOpen = value; }

  export function onKeyDown(event: KeyboardEvent) {
    if (event.repeat) {
      return
    }

    switch (event.key) {
      case "ArrowUp":
        activeIdx = (activeIdx + items.length - 1) % items.length;
        break;
      case "ArrowDown":
        activeIdx = (activeIdx + 1) % items.length;
        break;
      case "Enter":
        callback(items[activeIdx]);
        break;
    }

    return false
  }
</script>

<ul>
  {#each items as item, i}
    <li>
      <button class:active={i === activeIdx} onclick={() => callback(items[i].handle)}>
        {item.handle}
      </button>
    </li>
  {/each}
</ul>

<style>
  .active {
    color: red;
  }

  li {
    cursor: pointer;
  }
</style>