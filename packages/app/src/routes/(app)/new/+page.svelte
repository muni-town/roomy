<script lang="ts">
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { user } from "$lib/user.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { Button, Checkbox, Input, Label, Textarea } from "@fuxui/base";
  import {
    createSpace,
    publicGroup,
    RoomyAccount,
    RoomyEntityList,
  } from "@roomy-chat/sdk";
  import { AccountCoState } from "jazz-tools/svelte";
  import toast from "svelte-french-toast";

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

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

  async function uploadAvatar() {
    if (!avatarFile || !user.agent) return;

    try {
      // Upload the image using the user's agent
      const uploadResult = await user.uploadBlob(avatarFile);

      avatarUrl = uploadResult.url;
    } catch (error) {
      console.error("Error uploading avatar:", error);
      toast.error("Failed to upload avatar", {
        position: "bottom-right",
      });
    } finally {
      avatarFile = null;
    }
  }

  let fileInput = $state<HTMLInputElement | null>(null);

  async function createSpaceSubmit(evt: Event) {
    evt.preventDefault();

    isSaving = true;

    let currentSpaceName = spaceName;
    let currentSpaceDescription = spaceDescription;

    if (!currentSpaceName) {
      toast.error("Please enter a name for the space", {
        position: "bottom-right",
      });
      return;
    }

    if (
      me?.current?.profile &&
      me.current.profile.newJoinedSpacesTest === undefined
    ) {
      me.current.profile.newJoinedSpacesTest = RoomyEntityList.create(
        [],
        publicGroup("reader"),
      );
    }

    const space = await createSpace(currentSpaceName);

    if (avatarFile) {
      await uploadAvatar();
    }

    space.imageUrl = avatarUrl;
    space.description = currentSpaceDescription;

    me?.current?.profile?.newJoinedSpacesTest?.push(space);

    isSaving = false;
    toast.success("Space created successfully", {
      position: "bottom-right",
    });

    navigate({ space: space.id });
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
