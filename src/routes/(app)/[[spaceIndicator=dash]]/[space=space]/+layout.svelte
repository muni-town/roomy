<script lang="ts">
  import Icon from "@iconify/svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import { Accordion, Button, ToggleGroup } from "bits-ui";

  import { page } from "$app/state";
  import { g } from "$lib/global.svelte";
  import { outerWidth } from "svelte/reactivity/window";

  import { setContext } from "svelte";
  import { slide } from "svelte/transition";
  import type { Item } from "$lib/tiptap/editor";
  import { getProfile } from "$lib/profile.svelte";
  import { derivePromise, navigate, resolveLeafId } from "$lib/utils.svelte";
  import { Category, Channel, Message, Image } from "@roomy-chat/sdk";
  import toast from "svelte-french-toast";
  import { user } from "$lib/user.svelte";
  import { AvatarMarble } from "svelte-boring-avatars";

  let { children } = $props();
  let isMobile = $derived((outerWidth.current || 0) < 640);
  let sidebarAccordionValues = $state(["channels", "threads"]);

  // TODO: track users via the space data
  let users = derivePromise([], async () => {
    if (!g.space || !g.space.channels) {
      return [];
    }

    const result = new Set();
    for (const channel of await g.space.channels.items()) {
      for (const timelineItem of await channel.timeline.items()) {
        const message = timelineItem.tryCast(Message);
        if (message && message.authors.length > 0) {
          for (const author of message.authors((x) => x.toArray())) {
            result.add(author);
          }
        }
      }
    }
    const items = (await Promise.all(
      [...result.values()].map(async (author) => {
        const profile = await getProfile(author as string);
        return { value: author, label: profile?.handle, category: "user" };
      }),
    )) as Item[];

    return items;
  });

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

  let contextItems: { value: Item[] } = derivePromise([], async () => {
    if (!g.space) {
      return [];
    }
    const items = [];

    // add threads to list
    for (const thread of await g.space.threads.items()) {
      if (!thread.softDeleted) {
        items.push({
          value: JSON.stringify({
            id: thread.id,
            space: g.space.id,
            type: "thread",
          }),
          label: thread.name,
          category: "thread",
        });
      }
    }

    for (const wiki of await g.space.wikipages.items()) {
      if (!wiki.softDeleted) {
        items.push({
          value: JSON.stringify({
            id: wiki.id,
            space: g.space.id,
            channel: g.channel?.id,
            type: "wiki",
          }),
          label: wiki.name,
          category: "wiki",
        });
      }
    }

    // add channels to list
    items.push(
      ...(await g.space.channels.items()).map((channel) => {
        return {
          value: JSON.stringify({
            id: channel.id,
            // TODO: I don't know that the space is necessary here or not.
            space: g.space!.id,
            type: "channel",
          }),
          label: channel.name,
          category: "channel",
        };
      }),
    );

    return items;
  });

  setContext("users", users);
  setContext("contextItems", contextItems);

  let showNewCategoryDialog = $state(false);
  let newCategoryName = $state("");
  async function createCategory() {
    if (!g.roomy || !g.space) return;

    const category = await g.roomy.create(Category);
    category.name = newCategoryName;
    category.appendAdminsFrom(g.space);
    category.commit();
    g.space.sidebarItems.push(category);
    g.space.commit();

    showNewCategoryDialog = false;
  }

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

  let showNewChannelDialog = $state(false);
  let newChannelName = $state("");
  let newChannelCategory = $state(undefined) as undefined | Category;
  async function createChannel() {
    if (!g.roomy || !g.space) return;
    const channel = await g.roomy.create(Channel);
    channel.appendAdminsFrom(g.space);
    channel.name = newChannelName;
    channel.commit();

    g.space.channels.push(channel);
    if (newChannelCategory) {
      newChannelCategory.channels.push(channel);
      newChannelCategory.commit();
    } else {
      g.space.sidebarItems.push(channel);
    }
    g.space.commit();

    newChannelCategory = undefined;
    newChannelName = "";
    showNewChannelDialog = false;
  }

  //
  // Category Edit Dialog
  //

  let showCategoryDialog = $state(false);
  let editingCategory = $state(undefined) as undefined | Category;
  let categoryNameInput = $state("");
  function saveCategory() {
    if (!editingCategory) return;
    editingCategory.name = categoryNameInput;
    editingCategory.commit();
    showCategoryDialog = false;
  }
</script>

{#if g.space}
  <nav
    class={[
      !isMobile &&
        "max-w-[16rem] border-r-2 border-base-200 max-h-full h-full min-h-0 overflow-y-auto",
      "px-4 py-5 flex flex-col gap-4 w-full",
    ]}
    style="scrollbar-width: thin;"
  >
    <div class="flex justify-between">
      <h1 class="text-2xl font-extrabold text-base-content text-ellipsis flex">
        {g.space.name}
      </h1>

      {#if g.isAdmin}
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
                <input bind:value={spaceNameInput} placeholder="My Space" />
              </label>
              <Button.Root class="dz-btn dz-btn-primary w-full"
                >Save Name</Button.Root
              >
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
                      <div
                        class="w-full h-full flex items-center justify-center"
                      >
                        <AvatarMarble name={g.space.id} />
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
                  <Button.Root
                    class="dz-btn dz-btn-primary"
                    disabled={uploadingAvatar}
                  >
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
                  Space handles are created with DNS records and allow your
                  space to be reached at a URL like <code
                    >https://roomy.chat/-/example.org</code
                  >.
                </p>
                {#if !!newSpaceHandle}
                  {@const subdomain = newSpaceHandle
                    .split(".")
                    .slice(0, -2)
                    .join(".")}
                  <p>
                    Add the following DNS record to your DNS provider to use the
                    domain as your handle.
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
                            "id={g.space.id}"
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
                <input bind:value={newSpaceHandle} placeholder="example.org" />
              </label>

              {#if verificationFailed}
                <div role="alert" class="alert alert-error">
                  <span
                    >Verification failed. It may take several minutes before DNS
                    records are propagated. If you have configured them
                    correctly try again in a few minutes.</span
                  >
                </div>
              {/if}

              <Button.Root
                class="dz-btn dz-btn-primary"
                bind:disabled={saveSpaceLoading}
              >
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
                />
                <div class="flex flex-col">
                  <span class="mx-2 mt-1 text-sm"
                    >Input a list of handles separated by commas.</span
                  >
                  <span class="mx-2 mt-1 text-sm"
                    >Note: the ban is "best effort" right now. The Roomy alpha
                    is generally insecure.</span
                  >
                </div>
              </div>

              <Button.Root
                class="dz-btn dz-btn-primary w-full"
                bind:disabled={saveSpaceLoading}
              >
                Save Bans
              </Button.Root>
            </form>
          </div>
        </Dialog>
      {/if}
    </div>

    <div class="divider my-0"></div>

    {#if g.isAdmin}
      <menu class="dz-menu p-0 w-full justify-between dz-join dz-join-vertical">
        <Dialog title="Create Channel" bind:isDialogOpen={showNewChannelDialog}>
          {#snippet dialogTrigger()}
            <Button.Root
              title="Create Channel"
              class="dz-btn w-full justify-start dz-join-item text-base-content"
            >
              <Icon icon="basil:comment-plus-solid" class="size-6" />
              Create Channel
            </Button.Root>
          {/snippet}

          <form class="flex flex-col gap-4" onsubmit={createChannel}>
            <label class="dz-input w-full">
              <span class="label">Name</span>
              <input bind:value={newChannelName} placeholder="General" />
            </label>
            <label class="select w-full">
              <span class="label">Category</span>
              <select bind:value={newChannelCategory}>
                <option value={undefined}>None</option>
                {#each categories.value as category}
                  <option value={category}>{category.name}</option>
                {/each}
              </select>
            </label>
            <Button.Root class="dz-btn dz-btn-primary">
              <Icon icon="basil:add-outline" font-size="1.8em" />
              Create Channel
            </Button.Root>
          </form>
        </Dialog>

        <Dialog
          title="Create Category"
          bind:isDialogOpen={showNewCategoryDialog}
        >
          {#snippet dialogTrigger()}
            <Button.Root
              class="dz-btn w-full justify-start dz-join-item text-base-content"
              title="Create Category"
            >
              <Icon icon="basil:folder-plus-solid" class="size-6" />
              Create Category
            </Button.Root>
          {/snippet}

          <form class="flex flex-col gap-4" onsubmit={createCategory}>
            <label class="dz-input w-full">
              <span class="label">Name</span>
              <input bind:value={newCategoryName} placeholder="Discussions" />
            </label>
            <Button.Root class="dz-btn dz-btn-primary">
              <Icon icon="basil:add-outline" font-size="1.8em" />
              Create Category
            </Button.Root>
          </form>
        </Dialog>
      </menu>
    {/if}

    <ToggleGroup.Root type="single" value={g.channel?.id}>
      <Accordion.Root
        type="multiple"
        bind:value={sidebarAccordionValues}
        class="flex flex-col gap-4"
      >
        <Accordion.Item value="channels">
          <Accordion.Header>
            <Accordion.Trigger
              class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
            >
              <h3>Channels</h3>
              <Icon
                icon="basil:caret-up-solid"
                class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("channels") && "rotate-180"}`}
              />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content forceMount>
            {#snippet child({ open }: { open: boolean })}
              {#if open}
                {@render channelsSidebar()}
              {/if}
            {/snippet}
          </Accordion.Content>
        </Accordion.Item>
        {#if availableThreads.value.length > 0}
          <div class="divider my-0"></div>
          <Accordion.Item value="threads">
            <Accordion.Header>
              <Accordion.Trigger
                class="cursor-pointer flex w-full items-center justify-between mb-2 uppercase text-xs font-medium text-base-content"
              >
                <h3>Threads</h3>
                <Icon
                  icon="basil:caret-up-solid"
                  class={`size-4 transition-transform duration-150 ${sidebarAccordionValues.includes("threads") && "rotate-180"}`}
                />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content>
              {#snippet child({ open }: { open: boolean })}
                {#if open}
                  {@render threadsSidebar()}
                {/if}
              {/snippet}
            </Accordion.Content>
          </Accordion.Item>
        {/if}
      </Accordion.Root>
    </ToggleGroup.Root>
  </nav>

  <!-- Events/Room Content -->
  {#if !isMobile}
    <main
      class="flex flex-col gap-4 rounded-lg p-4 grow min-w-0 h-full overflow-clip bg-base-100"
    >
      {@render children()}
    </main>
  {:else if page.params.channel || page.params.thread}
    <main
      class="absolute inset-0 flex flex-col gap-4 rounded-lg p-4 h-screen overflow-clip bg-base-100"
    >
      {@render children()}
    </main>
  {/if}

  <!-- If there is no space. -->
{:else}
  <span class="dz-loading dz-loading-spinner mx-auto w-25"></span>
{/if}

{#snippet channelsSidebar()}
  <div transition:slide class="flex flex-col gap-4">
    <!-- Category and Channels -->
    {#each sidebarItems.value.filter((x) => !x.softDeleted) as item}
      {@const category = item.tryCast(Category)}
      {#if category}
        <Accordion.Root type="single" value={item.name}>
          <Accordion.Item value={item.name}>
            <Accordion.Header class="flex justify-between">
              <Accordion.Trigger
                class="flex text-sm font-semibold gap-2 items-center cursor-pointer"
              >
                <Icon icon="basil:folder-solid" />
                {item.name}
              </Accordion.Trigger>

              {#if g.isAdmin}
                <Dialog
                  title="Channel Settings"
                  bind:isDialogOpen={showCategoryDialog}
                >
                  {#snippet dialogTrigger()}
                    <Button.Root
                      title="Channel Settings"
                      class="cursor-pointer dz-btn dz-btn-ghost dz-btn-circle"
                      onclick={() => {
                        editingCategory = category;
                        categoryNameInput = item.name;
                      }}
                    >
                      <Icon icon="lucide:settings" class="size-4" />
                    </Button.Root>
                  {/snippet}

                  <form
                    class="flex flex-col gap-4 w-full"
                    onsubmit={saveCategory}
                  >
                    <label class="dz-input w-full">
                      <span class="label">Name</span>
                      <input
                        bind:value={categoryNameInput}
                        placeholder="channel-name"
                      />
                    </label>
                    <Button.Root
                      disabled={!categoryNameInput}
                      class="dz-btn dz-btn-primary"
                    >
                      Save Category
                    </Button.Root>
                  </form>
                </Dialog>
              {/if}
            </Accordion.Header>

            <Accordion.Content forceMount>
              {#snippet child({
                props,
                open,
              }: {
                open: boolean;
                props: unknown[];
              })}
                {#if open}
                  <div
                    {...props}
                    transition:slide
                    class="flex flex-col gap-4 py-2"
                  >
                    {#each category.channels.ids() as channelId}
                      {#await g.roomy && g.roomy.open(Channel, channelId) then channel}
                        {#if !channel?.softDeleted}
                          <ToggleGroup.Item
                            onclick={() =>
                              navigate({
                                space: page.params.space!,
                                channel: channelId,
                              })}
                            value={channelId}
                            class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
                          >
                            <h3
                              class="flex justify-start items-center gap-2 px-2"
                            >
                              <Icon icon="basil:comment-solid" />
                              {channel?.name || "..."}
                            </h3>
                          </ToggleGroup.Item>
                        {/if}
                      {/await}
                    {/each}
                  </div>
                {/if}
              {/snippet}
            </Accordion.Content>
          </Accordion.Item>
        </Accordion.Root>
      {:else if item.matches(Channel)}
        <ToggleGroup.Item
          onclick={() =>
            navigate({
              space: page.params.space!,
              channel: item.id,
            })}
          value={item.id}
          class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
        >
          <h3 class="flex justify-start items-center gap-2 px-2">
            <Icon icon="basil:comment-solid" />
            {item.name}
          </h3>
        </ToggleGroup.Item>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet threadsSidebar()}
  <div transition:slide class="flex flex-col gap-4">
    {#each availableThreads.value as thread}
      <ToggleGroup.Item
        onclick={() =>
          navigate({ space: page.params.space!, thread: thread.id })}
        value={thread.id}
        class="w-full cursor-pointer px-1 dz-btn dz-btn-ghost justify-start border border-transparent data-[state=on]:border-primary data-[state=on]:text-primary"
      >
        <h3 class="flex justify-start items-center gap-2 px-2">
          <Icon icon="material-symbols:thread-unread-rounded" />
          {thread.name}
        </h3>
      </ToggleGroup.Item>
    {/each}
  </div>
{/snippet}
