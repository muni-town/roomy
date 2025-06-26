<script lang="ts">
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { goto } from "$app/navigation";
  import { AccountCoState } from "jazz-svelte";
  import { RoomyAccount } from "@roomy-chat/sdk";

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
    },
  });

  function handleClick() {
    if (me.current?.id) {
      goto(`/user/${me.current.id}`);
    }
  }
</script>

<button
  onclick={handleClick}
  class="btn btn-ghost btn-sm btn-circle"
  title="View your profile"
>
  <Avatar.Root class="size-6">
    <Avatar.Image src={me.current?.profile?.imageUrl} class="rounded-full" />
    <Avatar.Fallback>
      <AvatarBeam
        name={me.current?.profile?.name || me.current?.id || "User"}
        size={24}
      />
    </Avatar.Fallback>
  </Avatar.Root>
</button>
