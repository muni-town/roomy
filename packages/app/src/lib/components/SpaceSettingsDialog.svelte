<script lang="ts">
  import { Button } from "bits-ui";
  import Dialog from "./Dialog.svelte";
  import { globalState } from "$lib/global.svelte";
  import Icon from "@iconify/svelte";
  import { AvatarMarble } from "svelte-boring-avatars";
  import { Image } from "@roomy-chat/sdk";
  import { user } from "$lib/user.svelte";
  import { getProfile } from "$lib/profile.svelte";
  import { resolveLeafId } from "$lib/utils.svelte";
  import toast from "svelte-french-toast";

  let saveSpaceLoading = $state(false);
  let verificationFailed = $state(false);
  let avatarPreviewUrl = $state("");
  let uploadingAvatar = $state(false);
  let newSpaceHandle = $state("");
  let spaceNameInput = $state("");
  let bannedHandlesInput = $state("");
  let avatarFile = $state<File | null>(null);
  let showSpaceSettings = $state(false);
  let spaceAvatarUrl = $state("");

  $effect(() => {
    if (!globalState.space) return;
    if (!showSpaceSettings) {
      spaceNameInput = globalState.space.name;
      newSpaceHandle = globalState.space?.handles((x) => x.get(0)) || "";
      verificationFailed = false;
      saveSpaceLoading = false;
      avatarFile = null;
      avatarPreviewUrl = "";

      // Load current avatar if exists
      spaceAvatarUrl = "";
      // Access the image entity directly
      const imageId = globalState.space.image;

      if (imageId && globalState.roomy) {
        globalState.roomy.open(Image, imageId).then((image) => {
          if (image.uri) {
            spaceAvatarUrl = image.uri;
          }
        });
      }

      Promise.all(
        Object.keys(globalState.space.bans((x) => x.toJSON())).map((x) =>
          getProfile(x),
        ),
      ).then(
        (profiles) =>
          (bannedHandlesInput = profiles.map((x) => x.handle).join(", ")),
      );
    }
  });

  async function saveBannedHandles() {
    if (!globalState.space || !user.agent) return;
    const bannedIds = (
      await Promise.all(
        bannedHandlesInput
          .split(",")
          .map((x) => x.trim())
          .filter((x) => !!x)
          .map((x) => user.agent!.resolveHandle({ handle: x })),
      )
    ).map((x) => x.data.did);
    globalState.space.bans((bans) => {
      bans.clear();
      for (const ban of bannedIds) {
        bans.set(ban, true);
      }
    });
    globalState.space.commit();
    showSpaceSettings = false;
  }
  async function saveSpaceName() {
    if (!globalState.space) return;
    globalState.space.name = spaceNameInput;
    globalState.space.commit();
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
    if (!avatarFile || !globalState.space || !globalState.roomy || !user.agent)
      return;

    try {
      uploadingAvatar = true;

      // Upload the image using the user's agent
      const uploadResult = await user.uploadBlob(avatarFile);

      try {
        // Create an Image entity
        const image = await globalState.roomy.create(Image);

        // Set the image URI
        image.uri = uploadResult.url;
        image.commit();

        try {
          globalState.space.image = image.id;
          globalState.space.commit();

          // Update the preview URL
          spaceAvatarUrl = uploadResult.url;

          toast.success("Space avatar updated successfully", {
            position: "bottom-right",
          });
        } catch (err) {
          console.error("Error setting space image directly:", err);
        }
      } catch (imageErr) {
        console.error("Error creating image entity:", imageErr);
        toast.error("Failed to create image entity", {
          position: "bottom-right",
        });
      }
    } catch (error) {
      console.error("Error uploading avatar:", error);
      toast.error("Failed to upload avatar", {
        position: "bottom-right",
      });
    } finally {
      uploadingAvatar = false;
      avatarFile = null;
      avatarPreviewUrl = "";
    }
  }
  async function saveSpaceHandle() {
    if (!globalState.space) return;
    saveSpaceLoading = true;

    if (!newSpaceHandle) {
      globalState.space.handles((h) => h.clear());
      globalState.space.commit();
      saveSpaceLoading = false;
      showSpaceSettings = false;
      toast.success("Saved space with without handle.", {
        position: "bottom-right",
      });
      return;
    }

    try {
      const id = await resolveLeafId(newSpaceHandle);
      if (!id) {
        verificationFailed = true;
        saveSpaceLoading = false;
        return;
      }
      globalState.space.handles((h) => {
        h.clear();
        h.push(newSpaceHandle);
      });
      globalState.space.commit();
      saveSpaceLoading = false;
      showSpaceSettings = false;
      toast.success("Space handle successfully verified & saved!", {
        position: "bottom-right",
      });
    } catch (e) {
      saveSpaceLoading = false;
      verificationFailed = true;
      console.error(e);
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
            {:else if spaceAvatarUrl}
              <img
                src={spaceAvatarUrl}
                alt="Current avatar"
                class="w-full h-full object-cover"
              />
            {:else if globalState.space && globalState.space.id}
              <div class="w-full h-full flex items-center justify-center">
                <AvatarMarble name={globalState.space.id} />
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
    <form class="flex flex-col gap-6 mb-8" onsubmit={saveSpaceHandle}>
      <h2 class="font-bold text-xl">Handle</h2>
      <div class="flex flex-col gap-2">
        <p>
          Space handles are created with DNS records and allow your space to be
          reached at a URL like <code>https://roomy.chat/-/example.org</code>.
        </p>
        {#if !!newSpaceHandle}
          {@const subdomain = newSpaceHandle.split(".").slice(0, -2).join(".")}
          <p>
            Add the following DNS record to your DNS provider to use the domain
            as your handle.
          </p>
          <div class="max-w-full overflow-x-auto min-w-0">
            <table class="table text-[0.85em]">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Host</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>TXT</td>
                  <td>
                    _leaf{subdomain ? "." + subdomain : ""}
                  </td>
                  <td>
                    "id={globalState.space!.id}"
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        {:else}
          <p>Provide a domain to see which DNS record to add for it.</p>
        {/if}
      </div>
      <label class="dz-input w-full">
        <span class="label">Handle</span>
        <input
          bind:value={newSpaceHandle}
          placeholder="example.org"
          type="text"
        />
      </label>

      {#if verificationFailed}
        <div role="alert" class="alert alert-error">
          <span
            >Verification failed. It may take several minutes before DNS records
            are propagated. If you have configured them correctly try again in a
            few minutes.</span
          >
        </div>
      {/if}

      <Button.Root class="dz-btn dz-btn-primary" disabled={saveSpaceLoading}>
        {#if saveSpaceLoading}
          <span class="dz-loading dz-loading-spinner"></span>
        {/if}
        {!!newSpaceHandle ? "Verify" : "Save Without Handle"}
      </Button.Root>
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
