<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Accordion, Button } from "bits-ui";
  import { page } from "$app/state";
  import { navigateSync, type NavigationTarget } from "$lib/utils.svelte";
  import { slide } from "svelte/transition";

  type Item = { target: NavigationTarget; name: string; id: string };
  type Section = {
    items: Item[];
    key: string;
  };
  let {
    sections,
    active = $bindable(),
  }: {
    sections: Section[];
    active: string;
  } = $props();
  let keys = $derived(sections.map((i) => i.key));
</script>

<Accordion.Root
  type="multiple"
  bind:value={keys}
  class="flex flex-col px-2 gap-4"
>
  {#each sections as { key, ...section }, i (key)}
    {#if section.items.length > 0}
      {#if i > 0}
        <div class="dz-divider my-0"></div>
      {/if}
      <Accordion.Item value={key}>
        <Accordion.Header>
          <Accordion.Trigger
            class="cursor-pointer px-2 flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
          >
            <h3>{key}</h3>
            <Icon
              icon="basil:caret-up-solid"
              class="size-4 shrink-0 transition-transform duration-150 ms {keys.includes(
                key,
              ) && 'rotate-180'}"
            />
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content forceMount>
          {#snippet child({ open }: { open: boolean })}
            {#if open}
              <div
                transition:slide={{ duration: 100 }}
                class="flex flex-col gap-1"
              >
                {#each section.items as item}
                  {@const active =
                    item.id === page.params.channel ||
                    item.id === page.params.thread ||
                    item.id === page.params.page}
                  <Button.Root
                    href={navigateSync(item.target)}
                    class="flex cursor-pointer items-center gap-2 px-3 w-full dz-btn dz-btn-ghost justify-start border {active
                      ? 'border-primary text-primary'
                      : ' border-transparent'}"
                  >
                    <Icon
                      icon="material-symbols:thread-unread-rounded"
                      class="shrink-0"
                    />
                    <span class="truncate">{item.name} </span>
                  </Button.Root>
                {/each}
              </div>
            {/if}
          {/snippet}
        </Accordion.Content>
      </Accordion.Item>
    {/if}
  {/each}
</Accordion.Root>
