<script lang="ts">
  import { page } from "$app/state";
  import { navigateSync } from "$lib/utils.svelte";
  import { Badge, Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import {
    ChildrenComponent,
    co,
    PageComponent,
    RoomyAccount,
    RoomyEntity,
    ThreadComponent,
    ThreadContent,
  } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import SidebarObjectList from "./SidebarObjectList.svelte";

  let {
    object,
    me,
  }: {
    object: co.loaded<typeof RoomyEntity> | null | undefined;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
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
    object?.components?.thread
      ? new CoState(ThreadContent, object?.components?.thread)
      : null,
  );

  const latestEntriesByAccount = $derived(
    Object.values(thread?.current?.timeline?.perAccount ?? {}).sort(
      (a, b) => a.madeAt.getTime() - b.madeAt.getTime(),
    ),
  );

  let lastReadDate = $derived(object?.id ? me?.root?.lastRead?.[object.id] : null);

  let hasUnread = $derived.by(() => {
    if (!lastReadDate) return latestEntriesByAccount.length !== 0;
    if (latestEntriesByAccount.length === 0) return false;
    let date = latestEntriesByAccount.at(-1)?.madeAt;
    if (!date) return false;

    return new Date(lastReadDate) < date;
  });

  const notificationCount = $derived(
    me?.profile?.roomyInbox?.filter((x) => x?.objectId === object?.id && !x?.read)
      .length,
  );
</script>

{#if object?.components?.[ThreadComponent.id]}
  <Button
    href={navigateSync({
      space: page.params.space!,
      object: object.id,
    })}
    variant="ghost"
    class="w-full justify-start"
    data-current={object.id === page.params.object}
  >
    {#if hasUnread}
      <div
        class="size-1.5 rounded-full bg-accent-500 absolute left-1.5 top-1.5"
      ></div>
    {/if}
    <Icon icon={"tabler:message-circle"} class="shrink-0" />
    <span class="truncate">{object.name || "..."}</span>
    {#if notificationCount}
      <Badge>
        {notificationCount}
      </Badge>
    {/if}
  </Button>
{:else if object?.components?.[PageComponent.id]}
  <Button
    href={navigateSync({
      space: page.params.space!,
      object: object.id,
    })}
    variant="ghost"
    class="w-full justify-start"
    data-current={object.id === page.params.object}
  >
    <Icon icon={"tabler:file-text"} class="shrink-0" />
    <span class="truncate">{object.name || "..."}</span>
  </Button>
{:else if object?.components?.[ChildrenComponent.id]}
  <div class="flex flex-col gap-1 w-full">
    <Button
      variant="ghost"
      class="w-full justify-start hover:bg-transparent hover:text-base-900 dark:hover:bg-transparent dark:hover:text-base-100 hover:cursor-default active:scale-100"
      data-current={object.id === page.params.object}
    >
      <Icon icon={"tabler:folder"} class="shrink-0" />
      <span class="truncate">{object.name || "..."}</span>
    </Button>

    <div class="pl-3 w-full">
      <SidebarObjectList children={children.current} {me} />
    </div>
  </div>
{:else if object?.id}
  <Button
    href={navigateSync({
      space: page.params.space!,
      object: object.id,
    })}
    variant="ghost"
    class="w-full justify-start"
    data-current={object.id === page.params.object}
  >
    <Icon icon={"tabler:question-circle"} class="shrink-0" />
    <span class="truncate">{object.name || "..."}</span>
  </Button>
{/if}
