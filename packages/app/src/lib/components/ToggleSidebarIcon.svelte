<script lang="ts">
  import type { Toggle } from "$lib/utils.svelte";

  let {
    open,
    class: classNames = "",
  }: { open: ReturnType<typeof Toggle>; class: string } = $props();
  const handleClick = () => open.toggle();
</script>

<button
  class="btn btn-ghost group {classNames}"
  onclick={handleClick}
  title="Open Spaces Sidebar"
  aria-label="open space sidebar"
>
  <div class="w-[1.375rem] h-[1rem] border-2 border-base-content rounded-sm">
    <div
      class="h-full border-r-2 border-base-content transition-all ease-out {open.value
        ? 'w-[40%] bg-base-content/50 border-base-content/50 group-hover:w-[15%]'
        : 'w-[25%] group-hover:w-[55%]'}
      "
    ></div>
  </div>
</button>
