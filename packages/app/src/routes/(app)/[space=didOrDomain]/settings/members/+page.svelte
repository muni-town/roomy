<script lang="ts">
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { peer, peerStatus } from "$lib/workers";
  import { Button } from "@fuxui/base";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { newUlid, UserDid } from "@roomy/sdk";

  import { IconLoading } from "@roomy/design/icons";

  const spaceId = $derived(app.joinedSpace?.id);

  const members = $derived(
    app.space.status == "joined"
      ? peer.getMembers(app.space.space.id)
      : undefined,
  );

  async function addAdmin(userId: string) {
    if (!spaceId) return;

    await peer.sendEvent(spaceId, {
      id: newUlid(),
      $type: "space.roomy.space.addAdmin.v0",
      userDid: UserDid.assert(userId),
    });
  }

  async function removeAdmin(userId: string) {
    if (!spaceId) return;

    await peer.sendEvent(spaceId, {
      id: newUlid(),
      $type: "space.roomy.space.removeAdmin.v0",
      userDid: UserDid.assert(userId),
    });
  }
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
      Members
    </h2>

    {#await members}
      <IconLoading class="animate-spin" font-size={40} />
    {:then members}
      <ul class="flex flex-col gap-2">
        {#each members || [] as member}
          <li class="flex items-center gap-4">
            <a class="flex row gap-3 items-center" href={`/user/${member.did}`}>
              <Avatar.Root class="size-8 sm:size-10">
                <Avatar.Image src={member.avatar} class="rounded-full" />
                <Avatar.Fallback>
                  <AvatarBeam name={member.did} />
                </Avatar.Fallback>
              </Avatar.Root>
              {member.name}
              {member.handle ? "@" + member.handle : ""}</a
            >
            {#if app.space.status == "joined" && !app.space.space.permissions.find(([user, perm]) => user == member.did && perm == "admin")}
              <Button onclick={() => addAdmin(member.did)}>Make Admin</Button>
            {:else if peerStatus.authState?.state === "authenticated" && member.did != peerStatus.authState.did}
              <Button onclick={() => removeAdmin(member.did)}
                >Demote Admin</Button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/await}
  </div>
</div>
