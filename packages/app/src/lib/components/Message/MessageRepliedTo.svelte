<script lang="ts">
  import { Message, RoomyProfile } from "$lib/jazz/schema";
  import { CoState } from "jazz-svelte";
  import { Button } from "bits-ui";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import Icon from "@iconify/svelte";
  import { getContext } from "svelte";

  let { messageId } = $props();

  let message = $derived(
    new CoState(Message, messageId, {
      resolve: {
        content: true,
        reactions: true,
      },
    }),
  );

  let profile = $derived(
    new CoState(RoomyProfile, message.current?._edits.content?.by?.profile?.id),
  );

  const scrollToMessage = getContext("scrollToMessage") as (
    id: string,
  ) => void;
</script>

<Button.Root
  onclick={() => scrollToMessage(message.current?.id ?? "")}
  class="cursor-pointer flex gap-2 text-sm text-start w-full items-center px-4 py-1"
>
  <div class="flex md:basis-auto gap-2 items-center shrink-0">
    <Icon icon="prime:reply" width="12px" height="12px" />
    <Avatar.Root class="w-4">
      <Avatar.Image src={profile.current?.imageUrl} class="rounded-full" />
      <Avatar.Fallback>
        <AvatarBeam name={profile.current?.id} />
      </Avatar.Fallback>
    </Avatar.Root>
    <h5 class="font-medium text-ellipsis">
      {profile.current?.name}
    </h5>
  </div>
  <div class="line-clamp-1 md:basis-auto overflow-hidden italic">
    {@html message.current?.content ?? ""}
  </div>
</Button.Root>
