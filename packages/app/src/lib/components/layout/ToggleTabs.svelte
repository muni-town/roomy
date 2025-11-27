<script lang="ts">
  import { goto } from "$app/navigation";
  import { Tabs } from "bits-ui";
  import { Select } from "bits-ui";
  // using a binding for active
  // `bind:active={activeTab}` instead of `active={activeTab}`
  // has the same result in without needing an effect.
  // did not fully check how this affects browser history
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
      class="rounded-[12px] bg-base-200/50 dark:bg-base-900/50 grid grid-cols-{items.length} p-[2px] text-sm border border-base-800/10 dark:border-base-100/10"
    >
      {#each items as { name, href }}
        <a {href}>
          <Tabs.Trigger
            value={name}
            class="px-2 py-1 cursor-pointer w-full opacity-60 data-[state=active]:opacity-100 rounded-[10px] bg-transparent data-[state=active]:bg-base-200 dark:data-[state=active]:bg-base-900 transition-colors duration-75 ease-out"
          >
            {name}
          </Tabs.Trigger>
        </a>
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
      class="rounded-[12px] flex items-center gap-1 bg-base-100 dark:bg-base-900 p-1 px-4 text-sm border border-base-800/10 dark:border-base-100/10"
      aria-label="Select a tab"
    >
      {active}
    </Select.Trigger>
    <Select.Portal>
      <Select.Content
        class="z-20 rounded-[12px] bg-base-100 dark:bg-base-900 text-sm border border-base-800/10 dark:border-base-100/10"
        sideOffset={10}
      >
        <Select.Viewport class="p-1">
          {#each items as { name, href }}
            <Select.Item
              class="px-4 py-2 cursor-pointer w-full opacity-60 data-[state=active]:opacity-100 data-[state=active]:bg-accent-100 rounded-[10px] bg-transparent dark:data-[state=active]:bg-base-800 transition-colors duration-75 ease-out"
              value={name}
              label={name}
              data-state={active === name ? "active" : "inactive"}
            >
              <a {href}>
                {name}
              </a>
            </Select.Item>
          {/each}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
</div>
