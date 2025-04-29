<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Accordion, ToggleGroup } from "bits-ui";
  import { page } from "$app/state";
  import { navigate, type NavigationTarget } from "$lib/utils.svelte";
  import type { NamedEntity } from "@roomy-chat/sdk";
  import { slide } from "svelte/transition";

  type Section = {
    items: { value: NamedEntity[] };
    route: "channel" | "thread";
    key: string;
  };
  let {
    items,
    active = $bindable(),
  }: {
    items: Section[];
    active: string;
  } = $props();
  let keys = $derived(items.map((i) => i.key));
</script>

<ToggleGroup.Root type="single" value={active}>
  <Accordion.Root
    type="multiple"
    bind:value={keys}
    class="flex flex-col px-2 gap-4"
  >
    {#each items as { key, ...section }, i (key)}
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
                {#each section.items.value as { id, name }}
                  <ToggleGroup.Item
                    onclick={() => {
                      const target: NavigationTarget = {
                        space: page.params.space!,
                      };
                      target[section.route] = id;
                      navigate(target);
                    }}
                    value={id}
                    class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
                  >
                    <div
                      class="flex justify-start items-center gap-2 px-2 w-full"
                    >
                      <Icon
                        icon="material-symbols:thread-unread-rounded"
                        class="shrink-0"
                      />
                      <span class="truncate">{name}</span>
                    </div>
                  </ToggleGroup.Item>
                {/each}
              </div>
            {/if}
          {/snippet}
        </Accordion.Content>
      </Accordion.Item>
    {/each}
  </Accordion.Root>
</ToggleGroup.Root>
