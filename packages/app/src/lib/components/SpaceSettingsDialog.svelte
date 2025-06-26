<script lang="ts">
  import { Button } from "bits-ui";
  import Dialog from "./Dialog.svelte";
  import Icon from "@iconify/svelte";
  import { AvatarMarble } from "svelte-boring-avatars";
  import { user } from "$lib/user.svelte";
  import toast from "svelte-french-toast";
  import { CoState } from "jazz-svelte";
  import { Space, publicGroup } from "@roomy-chat/sdk";
  import { page } from "$app/state";
  import { co, z } from "jazz-tools";

  let space = $derived(new CoState(Space, page.params.space));

  let saveSpaceLoading = $state(false);
  let avatarPreviewUrl = $derived(space.current?.imageUrl ?? "");
  let uploadingAvatar = $state(false);
  let spaceNameInput = $derived(space.current?.name ?? "");
  let bannedHandlesInput = $derived(space.current?.bans?.join(",") ?? "");
  let avatarFile = $state<File | null>(null);
  let showSpaceSettings = $state(false);

  async function saveBannedHandles() {
    if (!space.current || !user.agent) return;
    const bannedHandles = await Promise.all(
      bannedHandlesInput
        .split(",")
        .map((x) => x.trim())
        .filter((x) => !!x),
    );

    space.current.bans = co
      .list(z.string())
      .create(bannedHandles, publicGroup("reader"));

    showSpaceSettings = false;
  }
  async function saveSpaceName() {
    if (!space.current) return;
    space.current.name = spaceNameInput;
    showSpaceSettings = false;
  }

  async function handleAvatarSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      if (file) {
        avatarFile = file;
        avatarPreviewUrl = URL.createObjectURL(file);
      }
    }
  }

  async function uploadAvatar(ev: Event) {
    ev.preventDefault();
    if (!avatarFile || !user.agent || !space.current) return;

    try {
      uploadingAvatar = true;

      // Upload the image using the user's agent
      const uploadResult = await user.uploadBlob(avatarFile);

      space.current.imageUrl = uploadResult.url;
      avatarPreviewUrl = uploadResult.url;

      toast.success("Space avatar updated successfully", {
        position: "bottom-right",
      });
    } catch (error) {
      console.error("Error uploading avatar:", error);
      toast.error("Failed to upload avatar", {
        position: "bottom-right",
      });
    } finally {
      uploadingAvatar = false;
      avatarFile = null;
    }
  }
</script>

<Dialog title="Space Settings" bind:isDialogOpen={showSpaceSettings}>
  {#snippet dialogTrigger()}
    <Button.Root
      title="Space Settings"
      class="dz-btn w-full justify-start dz-join-item text-base-content"
    >
      <Icon icon="lucide:settings" class="size-6" />
    </Button.Root>
  {/snippet}

  <div class="max-h-[80vh] overflow-y-auto pr-2">

    <form onsubmit={saveSpaceName} class="flex flex-col gap-3 mb-8">
      <label class="dz-input w-full">
        <span class="label">Name</span>
        <input
          bind:value={spaceNameInput}
          placeholder="My Space"
          type="text"
          required
        />
      </label>
      <Button.Root class="dz-btn dz-btn-primary w-full">Save Name</Button.Root>
    </form>

    <form class="flex flex-col gap-4 mb-8" onsubmit={uploadAvatar}>
      <h2 class="font-bold text-xl">Avatar</h2>
      <div class="flex flex-col gap-4">
        <div class="flex items-center gap-4">
          <div
            class="w-20 h-20 rounded-full overflow-hidden bg-base-300 flex items-center justify-center"
          >
            {#if avatarPreviewUrl}
              <img
                src={avatarPreviewUrl}
                alt="Avatar preview"
                class="w-full h-full object-cover"
              />
            {:else if space.current && space.current.id}
              <div class="w-full h-full flex items-center justify-center">
                <AvatarMarble name={space.current.id} />
              </div>
            {/if}
          </div>

          <div class="flex flex-col gap-2">
            <label class="dz-btn dz-btn-sm dz-btn-outline">
              <input
                type="file"
                accept="image/*"
                class="hidden"
                onchange={handleAvatarSelect}
              />
              Choose Image
            </label>
            {#if avatarFile}
              <Button.Root
                type="button"
                class="dz-btn dz-btn-sm dz-btn-outline dz-btn-error"
                onclick={() => {
                  avatarFile = null;
                  avatarPreviewUrl = "";
                }}
              >
                Clear
              </Button.Root>
            {/if}
          </div>
        </div>

        {#if avatarFile}
          <Button.Root class="dz-btn dz-btn-primary" disabled={uploadingAvatar}>
            {#if uploadingAvatar}
              <span class="dz-loading dz-loading-spinner"></span>
            {/if}
            Upload Avatar
          </Button.Root>
        {/if}
      </div>
    </form>

    <form class="flex flex-col gap-4 mb-8" onsubmit={saveBannedHandles}>
      <h2 class="font-bold text-xl">Bans</h2>

      <div>
        <input
          class="dz-input w-full"
          bind:value={bannedHandlesInput}
          type="text"
        />
        <div class="flex flex-col">
          <span class="mx-2 mt-1 text-sm"
            >Input a list of handles separated by commas.</span
          >
          <span class="mx-2 mt-1 text-sm"
            >Note: the ban is "best effort" right now. The Roomy alpha is
            generally insecure.</span
          >
        </div>
      </div>

      <Button.Root
        class="dz-btn dz-btn-primary w-full"
        disabled={saveSpaceLoading}
      >
        Save Bans
      </Button.Root>
    </form>
  </div>
</Dialog>
