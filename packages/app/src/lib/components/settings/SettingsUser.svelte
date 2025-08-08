<script lang="ts">
  import { Avatar, Badge, Button, Popover } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import {
    BansComponent,
    co,
    RoomyAccount,
    RoomyEntity,
  } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import toast from "svelte-french-toast";

  let {
    accountId,
    isMe = false,
    space,
    isAdmin = false,
    isBanned = false,
    makeAdmin,
  }: {
    accountId: string;
    isMe?: boolean;
    space: co.loaded<typeof RoomyEntity> | undefined | null;
    isAdmin?: boolean;
    isBanned?: boolean;
    makeAdmin?: () => void;
  } = $props();

  const account = $state(
    new CoState(RoomyAccount, accountId, {
      resolve: {
        profile: true,
      },
    }),
  );

  let popoverOpen = $state(false);

  let bans = $derived(
    new CoState(BansComponent, space?.components?.[BansComponent.id]),
  );
</script>

<div
  class="flex items-center gap-2 rounded-2xl bg-base-100 dark:bg-base-900/50 p-2 w-full justify-between border border-base-200 dark:border-base-900"
>
  <div class="flex items-center gap-2">
    <Avatar src={account.current?.profile?.imageUrl} class="size-8" />
    <span class="text-base font-medium text-base-900 dark:text-base-100"
      >{account.current?.profile?.name}</span
    >
    {#if isMe}
      <Badge>You</Badge>
    {/if}
    {#if isBanned}
      <Badge variant="red">Banned</Badge>
    {/if}
    {#if isAdmin}
      <Badge variant="green">Admin</Badge>
    {/if}
  </div>

  <div>
    {#if !isMe}
      <Popover side="left" align="end" sideOffset={5} bind:open={popoverOpen}>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon">
            <Icon icon="heroicons:ellipsis-horizontal" />
          </Button>
        {/snippet}
        <div class="flex flex-col gap-2">
          <Button href={`/user/${accountId}`} variant="secondary">
            Go to profile
          </Button>

          {#if !isAdmin && space}
            <Button
              variant="red"
              onclick={() => {
                if (space?.id && accountId) {
                  if (isBanned) {
                    bans.current?.splice(bans.current?.indexOf(accountId), 1);
                  } else {
                    bans.current?.push(accountId);
                  }
                  toast.success(isBanned ? "User banned" : "User unbanned");
                  popoverOpen = false;
                }
              }}>{isBanned ? "Unban user" : "Ban user"}</Button
            >
          {/if}
          {#if !isBanned && !isAdmin && makeAdmin}
            <Button
              variant="red"
              onclick={() => {
                makeAdmin();
                popoverOpen = false;
              }}>Make admin</Button
            >
          {/if}
        </div>
      </Popover>
    {/if}
  </div>
</div>
