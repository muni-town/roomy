<script lang="ts">
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { peer } from "$lib/workers";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { Avatar } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";
  import { newUlid, UserDid } from "@roomy/sdk";

  import { IconLoading } from "@roomy/design/icons";
  import { Input, toast } from "@foxui/core";
  import { isDid } from "@atproto/api";

  const spaceId = $derived(app.joinedSpace?.id);

  const bans = $derived(
    app.space.status == "joined" ? peer.getBans(app.space.space.id) : undefined,
  );

  let handleOrDid = $state("");
  let isSaving = $state(false);

  async function banAccount() {
    if (!spaceId || !handleOrDid) return;

    try {
      isSaving = true;
      let userDid: UserDid | undefined;
      if (isDid(handleOrDid)) {
        userDid = handleOrDid as UserDid;
      } else {
        userDid = await peer.resolveUserDidFromHandle(handleOrDid);
      }

      if (!userDid) {
        toast.error("Could not resolve handle to DID");
        throw new Error("Could not resolve handle to DID");
      }

      await peer.sendEvent(spaceId, {
        $type: "space.roomy.space.banAccount.v0",
        id: newUlid(),
        userDid,
      });

      toast.success("Space updated successfully", {
        position: "bottom-right",
      });

      handleOrDid = "";
    } catch (e) {
      console.error("Error updating space:", e);
      toast.error("Error updating space", {
        position: "bottom-right",
      });
    } finally {
      isSaving = false;
    }
  }

  async function unbanAccount(userId: string) {
    if (!spaceId) return;

    await peer.sendEvent(spaceId, {
      id: newUlid(),
      $type: "space.roomy.space.unbanAccount.v0",
      userDid: UserDid.assert(userId),
    });
  }
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">Bans</h2>

    <form class="space-y-12">
      <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
        Banned Accounts
      </h2>

      <div class="sm:col-span-full">
        <label
          for="username"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Ban Account</label
        >
        <div class="mt-2 flex gap-3">
          <Input
            bind:value={handleOrDid}
            placeholder="Handle or DID"
            class="w-full"
          />
          <Button type="submit" disabled={isSaving} onclick={banAccount}>
            {#if isSaving}
              Saving...
            {:else}
              Ban Account
            {/if}
          </Button>
        </div>
      </div>
    </form>

    {#await bans}
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
            <Button onclick={() => unbanAccount(member.did)}>Unban</Button>
          </li>
        {/each}
      </ul>
    {/await}
  </div>
</div>
