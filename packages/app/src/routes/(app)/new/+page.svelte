<script lang="ts">
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { backend, backendStatus } from "$lib/workers";
  import { Button, Checkbox, Input, Label, Textarea } from "@fuxui/base";
  import toast from "svelte-french-toast";

  let spaceName = $state("");
  let avatarUrl = $state("");
  let spaceDescription = $state("");
  let isDiscoverable = $state(true);

  let avatarFile = $state<File | null>(null);

  let isSaving = $state(false);

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

  async function createSpaceSubmit(evt: Event) {
    evt.preventDefault();
    if (!backendStatus.personalStreamId) return;

    try {
      isSaving = true;

      let currentSpaceName = spaceName;
      let currentSpaceDescription = spaceDescription;

      if (!currentSpaceName) {
        toast.error("Please enter a name for the space", {
          position: "bottom-right",
        });
        return;
      }

      // Create a new stream for the space
      const spaceId = await backend.createStream(
        "262f081583741b6a0e06564e45b7ad4fc13d06d4189863a3fab5e860b83541c9",
        "/leaf_module_public_read_write_admin_upgrade.wasm",
      );

      // Join the space
      await backend.sendEvent(backendStatus.personalStreamId, {
        kind: "space.roomy.joinSpace.0",
        data: spaceId,
      });

      const avatarUpload =
        avatarFile &&
        (await backend.uploadImage(await avatarFile.arrayBuffer()));

      await backend.sendEvent(spaceId, {
        kind: "space.roomy.spaceInfo.0",
        data: {
          avatar: avatarUpload?.url || undefined,
          name: currentSpaceName || undefined,
          description: currentSpaceDescription || undefined,
        },
      });

      isSaving = false;
      toast.success("Space created successfully", {
        position: "bottom-right",
      });

      // FIXME: add discoverable feed.
      // if (isDiscoverable) {
      //   console.log("Adding to discoverable spaces feed");
      //   await addToDiscoverableSpacesFeed(space.id);
      // }

      navigate({ space: spaceId });
    } catch (e) {
      console.error("Error creating space:", e);
      toast.error('Error creating space', {
        position: "bottom-right",
      });
    }
  }
</script>

<form class="pt-4" onsubmit={createSpaceSubmit}>
  <div class="space-y-12">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Create a new space
    </h2>

    <div class="mt-10 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
      <div class="sm:col-span-4">
        <label
          for="name"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Name</label
        >
        <div class="mt-2">
          <Input id="name" bind:value={spaceName} class="w-full" />
        </div>
      </div>

      <div class="col-span-full">
        <label
          for="photo"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Avatar (optional)</label
        >
        <div class="mt-2 flex items-center gap-x-3">
          <SpaceAvatar imageUrl={avatarUrl} size={64} />

          <input
            type="file"
            accept="image/*"
            class="hidden"
            id="photo"
            onchange={handleAvatarSelect}
            bind:this={fileInput}
          />
          <Button variant="secondary" onclick={() => fileInput?.click()}
            >Upload Avatar</Button
          >
        </div>
      </div>

      <div class="sm:col-span-full">
        <label
          for="username"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Description (optional)</label
        >
        <div class="mt-2">
          <Textarea bind:value={spaceDescription} class="w-full" rows={4} />
        </div>
      </div>

      <div class="sm:col-span-full">
        <label
          for="username"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Discovery</label
        >
        <div class="mt-4 flex items-center gap-x-2">
          <Checkbox
            id="discovery"
            aria-labelledby="discovery-label"
            variant="secondary"
            bind:checked={isDiscoverable}
          />
          <Label
            id="discovery-label"
            for="discovery"
            class="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Allow space to be publicly discoverable
          </Label>
        </div>
      </div>
    </div>
  </div>

  <div class="mt-6 flex items-center justify-end gap-x-6">
    <div>
      <Button type="submit" disabled={!spaceName || isSaving}>
        {#if isSaving}
          Creating...
        {:else}
          Create Space
        {/if}
      </Button>
    </div>
  </div>
</form>
