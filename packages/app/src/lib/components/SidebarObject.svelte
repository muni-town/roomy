<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { Badge, Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import {
    BansComponent,
    ChildrenComponent,
    co,
    PageComponent,
    RoomyAccount,
    RoomyEntity,
    ThreadComponent,
  } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import SidebarObjectList from "./SidebarObjectList.svelte";

  let {
    object,
    me,
    isEditing = $bindable(false),
    editEntity,
    space,
    level = 0,
    index = 0,
  }: {
    object: co.loaded<typeof RoomyEntity> | null | undefined;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
    isEditing?: boolean;
    editEntity?: (entity: co.loaded<typeof RoomyEntity>) => void;
    space: co.loaded<typeof RoomyEntity> | undefined | null;
    level?: number;
    index?: number;
  } = $props();

  let children = $derived(
    new CoState(
      ChildrenComponent.schema,
      object?.components?.[ChildrenComponent.id],
      {
        resolve: {
          $each: {
            components: {
              $each: true,
              $onError: null,
            },
          },
          $onError: null,
        },
      },
    ),
  );

  const thread = $derived(
    object?.components?.[ThreadComponent.id]
      ? new CoState(
          ThreadComponent.schema,
          object?.components?.[ThreadComponent.id],
        )
      : null,
  );

  let bannedAccounts = $derived(
    new CoState(BansComponent.schema, space?.components?.[BansComponent.id]),
  );
  let bannedAccountsSet = $derived(new Set(bannedAccounts.current ?? []));

  const latestEntriesByAccount = $derived(
    Object.values(thread?.current?.timeline?.perAccount ?? {})
      .filter((x) => x && !bannedAccountsSet.has(x.by?.id ?? ""))
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime()),
  );

  let lastReadDate = $derived(
    object?.id ? me?.root?.lastRead?.[object.id] : null,
  );

  let hasUnread = $derived.by(() => {
    if (!lastReadDate) return latestEntriesByAccount.length !== 0;
    if (latestEntriesByAccount.length === 0) return false;
    let date = latestEntriesByAccount.at(-1)?.madeAt;
    if (!date) return false;

    return new Date(lastReadDate) < date;
  });

  const notificationCount = $derived(
    me?.profile?.roomyInbox?.filter(
      (x) =>
        x?.objectId === object?.id &&
        !x?.read &&
        !bannedAccountsSet.has(x?._edits?.objectId?.by?.id ?? ""),
    ).length,
  );
</script>

{#snippet editButton()}
  {#if isEditing && object}
    <Button variant="ghost" size="icon" onclick={() => editEntity?.(object)} class="group-hover:opacity-100 opacity-0">
      <Icon icon="lucide:pencil" class="size-4" />
    </Button>
  {/if}
{/snippet}

{#if object?.components?.[ThreadComponent.id] && !object?.softDeleted}
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
      {#if hasUnread}
        <div
          class="size-1.5 rounded-full bg-accent-500 absolute left-1.5 top-1.5"
        ></div>
      {/if}
      <Icon icon={"heroicons:hashtag"} class="shrink-0" />
      <span class="truncate whitespace-nowrap overflow-hidden min-w-0"
        >{object.name || "..."}</span
      >
      {#if notificationCount}
        <Badge>
          {notificationCount}
        </Badge>
      {/if}
    </Button>
    {@render editButton?.()}
  </div>
{:else if object?.components?.[PageComponent.id] && !object?.softDeleted}
  <div class="inline-flex items-start justify-between gap-2 w-full min-w-0 group">
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
  </div>
{:else if object?.components?.[ChildrenComponent.id] && !object?.softDeleted}
  <div
    class={[
      "inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink",
      level < 2 ? (index > 0 ? "py-2" : "pb-2") : "",
    ]}
  >
    <div class="inline-flex items-start justify-between gap-2 w-full shrink group">
      <Button
        variant="ghost"
        class="w-full shrink min-w-0 justify-start hover:bg-transparent hover:text-base-900 dark:hover:bg-transparent dark:hover:text-base-100 hover:cursor-default active:scale-100"
        data-current={object.id === page.params.object && !isEditing}
      >
        <span
          class="truncate font-normal whitespace-nowrap overflow-hidden min-w-0"
          >{object.name || "..."}</span
        >
        <Icon icon={"heroicons:chevron-down"} class="shrink-0 !size-3" />
      </Button>
      {@render editButton?.()}
    </div>

    <div
      class={["w-full max-w-full shrink min-w-0", level > 2 ? "pl-3" : "pl-1"]}
    >
      <SidebarObjectList
        children={children.current}
        {me}
        bind:isEditing
        {editEntity}
        currentEntity={object}
        {space}
        level={level + 1}
      />
    </div>
  </div>
{:else if object?.id && !object?.softDeleted}
  <div class="flex items-start justify-between gap-2 w-full group">
    <Button
      href={navigateSync({
        space: page.params.space!,
        object: object.id,
      })}
      variant="ghost"
      class="w-full justify-start"
      data-current={object.id === page.params.object && !isEditing}
    >
      <Icon icon={"heroicons:question-mark-circle"} class="shrink-0" />
      <span class="truncate">{object.name || "..."}</span>
    </Button>
    {@render editButton?.()}
  </div>
{/if}
