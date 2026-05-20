<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { updateSpaceInfo } from "$lib/mutations/space";
  import { uploadFile } from "$lib/mutations/upload";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input, {
    inputVariants,
  } from "@roomy/design/components/ui/input/Input.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";

  const spaceId = $derived(page.params.space!);
  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const meta = $derived(metaQuery.data);

  // Editable form state, (re)initialised from server metadata.
  let name = $state("");
  let description = $state("");
  let allowPublicJoin = $state("yes");
  let allowMemberInvites = $state("no");
  let avatarFile = $state<File | null>(null);
  let avatarPreview = $state<string | null>(null);

  let isSaving = $state(false);
  let saveError = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  function clearAvatarSelection() {
    avatarFile = null;
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    avatarPreview = null;
  }

  // Initialise on load and re-sync after a successful save: the space topic
  // subscription invalidates the metadata query, producing a fresh `meta`.
  $effect(() => {
    if (!meta) return;
    name = meta.name ?? "";
    description = meta.description ?? "";
    allowPublicJoin = meta.joinPolicy.allowPublicJoin ? "yes" : "no";
    allowMemberInvites = meta.joinPolicy.allowMemberInvites ? "yes" : "no";
    untrack(clearAvatarSelection);
  });

  function resolveBlobUrl(uri: string | null | undefined): string | undefined {
    if (!uri) return undefined;
    if (uri.startsWith("atblob://")) {
      const [did, cid] = uri.slice("atblob://".length).split("/");
      if (!did || !cid) return undefined;
      return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`;
    }
    return uri;
  }

  const avatarSrc = $derived(avatarPreview ?? resolveBlobUrl(meta?.avatar));

  const nameChanged = $derived(!!meta && name !== (meta.name ?? ""));
  const descriptionChanged = $derived(
    !!meta && description !== (meta.description ?? ""),
  );
  const avatarChanged = $derived(avatarFile !== null);
  const publicJoinChanged = $derived(
    !!meta && (allowPublicJoin === "yes") !== meta.joinPolicy.allowPublicJoin,
  );
  const memberInvitesChanged = $derived(
    !!meta &&
      (allowMemberInvites === "yes") !== meta.joinPolicy.allowMemberInvites,
  );
  const hasChanged = $derived(
    nameChanged ||
      descriptionChanged ||
      avatarChanged ||
      publicJoinChanged ||
      memberInvitesChanged,
  );

  function handleAvatarSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    avatarFile = file;
    avatarPreview = URL.createObjectURL(file);
  }

  function reset() {
    if (!meta) return;
    name = meta.name ?? "";
    description = meta.description ?? "";
    allowPublicJoin = meta.joinPolicy.allowPublicJoin ? "yes" : "no";
    allowMemberInvites = meta.joinPolicy.allowMemberInvites ? "yes" : "no";
    clearAvatarSelection();
    saveError = null;
  }

  async function save() {
    if (!meta || !hasChanged || isSaving) return;
    isSaving = true;
    saveError = null;
    try {
      let avatarUri: string | undefined;
      if (avatarFile) {
        avatarUri = (await uploadFile(avatarFile)).uri;
      }
      await updateSpaceInfo(spaceId, {
        name: nameChanged ? name : undefined,
        description: descriptionChanged ? description : undefined,
        avatar: avatarUri,
        allowPublicJoin: publicJoinChanged
          ? allowPublicJoin === "yes"
          : undefined,
        allowMemberInvites: memberInvitesChanged
          ? allowMemberInvites === "yes"
          : undefined,
      });
      clearAvatarSelection();
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Failed to save changes";
    } finally {
      isSaving = false;
    }
  }
</script>

<div class="max-w-2xl">
  <h2 class="text-base font-semibold mb-4">General</h2>

  {#if metaQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if metaQuery.isError}
    <p class="text-sm text-red-600">{metaQuery.error.message}</p>
  {:else if meta}
    <form
      class="flex flex-col gap-6"
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div>
        <span
          class="block text-sm font-medium mb-2 text-base-900 dark:text-base-100"
        >
          Avatar
        </span>
        <div class="flex items-center gap-3">
          <SpaceAvatar
            src={avatarSrc}
            id={spaceId}
            name={meta.name ?? undefined}
            size={64}
          />
          <input
            type="file"
            accept="image/*"
            class="hidden"
            bind:this={fileInput}
            onchange={handleAvatarSelect}
          />
          <Button
            type="button"
            variant="secondary"
            onclick={() => fileInput?.click()}
          >
            Change
          </Button>
        </div>
      </div>

      <div>
        <label
          for="space-name"
          class="block text-sm font-medium mb-2 text-base-900 dark:text-base-100"
        >
          Space name
        </label>
        <Input id="space-name" bind:value={name} class="w-full" />
      </div>

      <div>
        <label
          for="space-description"
          class="block text-sm font-medium mb-2 text-base-900 dark:text-base-100"
        >
          Description
        </label>
        <textarea
          id="space-description"
          bind:value={description}
          rows={4}
          class={`${inputVariants({ variant: "secondary" })} w-full resize-y`}
        ></textarea>
      </div>

      <div class="flex flex-col gap-4">
        <div>
          <p
            class="block text-sm font-medium mb-2 text-base-900 dark:text-base-100"
          >
            Who can join this space?
          </p>
          <ToggleGroup
            name="allowPublicJoin"
            bind:value={allowPublicJoin}
            options={[
              { label: "Anyone", value: "yes" },
              { label: "Invite only", value: "no" },
            ]}
          />
        </div>

        {#if allowPublicJoin === "no"}
          <div>
            <p
              class="block text-sm font-medium mb-2 text-base-900 dark:text-base-100"
            >
              Who can create invite links?
            </p>
            <ToggleGroup
              name="allowMemberInvites"
              bind:value={allowMemberInvites}
              options={[
                { label: "Any member", value: "yes" },
                { label: "Admins only", value: "no" },
              ]}
            />
          </div>
        {/if}
      </div>

      {#if saveError}
        <p class="text-sm text-red-600">{saveError}</p>
      {/if}

      <div class="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={!hasChanged || isSaving}
          onclick={reset}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!hasChanged || isSaving}>
          {isSaving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  {/if}
</div>
