<script lang="ts">
  import Icon from "@iconify/svelte";
  import { Accordion, ToggleGroup } from "bits-ui";
  import SidebarChannelList from "$lib/components/SidebarChannelList.svelte";
  import SidebarThreadList from "$lib/components/SidebarThreadList.svelte";
  import { g } from "$lib/global.svelte";

  let { availableThreads, sidebarItems } = $props();
  let sidebarAccordionValues = $state(["channels", "threads"]);
</script>

<ToggleGroup.Root type="single" value={g.channel?.id}>
  <Accordion.Root
    type="multiple"
    bind:value={sidebarAccordionValues}
    class="flex flex-col gap-4"
  >
    <Accordion.Item value="channels">
      <Accordion.Header>
        <Accordion.Trigger
          class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
        >
          <h3>Channels</h3>
          <Icon
            icon="basil:caret-up-solid"
            class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("channels") && "rotate-180"}`}
          />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content forceMount>
        {#snippet child({ open }: { open: boolean })}
          {#if open}
            <SidebarChannelList {sidebarItems} />
          {/if}
        {/snippet}
      </Accordion.Content>
    </Accordion.Item>
    {#if availableThreads.value.length > 0}
      <div class="divider my-0"></div>
      <Accordion.Item value="threads">
        <Accordion.Header>
          <Accordion.Trigger
            class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
          >
            <h3>Threads</h3>
            <Icon
              icon="basil:caret-up-solid"
              class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("threads") && "rotate-180"}`}
            />
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Content>
          {#snippet child({ open }: { open: boolean })}
            {#if open}
              <SidebarThreadList {availableThreads} />
            {/if}
          {/snippet}
        </Accordion.Content>
      </Accordion.Item>
    {/if}
  </Accordion.Root>
</ToggleGroup.Root>
