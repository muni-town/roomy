<script lang="ts">
  import { page } from "$app/state";
  import type { Channel, RoomyAccount, Space } from "$lib/jazz/schema";
  import { isSpaceAdmin } from "$lib/jazz/utils";
  import { navigateSync } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Button } from "bits-ui";
  import { co } from "jazz-tools";

  let {
    channel,
    deleteItem,
    space,
    lastReadDate,
    me,
  }: {
    channel: co.loaded<typeof Channel> | undefined | null;
    deleteItem: (channel: co.loaded<typeof Channel>) => void;
    space: co.loaded<typeof Space> | undefined | null;
    lastReadDate: Date | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
  } = $props();

  const latestEntriesByAccount = $derived(
    Object.values(channel?.mainThread?.timeline?.perAccount ?? {}).sort(
      (a, b) => a.madeAt.getTime() - b.madeAt.getTime(),
    ),
  );

  let isNew = $derived.by(() => {
    if (!lastReadDate) return latestEntriesByAccount.length !== 0;
    if (latestEntriesByAccount.length === 0) return false;
    let date = latestEntriesByAccount.at(-1)?.madeAt;
    if (!date) return false;

    return new Date(lastReadDate) < date;
  });

  const channelNotifications = $derived(
    me?.profile?.roomyInbox?.filter(
      (x) => x?.channelId === channel?.id && !x?.read,
    ).length,
  );

  $inspect(me?.profile?.roomyInbox);

  $inspect(channelNotifications);
</script>

{#if channel && !channel.softDeleted}
  <div class="group flex items-center gap-1 relative">
    <Button.Root
      href={navigateSync({
        space: page.params.space!,
        channel: channel.id,
      })}
      class="flex-1 cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border page.params.channel && {channel.id ===
      page.params.channel
        ? 'border-primary text-primary'
        : ' border-transparent'}"
    >
      <h3 class="flex justify-start items-center w-full gap-2 px-2">
        <Icon icon="basil:comment-solid" class="shrink-0" />
        <span class="truncate">{channel?.name || "..."}</span>

        {#if channelNotifications}
          <span
            class="inline-flex items-center justify-center bg-primary font-bold text-base-100 rounded-full size-6"
          >
            {channelNotifications}
          </span>
        {/if}
      </h3>
    </Button.Root>

    {#if isNew}
      <div class="absolute top-1 left-1 size-2 bg-primary rounded-full"></div>
    {/if}
    {#if isSpaceAdmin(space)}
      <Button.Root
        title="Delete"
        class="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer dz-btn dz-btn-ghost dz-btn-circle text-error hover:bg-error/10"
        onclick={() => deleteItem(channel)}
      >
        <Icon icon="lucide:x" class="size-4" />
      </Button.Root>
    {/if}
  </div>
{/if}
