<script lang="ts">
  import { page } from "$app/state";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { current } from "$lib/queries";
  import { backend, backendStatus } from "$lib/workers";
  import { Badge, Button, Input, Tabs, Textarea, toast } from "@fuxui/base";
  import { Handle, newUlid } from "@roomy/sdk";

  import IconMdiLoading from "~icons/mdi/loading";

  let currentSpace = $derived(current.joinedSpace);
  let spaceId = $derived(currentSpace?.id);
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

  let spaceHandle = $state(
    current.space.status == "joined" ? current.space.space.handle : "",
  );
  $effect(() => {
    if (current.space.status == "joined")
      spaceHandle = current.space.space.handle;
  });
  let exampleSpaceHandle = $derived(
    spaceHandle || backendStatus.profile?.handle || "example.com",
  );
  let currentSpaceHandle = $derived(
    current.space.status == "joined" && current.space.space.handle,
  );
  let currentProfileSpace = $derived(backend.getProfileSpace());

  let handleResolvesToSpace = $state(new Promise<boolean>(() => {}));
  $effect(() => {
    const handle = spaceHandle;
    if (!handle || handle.split(".").length < 2) {
      handleResolvesToSpace = new Promise(() => {});
      return;
    }
    handleResolvesToSpace = backend
      .resolveSpaceId(Handle.assert(handle))
      .then(({ spaceId }) => {
        return (
          current.space.status == "joined" && current.space.space.id == spaceId
        );
      })
      .catch(() => false);
  });

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

  let fileInput = $state<HTMLInputElement | null>(null);

  const handleTabs = ["Use My Handle", "Use DNS"] as const;
  let activeHandleTab: (typeof handleTabs)[number] = $state("Use My Handle");

  async function setSpaceHandleUsingProfile() {
    if (
      current.space.status != "joined" ||
      backendStatus.authState?.state != "authenticated"
    )
      return;

    try {
      // Set this space as the user's profile space
      await backend.setProfileSpace(current.space.space.id);

      // Set the current user as the handle provider for the space
      await backend.sendEvent(current.space.space.id, {
        $type: "space.roomy.space.setHandleProvider.v0",
        id: newUlid(),
        did: backendStatus.authState.did,
      });

      // And reload the page
      window.location.reload();
    } catch (e) {
      console.error(e);
      toast.error("Error unsetting handle for space.");
    }
  }

  async function removeProfileSpaceRecord() {
    const currentProfileSpaceId = await currentProfileSpace;
    if (
      !currentProfileSpaceId ||
      current.space.status != "joined" ||
      current.space.space.id != currentProfileSpaceId ||
      backendStatus.authState?.state != "authenticated" ||
      !backendStatus.profile
    ) {
      return;
    }

    try {
      // If the current space handle matches our user's handle, then we need to clear the handle
      // provider for the space.
      if (currentSpaceHandle == backendStatus.profile.handle) {
        await backend.sendEvent(current.space.space.id, {
          $type: "space.roomy.space.setHandleProvider.v0",
          id: newUlid(),
          did: null,
        });
      }

      // Then we need remove the profile space record from the user's PDS.
      await backend.setProfileSpace(null);
      // And reload the page
      window.location.reload();
    } catch (e) {
      console.error(e);
      toast.error("Error unsetting handle for space.");
    }
  }

  function setHandleUsingDns() {
    if (current.space.status != "joined") return;
    const spaceId = current.space.space.id;
    backend
      .setSpaceHandle(spaceId, spaceHandle || null)
      .then(async () => {
        toast.success("Updated space handle");
        if (!spaceHandle || !(await handleResolvesToSpace)) {
          window.location.href = `/${spaceId}/settings/general`;
        } else {
          window.location.href = `/${spaceHandle}/settings/general`;
        }
      })
      .catch((e) => {
        toast.error(`Could not update space handle: ${e}`);
      });
  }
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

<!-- Space Handle Form -->
<div class="pt-8 mt-8 border-t border-base-200 dark:border-base-800">
  <h2
    class="text-xl/7 font-bold text-base-900 dark:text-base-100 mb-4 flex gap-3 items-center"
  >
    Space Handle <Badge>{currentSpaceHandle || "Not Set"}</Badge>
  </h2>

  <p class="mb-3 text-base-700 dark:text-base-300 text-center">
    Setting a space handle allows your space to be accessed with a nicer URL such as:
  </p>

  <div
    class="font-bold text-center m-3 font-mono text-base-900 dark:text-base-100"
  >
    {page.url.host}/{exampleSpaceHandle}
  </div>

  <p class="mb-3 text-base-700 dark:text-base-300 text-center">
    A space admin can use their handle for the space, or you can configure a
    handle using DNS.
  </p>

  <div class="flex justify-center">
    <Tabs
      items={handleTabs.map((name) => ({
        name,
        onclick: () => (activeHandleTab = name),
      }))}
      active={activeHandleTab}
      class="mb-4"
    />
  </div>

  {#if activeHandleTab == "Use My Handle"}
    {#await currentProfileSpace}
      <div class="flex justify-center">
        <IconMdiLoading class="animate-spin" font-size={40} />
      </div>
    {:then profileSpace}
      <form class="text-center">
        {#if current.space.status == "joined" && current.space.space.id == profileSpace}
          <strong
            >Your ATProto handle <code>{backendStatus.profile?.handle}</code> is
            being used for this space.
          </strong>
        {:else if profileSpace}
          <strong
            >Your ATProto handle <code>{backendStatus.profile?.handle}</code> is
            being used for a
            <a href={`/${profileSpace}`} class="text-accent-500"
              >different space</a
            >.</strong
          > Using your handle for this space will disconnect it from the other one.
        {:else}
          <strong
            >Your ATProto handle <code>{backendStatus.profile?.handle}</code> is
            not being used for any space.</strong
          >
        {/if}

        <div class="gap-2 flex flex-col my-3 p-3">
          <!-- If the space is not currently using the user's handle. -->
          {#if backendStatus.profile && currentSpaceHandle != backendStatus.profile?.handle}
            <Button onclick={setSpaceHandleUsingProfile}
              >Use My Handle For This Space</Button
            >
          {/if}

          <!-- If space is currently using the user's handle. -->
          {#if current.space.status == "joined" && current.space.space.id == profileSpace}
            <Button onclick={removeProfileSpaceRecord}
              >Remove Your Handle From This Space</Button
            >
          {/if}
        </div>

        <!-- <div class="my-3 flex flex-col gap-2">
        {#await spaceForCurrentAccountHandleResp then resp}
          {#if resp && resp.spaceId != spaceId}
            <div>
              Your handle is currently being used for
              <a
                href={`${page.url.protocol}//${page.url.host}/${resp.spaceId}`}
                class="text-blue-400"
              >
                another space.
              </a> Using it for this space will mean it can't be used for the other
              space.
            </div>
          {/if}
        {/await}
      </div> -->
      </form>
    {/await}
  {:else if activeHandleTab == "Use DNS"}
    <form>
      <p class="mb-3 text-base-700 dark:text-base-300 text-center">
        In order to set a space handle you must create a DNS TXT record for your
        domain:
      </p>

      <pre
        class="font-bold text-center m-4 font-mono text-base-900 dark:text-base-100">TXT    _leaf{exampleSpaceHandle.split(
          ".",
        ).length >= 3
          ? "."
          : ""}{exampleSpaceHandle.split(".").slice(0, -2)}    "did={current
          .space.status == "joined" && current.space.space.id}"</pre>

      <Input
        bind:value={spaceHandle}
        placeholder="example.com"
        class="w-full mt-2"
      />

      <div class="space-y-3 my-3 justify-end flex items-baseline gap-3">
        {#if spaceHandle}
          {#await handleResolvesToSpace}
            <span class="flex gap-2 items-center">
              Verifying <IconMdiLoading class="animate-spin" />
            </span>
          {:then resolves}
            {#if resolves}
              <span class="text-green-600">Verified</span>
            {:else}
              <span class="text-red-600">DNS Resolution Failed</span>
            {/if}
          {/await}
        {/if}

        <Button type="submit" onclick={setHandleUsingDns}
          >{!spaceHandle && !!currentSpaceHandle
            ? "Remove Current Handle"
            : "Set Handle"}</Button
        >
      </div>
    </form>
  {/if}
</div>
