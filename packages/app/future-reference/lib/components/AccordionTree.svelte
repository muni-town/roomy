<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Accordion, Button } from "bits-ui";
  import { page } from "$app/state";
  import { navigateSync, type NavigationTarget } from "$lib/utils.svelte";
  import { slide } from "svelte/transition";
  import { CoState } from "jazz-tools/svelte";
  import { Space, isSpaceAdmin } from "@roomy-chat/sdk";

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        channels: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  type Item = { target: NavigationTarget; name: string; id: string };
  type Section = {
    items: Item[];
    key: string;
  };

  let {
    sections,
  }: {
    sections: Section[];
    active: string;
  } = $props();

  console.log("sections", sections);
  console.log("page", page.params.space);
  let keys = $derived(sections.map((i) => i.key));

  async function deleteItem(key: string, item: Item) {
    if (!space.current) return;
    if (!confirm(`Are you sure you want to delete "${item.name}"?`)) return;

    if (key === "threads") {
      const thread = space.current.threads?.find((t) => t?.id === item.id);
      if (thread) {
        thread.softDeleted = true;
      }
    } else if (key === "pages") {
      const page = space.current.pages?.find((p) => p?.id === item.id);
      console.log("page", page);
      if (page) {
        page.softDeleted = true;
      }
    }
  }
</script>

<Accordion.Root
  type="multiple"
  bind:value={keys}
  class="flex flex-col px-2 gap-2"
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
                  <div class="group flex items-center gap-1">
                    <Button.Root
                      href={navigateSync(item.target)}
                      class="flex-1 cursor-pointer items-center gap-2 px-3 dz-btn dz-btn-ghost justify-start border {active
                        ? 'border-primary text-primary'
                        : ' border-transparent'}"
                    >
                      <Icon
                        icon="material-symbols:thread-unread-rounded"
                        class="shrink-0"
                      />
                      <span class="truncate">{item.name} </span>
                    </Button.Root>
                    {#if isSpaceAdmin(space.current)}
                      <Button.Root
                        title="Delete"
                        class="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer dz-btn dz-btn-ghost dz-btn-circle text-error hover:bg-error/10"
                        onclick={() => deleteItem(key, item)}
                      >
                        <Icon icon="lucide:x" class="size-4" />
                      </Button.Root>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          {/snippet}
        </Accordion.Content>
      </Accordion.Item>
    {/if}
  {/each}
</Accordion.Root>
