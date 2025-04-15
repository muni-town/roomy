<script lang="ts">
  import { g } from "$lib/global.svelte";
  import { derivePromise, resolveLeafId } from "$lib/utils.svelte";

  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";

  import { Button, Tabs } from "bits-ui";

  import ThemeSelector from "$lib/components/ThemeSelector.svelte";
  import ChatMode from "$lib/components/ChatMode.svelte";

  import { Category, Image } from "@roomy-chat/sdk";
  import UserSession from "./UserSession.svelte";
  import { getProfile } from "$lib/profile.svelte";
  import toast from "svelte-french-toast";
  import { user } from "$lib/user.svelte";
  import SidebarIcon from "./SidebarIcon.svelte";
  import { getContext } from "svelte";
  import IndexMode from "./IndexMode.svelte";
  import { AvatarMarble } from "svelte-boring-avatars";

  let tab = $state("index");

  let availableThreads = derivePromise([], async () =>
    ((await g.space?.threads.items()) || []).filter((x) => !x.softDeleted),
  );

  let categories = derivePromise([], async () => {
    if (!g.space) return [];
    return (await g.space.sidebarItems.items())
      .map((x) => x.tryCast(Category) as Category)
      .filter((x) => !!x);
  });

  let sidebarItems = derivePromise([], async () => {
    if (!g.space) return [];
    return await g.space.sidebarItems.items();
  });

  let saveSpaceLoading = $state(false);
  let showSpaceSettings = $state(false);
  let newSpaceHandle = $state("");
  let spaceNameInput = $state("");
  let bannedHandlesInput = $state("");
  let verificationFailed = $state(false);
  let avatarFile = $state<File | null>(null);
  let avatarPreviewUrl = $state("");
  let spaceAvatarUrl = $state("");
  let uploadingAvatar = $state(false);

  $effect(() => {
    if (!g.space) return;
    if (!showSpaceSettings) {
      spaceNameInput = g.space.name;
      newSpaceHandle = g.space?.handles((x) => x.get(0)) || "";
      verificationFailed = false;
      saveSpaceLoading = false;
      avatarFile = null;
      avatarPreviewUrl = "";

      // Load current avatar if exists
      spaceAvatarUrl = "";
      // Access the image entity directly
      const imageId = g.space.image;

      if (imageId && g.roomy) {
        g.roomy.open(Image, imageId).then((image) => {
          if (image.uri) {
            spaceAvatarUrl = image.uri;
            console.log("Set avatar URL:", spaceAvatarUrl);
          }
        });
      }

      Promise.all(
        Object.keys(g.space.bans((x) => x.toJSON())).map((x) => getProfile(x)),
      ).then(
        (profiles) =>
          (bannedHandlesInput = profiles.map((x) => x.handle).join(", ")),
      );
    }
  });
  async function saveBannedHandles() {
    if (!g.space || !user.agent) return;
    const bannedIds = (
      await Promise.all(
        bannedHandlesInput
          .split(",")
          .map((x) => x.trim())
          .filter((x) => !!x)
          .map((x) => user.agent!.resolveHandle({ handle: x })),
      )
    ).map((x) => x.data.did);
    g.space.bans((bans) => {
      bans.clear();
      for (const ban of bannedIds) {
        bans.set(ban, true);
      }
    });
    g.space.commit();
    showSpaceSettings = false;
  }
  async function saveSpaceName() {
    if (!g.space) return;
    g.space.name = spaceNameInput;
    g.space.commit();
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
    if (!avatarFile || !g.space || !g.roomy || !user.agent) return;

    try {
      uploadingAvatar = true;

      // Upload the image using the user's agent
      const uploadResult = await user.uploadBlob(avatarFile);
      console.log("Upload result:", uploadResult);

      try {
        // Create an Image entity
        const image = await g.roomy.create(Image);
        console.log("Created image entity:", image);

        // Set the image URI
        image.uri = uploadResult.url;
        image.commit();
        console.log("Committed image entity:", image);

        try {
          g.space.image = image.id;
          g.space.commit();

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
    if (!g.space) return;
    saveSpaceLoading = true;

    if (!newSpaceHandle) {
      g.space.handles((h) => h.clear());
      g.space.commit();
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
      g.space.handles((h) => {
        h.clear();
        h.push(newSpaceHandle);
      });
      g.space.commit();
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
  let isSpacesVisible: { value: boolean; toggle: () => void } =
    getContext("isSpacesVisible");
</script>

<aside
  class="w-[min(70vw,20rem)] sm:w-[16rem] bg-base-300 flex h-full flex-col gap-1 border-r-2 border-base-300"
>
  <!-- Header -->
  <div
    class="w-full py-1 px-2 h-fit grid grid-cols-[auto_1fr_auto] justify-center items-center"
  >
    <SidebarIcon class="mr-2 px-1 py-1" open={isSpacesVisible} />
    <h1 class="text-sm font-medium text-base-content breadcrumbs">
      <span class="font-bold">
        {g.space?.name && g.space?.name !== "Unnamed" ? g.space.name : ""}
      </span>
      {g.channel?.name && g.channel.name !== "Unnamed"
        ? "/ " + g.channel.name
        : ""}
    </h1>
    {#if g.isAdmin}
      {@render spaceSettings()}
    {/if}
  </div>
  <!-- Index Chat Toggle -->
  <Tabs.Root bind:value={tab} class="px-2">
    <Tabs.List class="flex w-full rounded-lg tabs-box">
      <Tabs.Trigger value="index" class="grow tab flex gap-2">
        <Icon icon="material-symbols:inbox-rounded" class="text-2xl" />
      </Tabs.Trigger>
      <Tabs.Trigger
        disabled={!g.roomy}
        value="chat"
        class="grow tab flex gap-2"
      >
        <Icon icon="tabler:message" class="text-2xl" />
      </Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>
  <nav
    class="min-h-0 overflow-y-auto p-2 flex flex-col gap-4 w-full"
    style="scrollbar-width: thin;"
  >
    {#if tab === "index"}
      <IndexMode {availableThreads} />
    {:else if tab === "chat" && g.space}
      <ChatMode {categories} channels={sidebarItems} />
    {/if}
  </nav>
  <div class="grow"></div>
  <!-- User + Theme -->
  <div class="px-2">
    <section
      class="flex justify-self-end justify-between bg-base-200 rounded-lg gap-3 px-1 py-2 shadow-inner my-3 mt-1"
    >
      <UserSession />
      <ThemeSelector />
    </section>
  </div>
</aside>

{#snippet spaceSettings()}
  <Dialog title="Space Settings" bind:isDialogOpen={showSpaceSettings}>
    {#snippet dialogTrigger()}
      <Button.Root
        title="Space Settings"
        class="btn btn-ghost w-full justify-start join-item text-base-content"
      >
        <Icon icon="lucide:settings" class="size-4" />
      </Button.Root>
    {/snippet}

    <form onsubmit={saveSpaceName} class="flex flex-col gap-3">
      <label class="input w-full">
        <span class="label">Name</span>
        <input bind:value={spaceNameInput} placeholder="My Space" />
      </label>
      <Button.Root class="btn btn-primary w-full">Save Name</Button.Root>
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
            {:else if g.space && g.space.id}
              <div class="w-full h-full flex items-center justify-center">
                <AvatarMarble name={g.space.id} />
              </div>
            {/if}
          </div>

          <div class="flex flex-col gap-2">
            <label class="btn btn-sm btn-outline">
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
                class="btn btn-sm btn-outline btn-error"
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
          <Button.Root class="btn btn-primary" disabled={uploadingAvatar}>
            {#if uploadingAvatar}
              <span class="loading loading-spinner"></span>
            {/if}
            Upload Avatar
          </Button.Root>
        {/if}
      </div>
    </form>
    <form class="flex flex-col gap-6" onsubmit={saveSpaceHandle}>
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
                    "id={g.space?.id}"
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        {:else}
          <p>Provide a domain to see which DNS record to add for it.</p>
        {/if}
      </div>
      <label class="input w-full">
        <span class="label">Handle</span>
        <input bind:value={newSpaceHandle} placeholder="example.org" />
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

      <Button.Root class="btn btn-primary" bind:disabled={saveSpaceLoading}>
        {#if saveSpaceLoading}
          <span class="loading loading-spinner"></span>
        {/if}
        {!!newSpaceHandle ? "Verify" : "Save Without Handle"}
      </Button.Root>
    </form>

    <form class="flex flex-col gap-4" onsubmit={saveBannedHandles}>
      <h2 class="font-bold text-xl">Bans</h2>

      <div>
        <input class="input w-full" bind:value={bannedHandlesInput} />
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
        class="btn btn-primary w-full"
        bind:disabled={saveSpaceLoading}
      >
        Save Bans
      </Button.Root>
    </form>
  </Dialog>
{/snippet}
