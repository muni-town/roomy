<script lang="ts">
  import { page } from "$app/state";
  import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
  import { user } from "$lib/user.svelte";
  import { Button, Input, Textarea } from "@fuxui/base";
  import { RoomyEntity } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import toast from "svelte-french-toast";

  let space = $derived(new CoState(RoomyEntity, page.params.space));
  let spaceName = $derived(space.current?.name ?? "");
  let avatarUrl = $derived(space.current?.imageUrl ?? "");
  let spaceDescription = $derived(space.current?.description ?? "");

  let avatarFile = $state<File | null>(null);

  let isSaving = $state(false);

  let hasChanged = $derived(
    spaceName != space.current?.name ||
      avatarUrl != space.current?.imageUrl ||
      spaceDescription != space.current?.description,
  );

  function resetData() {
    spaceName = space.current?.name ?? "";
    avatarUrl = space.current?.imageUrl ?? "";
    avatarFile = null;
  }

  async function save() {
    if (!space.current) return;
    isSaving = true;

    let currentSpaceName = spaceName;
    let currentSpaceDescription = spaceDescription;

    if (avatarFile) {
      await uploadAvatar();
    }

    space.current.name = currentSpaceName;
    space.current.imageUrl = avatarUrl;
    space.current.description = currentSpaceDescription;
    isSaving = false;

    toast.success("Space updated successfully", {
      position: "bottom-right",
    });
  }

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
    if (!avatarFile || !user.agent || !space.current) return;

    try {
      // Upload the image using the user's agent
      const uploadResult = await user.uploadBlob(avatarFile);

      space.current.imageUrl = uploadResult.url;
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
</script>

<form class="pt-4">
  <div class="space-y-12">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
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
          <SpaceAvatar imageUrl={avatarUrl} id={space.current?.id} size={64} />

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
