<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { Badge, Button } from "@fuxui/base";
  // import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  import type { SidebarItem } from "$lib/queries";

  import { IconPencil, IconHashtag, IconCornerDownRight, IconDocument } from "@roomy/design/icons";
  import LinkedRoomsList from "./LinkedRoomsList.svelte";
  import { Ulid } from "@roomy/sdk";

  let {
    item,
    isEditing = $bindable(false),
    editSidebarItem,
  }: {
    item: SidebarItem;
    isEditing: boolean;
    index?: number;
    editSidebarItem: (id: { room: Ulid } | { category: string }) => void;
  } = $props();

  // let showEditModal = $state(false);
  // let editName = $state(item.name);
  // TODO: actually handle unreads & subthreads
  let hasUnread = $state(false);
  let isSubthread = $state(false);
  // let notificationCount = 0;

  const itemActive = $derived(
    page.params.object === item.id ||
      page.url.searchParams.get("parent") === item.id,
  );
</script>

{#snippet editButton()}
  {#if isEditing && item.type !== "space.roomy.category"}
    <Button
      variant="ghost"
      size="icon"
      onclick={() => editSidebarItem({ room: item.id as Ulid })}
      class="group-hover:opacity-100 opacity-20"
    >
      <IconPencil class="size-4" />
    </Button>
  {:else if item.type === "space.roomy.category"}{:else if !itemActive && item.unreadCount > 0}
    <Badge>
      {item.unreadCount}
    </Badge>
  {:else if !itemActive && item.lastRead === 1 && item.unreadCount > 0}
    <Badge>🌟</Badge>
  {/if}
{/snippet}

{#if item.type == "space.roomy.channel"}
  <div class="inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink">
    <div
      class="inline-flex items-center justify-between gap-2 w-full min-w-0 group"
    >
      <Button
        href={navigateSync({
          space: page.params.space!,
          object: item.id,
        })}
        variant="ghost"
        class="w-full justify-start min-w-0"
        data-current={item.id === page.params.object && !isEditing}
      >
        {#if hasUnread && !isEditing}
          <div
            class="size-1.5 rounded-full bg-accent-500 absolute left-1.5 top-1.5"
          ></div>
        {/if}
        {#if isSubthread}<IconCornerDownRight />{:else}
          <IconHashtag class="shrink-0" />{/if}
        <span
          class={[
            "truncate whitespace-nowrap overflow-hidden min-w-0 font-semibold",
          ]}>{item.name}</span
        >
      </Button>
      {@render editButton?.()}
    </div>

    <!-- Group children (pages, channels) -->
    {#if itemActive && !isEditing}
      <div class={"w-full max-w-full shrink min-w-0"}>
        <LinkedRoomsList bind:roomId={item.id as Ulid} />
      </div>
    {/if}
  </div>
  <!-- {:else if level >= 2 || item.type == "space.roomy.thread"}
  <div class="inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink">
    <div
      class="inline-flex items-start justify-between w-full min-w-0 group pl-3"
    >
      <div class="max-h-4 overflow-visible">
        <IconCustomThread
          class="shrink-0 stroke-[0.6] stroke-base-500 h-[1.85rem] -mt-2 ml-[2px] -mr-[2px]"
        />
      </div>
      <Button
        href={navigateSync({
          space: page.params.space!,
          object: item.id,
        })}
        variant="ghost"
        class="w-full justify-start min-w-0 px-1 rounded-sm py-1 text-base-600"
        data-current={item.id === page.params.object && !isEditing}
      >
        {#if hasUnread && !isEditing}
          <div
            class="size-1.5 rounded-full bg-accent-500 absolute left-1.5 top-1.5"
          ></div>
        {/if}
        <!-- {#if isSubthread}<IconCornerDownRight />{:else}
          <IconHashtag class="shrink-0" />{/if} --

        <span
          class="truncate whitespace-nowrap overflow-hidden min-w-0 font-normal"
          >{item.name}</span
        >
        {#if notificationCount && !isEditing}
          <Badge>
            {notificationCount}
          </Badge>
        {/if}
        <!-- {#if item.type === "space.roomy.page"}<div class="ml-auto">
            <IconDocument class="opacity-60 shrink" />
          </div>{/if} --
      </Button>
      {@render editButton?.()}
    </div>
  </div> -->
{:else if item.type == "space.roomy.page"}
  <div
    class="inline-flex items-center justify-between gap-2 w-full min-w-0 group"
  >
    <Button
      href={navigateSync({
        space: page.params.space!,
        object: item.id,
      })}
      variant="ghost"
      class={["w-full justify-start min-w-0 font-semibold"]}
      data-current={item.id === page.params.object && !isEditing}
    >
      <IconDocument class="shrink-0" />
      <span class="truncate min-w-0 whitespace-nowrap overflow-hidden"
        >{item.name}</span
      >
    </Button>
    {@render editButton?.()}
  </div>
{/if}
