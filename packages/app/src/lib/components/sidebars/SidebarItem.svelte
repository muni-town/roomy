<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { Badge, Button } from "@fuxui/base";
  // import { atprotoFeedService } from "$lib/services/atprotoFeedService";
  import SidebarItemList from "./SidebarItemList.svelte";
  import type { SpaceTreeItem } from "$lib/queries.svelte";

  import IconLucidePencil from "~icons/lucide/pencil";
  import IconHeroiconsChevronDown from "~icons/heroicons/chevron-down";
  import IconHeroiconsChevronUp from "~icons/heroicons/chevron-up";
  import IconHeroiconsHashtag from "~icons/heroicons/hashtag";
  import IconTablerCornerDownRight from "~icons/tabler/corner-down-right";
  import IconHeroiconsDocument from "~icons/heroicons/document";
  import IconCustomThread from "~icons/custom/thread";

  let {
    item,
    isEditing = $bindable(false),
    level = 0,
    // index = 0,
  }: {
    item: SpaceTreeItem;
    isEditing: boolean;
    level: number;
    index: number;
  } = $props();

  let showGroupChildren = $state(true);
  // TODO: actually handle unreads & subthreads
  let hasUnread = $state(false);
  let isSubthread = $state(false);
  let notificationCount = 0;

  console.log("sidebar level", level, "item", item);

  // let bannedAccounts = $derived(
  //   new CoState(BansComponent, space?.components?.[BansComponent.id]),
  // );
  // let bannedAccountsSet = $derived(new Set(bannedAccounts.current ?? []));

  // const latestEntriesByAccount = $derived(
  //   Object.values(thread?.current?.timeline?.perAccount ?? {})
  //     .filter((x) => x && !bannedAccountsSet.has(x.by?.id ?? ""))
  //     .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime()),
  // );

  // let lastReadDate = $derived(
  //   object?.id ? me?.root?.lastRead?.[object.id] : null,
  // );

  // let hasUnread = $derived.by(() => {
  //   if (!lastReadDate) return latestEntriesByAccount.length !== 0;
  //   if (latestEntriesByAccount.length === 0) return false;
  //   let date = latestEntriesByAccount.at(-1)?.madeAt;
  //   if (!date) return false;

  //   return new Date(lastReadDate) < date;
  // });

  // const notificationCount = $derived(
  //   // Feed objects don't have traditional message notifications
  //   object?.components?.feedConfig
  //     ? 0
  //     : me?.profile?.roomyInbox?.filter(
  //         (x) =>
  //           x?.objectId === object?.id &&
  //           !x?.read &&
  //           !bannedAccountsSet.has(x?._edits?.objectId?.by?.id ?? ""),
  //       ).length,
  // );

  // // Get bookmarks for feed objects
  // let feedBookmarks = $derived.by(() => {
  //   // Only process feed objects with valid account data
  //   if (object?.components?.feedConfig && me && object?.id) {
  //     try {
  //       const bookmarks = atprotoFeedService.getBookmarks(me, object.id);
  //       return bookmarks;
  //     } catch (error) {
  //       console.error("Error getting bookmarks:", error);
  //       return [];
  //     }
  //   }

  //   return [];
  // });
</script>

{#snippet editButton()}
  {#if isEditing}
    <Button
      variant="ghost"
      size="icon"
      onclick={() => "editEntity?.(object)"}
      class="group-hover:opacity-100 opacity-0"
    >
      <IconLucidePencil class="size-4" />
    </Button>
  {/if}
{/snippet}

<!-- {#if object?.components?.feedConfig && !object?.softDeleted}
  <div
    class={[
      "inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink",
      level < 2 ? (index > 0 ? "pb-2" : "pb-2") : "",
    ]}
  >
    <div
      class="inline-flex items-start justify-between gap-2 w-full font-semibold min-w-0 group"
    >
      <Button
        href={navigateSync({
          space: page.params.space!,
          object: object.id,
        })}
        variant="ghost"
        class="w-full justify-start min-w-0"
        data-current={object.id === page.params.object && !isEditing}
      >
        <Icon icon={"mdi:rss"} class="shrink-0" />
        <span class="truncate whitespace-nowrap overflow-hidden min-w-0"
          >{object.name || "..."}</span
        >
      </Button>
      {@render editButton?.()}
    </div>

    {#if feedBookmarks.length > 0 && !isEditing && object.id === page.params.object}
      <div class="pl-4">
        {#each feedBookmarks as bookmark (bookmark.postUri)}
          <div
            class="inline-flex items-start justify-between gap-2 w-full min-w-0 group py-1"
          >
            <Button
              href={`${navigateSync({
                space: page.params.space!,
                object: object.id,
              })}?thread=${encodeURIComponent(bookmark.postUri)}`}
              variant="ghost"
              class="w-full justify-start min-w-0 text-sm font-normal"
              data-current={page.url?.searchParams?.get("thread") ===
                bookmark.postUri}
              onclick={() => {
                console.log("🔍 Bookmark thread clicked:", bookmark.postUri);
                console.log(
                  "🔍 Navigation URL:",
                  `${navigateSync({
                    space: page.params.space!,
                    object: object.id,
                  })}?thread=${encodeURIComponent(bookmark.postUri)}`,
                );
              }}
            >
              <Icon icon="tabler:corner-down-right" class="shrink-0 size-3" />
              <Icon
                icon="mdi:bookmark"
                class="shrink-0 size-3 text-yellow-500"
              />
              <span class="truncate whitespace-nowrap overflow-hidden min-w-0">
                {bookmark.title ||
                  bookmark.previewText?.substring(0, 30) + "..." ||
                  "Bookmarked Thread"}
              </span>
            </Button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else if object?.components?.[ThreadComponent.id] && !object?.softDeleted}
  <div
    class={[
      "inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink",
      level < 2 ? (index > 0 ? "pb-2" : "pb-2") : "",
    ]}
  >
    <div
      class="inline-flex items-start justify-between gap-2 w-full font-semibold min-w-0 group"
    >
      <Button
        href={navigateSync({
          space: page.params.space!,
          object: object.id,
        })}
        variant="ghost"
        class="w-full justify-start min-w-0"
        data-current={object.id === page.params.object && !isEditing}
      >
        {#if hasUnread && !isEditing}
          <div
            class="size-1.5 rounded-full bg-accent-500 absolute left-1.5 top-1.5"
          ></div>
        {/if}
        {#if isSubthread}<Icon icon="tabler:corner-down-right" />{:else}
          <Icon icon={"heroicons:hashtag"} class="shrink-0" />{/if}
        <span class="truncate whitespace-nowrap overflow-hidden min-w-0"
          >{object.name || "..."}</span
        >
        {#if notificationCount && !isEditing}
          <Badge>
            {notificationCount}
          </Badge>
        {/if}
      </Button>
      {@render editButton?.()}
    </div>
    {#if object?.components?.[SubThreadsComponent.id] && !isEditing}
      <div>
        <SidebarObjectList
          children={children.current}
          {me}
          bind:isEditing
          {editEntity}
          currentEntity={object}
          {space}
          level={level + 1}
          subthreads={object.id === page.params.object && !isEditing
            ? subthreads.current
            : undefined}
        />
      </div>
    {/if}
  </div>
{:else if object?.components?.[PageComponent.id] && !object?.softDeleted}
  <div
    class="inline-flex items-start justify-between gap-2 w-full min-w-0 group"
  >
    <Button
      href={navigateSync({
        space: page.params.space!,
        object: object.id,
      })}
      variant="ghost"
      class="w-full justify-start font-semibold min-w-0"
      data-current={object.id === page.params.object && !isEditing}
    >
      <Icon icon={"heroicons:document"} class="shrink-0" />
      <span class="truncate min-w-0 whitespace-nowrap overflow-hidden"
        >{object.name || "..."}</span
      >
    </Button>
    {@render editButton?.()}
  </div> -->
{#if item.type == "category"}
  <!-- Object is a group/folder -->
  <div class="inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink pb-4">
    <div
      class="inline-flex items-start justify-between gap-2 w-full shrink group"
    >
      <Button
        variant="ghost"
        class="w-full shrink min-w-0 justify-start hover:bg-transparent hover:text-base-900 dark:hover:bg-transparent dark:hover:text-base-100 hover:cursor-default active:scale-100"
        data-current={item.id === page.params.object && !isEditing}
        onclick={() => {
          showGroupChildren = !showGroupChildren;
        }}
      >
        <span
          class="truncate font-regular text-base-600 dark:text-base-400 text-xs tracking-wide whitespace-nowrap overflow-hidden min-w-0"
          >{item.name}</span
        >
        {#if showGroupChildren}
          <IconHeroiconsChevronDown class="shrink-0 !size-2" />
        {:else}
          <IconHeroiconsChevronUp class="shrink-0 !size-2" />
        {/if}
      </Button>
      {@render editButton?.()}
    </div>

    <!-- Group children (pages, channels) -->
    {#if showGroupChildren}
      <div class={"w-full max-w-full shrink min-w-0"}>
        <SidebarItemList
          items={item.children}
          bind:isEditing
          level={level + 1}
        />
      </div>
    {/if}
  </div>
{:else if (item.type == "channel" || item.type == "thread") && level < 2}
  <div class="inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink">
    <div
      class="inline-flex items-start justify-between gap-2 w-full min-w-0 group"
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
        {#if isSubthread}<IconTablerCornerDownRight />{:else}
          <IconHeroiconsHashtag class="shrink-0" />{/if}
        <span
          class={[
            "truncate whitespace-nowrap overflow-hidden min-w-0",
            level > 1 ? "font-normal" : "font-semibold",
          ]}>{item.name}</span
        >
        {#if notificationCount && !isEditing}
          <Badge>
            {notificationCount}
          </Badge>
        {/if}
      </Button>
      {@render editButton?.()}
    </div>

    <!-- Group children (pages, channels) -->
    {#if showGroupChildren && item.children && item.children.length > 0}
      <div class={"w-full max-w-full shrink min-w-0"}>
        <SidebarItemList
          items={item.children}
          bind:isEditing
          level={level + 1}
        />
      </div>
    {/if}
  </div>
{:else if level >= 2}
  <div class="inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink">
    <div
      class="inline-flex items-start justify-between w-full min-w-0 group pl-3"
    >
      <div class="max-h-4 overflow-visible">
        <IconCustomThread
          class="shrink-0 stroke-[0.6] stroke-base-500 h-[1.85rem] -mt-2"
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
        <!-- {#if isSubthread}<IconTablerCornerDownRight />{:else}
          <IconHeroiconsHashtag class="shrink-0" />{/if} -->

        <span
          class="truncate whitespace-nowrap overflow-hidden min-w-0 font-normal"
          >{item.name}</span
        >
        {#if notificationCount && !isEditing}
          <Badge>
            {notificationCount}
          </Badge>
        {/if}
        {#if item.type === "page"}<div class="ml-auto">
            <IconHeroiconsDocument class="opacity-60 shrink" />
          </div>{/if}
      </Button>
      {@render editButton?.()}
    </div>
  </div>
{:else if item.type == "page"}
  <div
    class="inline-flex items-start justify-between gap-2 w-full min-w-0 group"
  >
    <Button
      href={navigateSync({
        space: page.params.space!,
        object: item.id,
      })}
      variant="ghost"
      class={[
        "w-full justify-start min-w-0",
        level > 1 ? "font-normal" : "font-semibold",
      ]}
      data-current={item.id === page.params.object && !isEditing}
    >
      <IconHeroiconsDocument class="shrink-0" />
      <span class="truncate min-w-0 whitespace-nowrap overflow-hidden"
        >{item.name}</span
      >
    </Button>
    {@render editButton?.()}
  </div>
{/if}
