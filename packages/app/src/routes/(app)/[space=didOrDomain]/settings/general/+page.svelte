<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { current } from "$lib/queries";
  import { backend, backendStatus } from "$lib/workers";
  import { Button, Input, Textarea, toast } from "@fuxui/base";
  import { newUlid } from "@roomy/sdk";

  let currentSpace = $derived(current.joinedSpace);
  let spaceId = $derived(currentSpace?.id);
  let handleAccount = $derived(currentSpace?.handle);
  let spaceName = $derived(currentSpace?.name ?? "");
  let avatarUrl = $derived(currentSpace?.avatar ?? "");
  let spaceDescription = $derived(currentSpace?.description ?? "");

  let avatarFile = $state<File | null>(null);

  let isSaving = $state(false);

  let nameChanged = $derived(spaceName != currentSpace?.name);
  let avatarChanged = $derived(avatarUrl != currentSpace?.avatar);
  let descriptionChanged = $derived(
    spaceDescription != currentSpace?.description,
  );
  let hasChanged = $derived(nameChanged || avatarChanged || descriptionChanged);

  function resetData() {
    spaceName = currentSpace?.name ?? "";
    avatarUrl = currentSpace?.avatar ?? "";
    avatarFile = null;
  }

  async function save() {
    if (!spaceId) return;

    try {
      isSaving = true;

      const avatarUpload =
        avatarFile &&
        (await backend.uploadToPds(await avatarFile.arrayBuffer()));

      // Update space info
      await backend.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.updateSpaceInfo.v0",
        avatar: avatarChanged ? avatarUpload?.uri : undefined,
        name: nameChanged ? spaceName : undefined,
        description: descriptionChanged ? spaceDescription : undefined,
      });

      toast.success("Space updated successfully", {
        position: "bottom-right",
      });
    } catch (e) {
      console.error("Error updating space:", e);
      toast.error("Error updating space", {
        position: "bottom-right",
      });
    } finally {
      isSaving = false;
    }
  }

  let updateSpaceHandle = $state(1);
  let spaceForCurrentAccountHandleResp = $derived(
    updateSpaceHandle && backendStatus.authState?.state === "authenticated"
      ? backend.resolveSpaceId(backendStatus.authState.did)
      : undefined,
  );
  let handleForCurrentSpace = $derived(
    spaceId && handleAccount
      ? backend.resolveHandleForSpace(spaceId, handleAccount)
      : undefined,
  );

  async function handleAvatarSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      if (file) {
        avatarFile = file;
        avatarUrl = URL.createObjectURL(file);
      }
    }
  }

  async function useHandleForSpace() {
    if (!spaceId || backendStatus.authState?.state !== "authenticated") return;
    try {
      await backend.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.setHandleAccount.v0",
        did: backendStatus.authState.did,
      });
      await backend.createStreamHandleRecord(spaceId);
      updateSpaceHandle += 1;
      toast.success("Successfully updated handle");
      if (backendStatus.profile?.handle)
        goto(`/${backendStatus.profile?.handle}/settings/general`);
    } catch (e) {
      console.error(e);
      toast.error(`Could not set handle: ${e}`);
    }
  }

  async function removeHandleForSpace() {
    if (!spaceId) return;
    try {
      await backend.removeStreamHandleRecord();
      await backend.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.setHandleAccount.v0",
        did: null,
      });
      updateSpaceHandle += 1;
      toast.success("Successfully updated handle");
      goto(`/${spaceId}/settings/general`);
    } catch (e) {
      console.error(e);
      toast.error(`Could not set handle: ${e}`);
    }
  }

  let fileInput = $state<HTMLInputElement | null>(null);
</script>

<form class="pt-4">
  <div class="space-y-12">
    <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
      General Settings
    </h2>

    <div class="mt-10 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
      <div class="col-span-full">
        <label
          for="photo"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Avatar</label
        >
        <div class="mt-2 flex items-center gap-x-3">
          <SpaceAvatar imageUrl={avatarUrl} id={spaceId} size={64} />

          <input
            type="file"
            accept="image/*"
            class="hidden"
            onchange={handleAvatarSelect}
            bind:this={fileInput}
          />
          <Button variant="secondary" onclick={() => fileInput?.click()}
            >Change</Button
          >
        </div>
      </div>

      <div class="sm:col-span-4">
        <label
          for="username"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Space Name</label
        >
        <div class="mt-2">
          <Input bind:value={spaceName} class="w-full" />
        </div>
      </div>

      <div class="sm:col-span-full">
        <label
          for="username"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Description</label
        >
        <div class="mt-2">
          <Textarea bind:value={spaceDescription} class="w-full" rows={4} />
        </div>
      </div>
    </div>
  </div>

  <div class="mt-6 flex items-center justify-end gap-x-6">
    <div>
      <Button
        type="button"
        variant="ghost"
        disabled={!hasChanged}
        onclick={resetData}
      >
        Cancel
      </Button>
      <Button type="submit" disabled={!hasChanged || isSaving} onclick={save}>
        {#if isSaving}
          Saving...
        {:else}
          Save
        {/if}
      </Button>
    </div>
  </div>
</form>
<!-- 
<form>
  <h2 class="text-xl font-bold">Space Handle</h2>

  <div class="gap-2 flex flex-col my-3 p-3">
    <p>
      You can pick one space that you allow to use your ATProto handle to get a
      nicer URL.
    </p>
    <p>
      For example, because you are the admin of this space, you may choose to
      use your handle to make this space accessible at:
    </p>
    <div class="font-bold text-center m-3 font-mono">
      {page.url.host}/{backendStatus.profile?.handle}
    </div>

    {#await spaceForCurrentAccountHandleResp then resp}
      {#await handleForCurrentSpace then handleForSpace}
        {#if handleForSpace != backendStatus.profile?.handle}
          <Button onclick={useHandleForSpace}
            >Use My Handle For This Space</Button
          >
        {/if}

        {#if resp && resp.spaceId == spaceId}
          <Button onclick={removeHandleForSpace}
            >Remove Your Handle From This Space</Button
          >
        {/if}
      {/await}
    {/await}
  </div>

  <div class="my-3 flex flex-col gap-2">
    {#await handleForCurrentSpace then handle}
      <div>
        <strong>Current Handle for This Space:</strong>
        {#if handle}
          <a
            href={`${page.url.protocol}//${page.url.host}/${handle}`}
            class="text-blue-400"
          >
            {handle}
          </a>
        {:else}
          None
        {/if}
      </div>
    {/await}
    {#await spaceForCurrentAccountHandleResp then resp}
      {#if resp && resp.spaceId != spaceId}
        <div>
          Your handle is currently being used for
          <a
            href={`${page.url.protocol}//${page.url.host}/${resp.spaceId}`}
            class="text-blue-400"
          >
            another space.
          </a> Using it for this space will mean it can't be used for the other space.
        </div>
      {/if}
    {/await}
  </div>
</form> -->
