<script lang="ts">
  import { goto } from "$app/navigation";
  import { Tabs } from "bits-ui";
  import { Select } from "bits-ui";

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
      class="rounded-lg text-accent-950 dark:text-accent-100"
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
              bg-accent-200 dark:bg-transparent
              text-base-950 dark:text-accent-100
              hover:bg-accent-50 hover:dark:bg-accent-950/40

              border border-y first:border-l last:border-r border-accent-500 dark:border-accent-800
              first:rounded-l-md last:rounded-r-md not-first:-ml-px
              
              transition-[box-shadow,translate] ease-in duration-75
                
              -translate-y-[2px]
              shadow-[0_2px_0_0_var(--shadow-button-color,var(--color-accent-500))]
              [--shadow-button-color:var(--color-accent-500)] dark:[--shadow-button-color:var(--color-accent-800)]
              
              active:translate-y-0
              active:shadow-none
              
              data-[state=active]:bg-base-50
              data-[state=active]:dark:bg-accent-950/40
              data-[state=active]:text-accent-950
              data-[state=active]:dark:text-accent-100
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
  <Select.Root
    bind:value={active}
    onValueChange={(name) => {
      const selected = items.find((item) => item.name === name);
      if (selected) goto(selected.href);
    }}
    type="single"
  >
    <Select.Trigger
      class="rounded-[10px] flex items-center gap-1 bg-base-50 dark:bg-transparent px-2 py-0.5 text-xs border border-accent-500 dark:border-accent-800 text-accent-950 dark:text-accent-100 hover:bg-accent-50 hover:dark:bg-accent-950/40 hover:border-accent-600 hover:shadow-button transition-all duration-75 ease-out"
      aria-label="Select a tab"
    >
      {active}
    </Select.Trigger>
    <Select.Portal>
      <Select.Content
        class="z-20 rounded-[10px] bg-base-50 dark:bg-transparent text-xs border border-accent-500 dark:border-accent-800 text-accent-950 dark:text-accent-100"
        sideOffset={10}
      >
        <Select.Viewport class="p-1">
          {#each items as { name, href }}
            <Select.Item
              class="px-3 py-1.5 cursor-pointer w-full opacity-60 data-[state=active]:opacity-100 data-[state=active]:bg-accent-50 dark:data-[state=active]:bg-accent-950/40 rounded-[8px] bg-transparent text-accent-950 dark:text-accent-100 hover:bg-accent-50 hover:dark:bg-accent-950/40 transition-all duration-75 ease-out"
              value={name}
              label={name}
              data-state={active === name ? "active" : "inactive"}
            >
              <a {href} class="text-accent-950 dark:text-accent-100">
                {name}
              </a>
            </Select.Item>
          {/each}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
</div>