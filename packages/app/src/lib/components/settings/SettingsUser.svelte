<script lang="ts">
  import { Avatar, Badge, Button, Popover } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { co, makeSpaceAdmin, RoomyProfile, Space } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import toast from "svelte-french-toast";

  let {
    profileId,
    accountId,
    isMe,
    space,
  }: { profileId: string; accountId: string; isMe: boolean, space: co.loaded<typeof Space> | undefined | null } = $props();

  const profile = $state(new CoState(RoomyProfile, profileId));
</script>

<div
  class="flex items-center gap-2 rounded-2xl bg-base-100 dark:bg-base-900/50 p-2 w-full justify-between border border-base-200 dark:border-base-900"
>
  <div class="flex items-center gap-2">
    <Avatar src={profile.current?.imageUrl} class="size-8" />
    <span class="text-base font-medium text-base-900 dark:text-base-100"
      >{profile.current?.name}</span
    >
    {#if isMe}
      <Badge>You</Badge>
    {/if}
  </div>

  <div>
    {#if !isMe}
      <Popover side="left" align="end" sideOffset={5}>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon">
            <Icon icon="heroicons:ellipsis-horizontal" />
          </Button>
        {/snippet}
        <div class="flex flex-col gap-2">
          <Button href={`/user/${accountId}`} variant="secondary">
            Go to profile
          </Button>
          <Button variant="red" disabled={true}>Ban user</Button>
          <Button variant="red" onclick={() => {
            if (space?.id && accountId) {
              makeSpaceAdmin(space.id, accountId);
              toast.success("User made admin");
            }
          }}>Make admin</Button>
        </div>
      </Popover>
    {/if}
  </div>
</div>
