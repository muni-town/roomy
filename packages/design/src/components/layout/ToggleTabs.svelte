<script lang="ts">
  import { goto } from "$app/navigation";
  import { Tabs } from "bits-ui";

  let {
    items,
    active = $bindable(),
  }: {
    items: { name: string; href: string }[];
    active: string;
  } = $props();


</script>

<div class="hidden md:block shrink-0">
  <Tabs.Root bind:value={active}>
    <Tabs.List
      class="rounded-lg text-base-950 dark:text-base-100"
      style="display: inline-grid; grid-auto-flow: column; grid-auto-columns: 2fr;"
    >
      {#each items as { name, href }}
        <Tabs.Trigger value={name}>
          {#snippet child({ props })}
            <a
              {href}
              {...props}
              class="
              text-center
              px-2 py-1 cursor-pointer w-full text-xs
              bg-base-200 dark:bg-transparent
              text-base-950 dark:text-base-100
              hover:bg-base-50 hover:dark:bg-base-950/40

              border border-y first:border-l last:border-r border-base-500 dark:border-base-800
              first:rounded-l-md last:rounded-r-md not-first:-ml-px
              
              transition-[box-shadow,translate] ease-in duration-75
                
              -translate-y-[2px]
              shadow-[0_2px_0_0_var(--shadow-button-color,var(--color-base-500))]
              [--shadow-button-color:var(--color-base-500)] dark:[--shadow-button-color:var(--color-base-800)]
              
              active:translate-y-0
              active:shadow-none
              
              data-[state=active]:bg-white
              data-[state=active]:dark:bg-base-950/40
              data-[state=active]:text-base-950
              data-[state=active]:dark:text-base-100
              data-[state=active]:translate-y-0
              data-[state=active]:shadow-none
              "
            >
              {name}
            </a>
          {/snippet}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>
  </Tabs.Root>
</div>
<div class="block md:hidden shrink-0">
  <button
    onclick={() => {
      const i = items.findIndex((item) => item.name === active);
      const next = items[(i + 1) % items.length];
      if (next) {
        active = next.name;
        goto(next.href);
      }
    }}
    class="rounded-[10px] flex items-center gap-1 bg-base-50 dark:bg-transparent px-2 py-0.5 text-xs border border-base-500 dark:border-base-800 text-base-950 dark:text-base-100 hover:bg-base-50 hover:dark:bg-base-950/40 hover:border-base-600 hover:shadow-button transition-all duration-75 ease-out"
    aria-label="Switch to next tab"
  >
    {active}
  </button>
</div>