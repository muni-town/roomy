<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { updateSpaceInfo, leaveSpace } from "$lib/mutations/space";
  import { uploadFile } from "$lib/mutations/upload";
  import {
    getCurrentSpaceHandle,
    getSpaceHandleDomainsForSpace,
    setSpaceHandleForSpace,
  } from "$lib/mutations/space-handle";
  import { resolveBlobUrl } from "$lib/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input, {
    inputVariants,
  } from "@roomy/design/components/ui/input/Input.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";
  import { IconEdit } from "@roomy/design/icons";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";

  const spaceId = $derived(page.params.space!);
  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const meta = $derived(metaQuery.data);
  const isAdmin = $derived(metaQuery.data?.isAdmin ?? false);
  // Space-account-management flag gates the arbiter-powered WIP features
  // (space handle settings, Bluesky profile integration).
  const flagsQuery = createFeatureFlagsQuery();
  const spaceAccountMgmtEnabled = $derived(
    flagsQuery.data?.flags.includes("space-account-management") ?? false,
  );

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
  let isLeaving = $state(false);

  // Space handle (set on the stewarded account via the arbiter).
  let handleDomains = $state<string[]>([]);
  let handleError = $state<string | null>(null);
  let handleSaving = $state(false);
  let spaceHandle = $state("");
  let currentHandle = $state<string | null>(null);

  // Load the PDS's available handle suffixes + the current handle when the
  // admin opens the page.
  $effect(() => {
    if (!isAdmin || !spaceAccountMgmtEnabled) return;
    getSpaceHandleDomainsForSpace(spaceId)
      .then((domains) => {
        handleDomains = domains;
      })
      .catch((e) => {
        handleError =
          e instanceof Error ? e.message : "Failed to load available handle domains";
      });
    getCurrentSpaceHandle(spaceId)
      .then((handle) => {
        currentHandle = handle;
        if (handle) spaceHandle = handle;
      })
      .catch(() => {
        // Non-fatal; the input can still be used.
      });
  });

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

  async function onLeave() {
    try {
      isLeaving = true;
      await leaveSpace(spaceId);
    } finally {
      goto("/");
    }
  }

  async function setHandle() {
    if (!spaceHandle.trim() || handleSaving) return;
    handleSaving = true;
    handleError = null;
    try {
      const newHandle = spaceHandle.trim();
      await setSpaceHandleForSpace(spaceId, newHandle);
      currentHandle = newHandle;
    } catch (e) {
      handleError = e instanceof Error ? e.message : "Failed to set the space handle";
    } finally {
      handleSaving = false;
    }
  }
</script>

<div class="max-w-2xl">
  {#if isAdmin}
    {#if metaQuery.isPending}
      <p class="text-sm text-base-400">Loading…</p>
    {:else if metaQuery.isError}
      <ErrorMessage message={metaQuery.error.message} class="py-8" />
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
            <button
              type="button"
              class="group relative cursor-pointer"
              onclick={() => fileInput?.click()}
            >
              <SpaceAvatar
                src={avatarSrc}
                id={spaceId}
                name={meta.name ?? undefined}
                size={64}
              />
              <div
                class="absolute bottom-0 right-0 flex items-center justify-center size-5 rounded-full bg-base-900/70 text-white shadow-sm transition-opacity group-hover:bg-base-900/90"
              >
                <IconEdit class="size-3" />
              </div>
            </button>
            <input
              type="file"
              accept="image/*"
              class="hidden"
              bind:this={fileInput}
              onchange={handleAvatarSelect}
            />
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

        {#if spaceAccountMgmtEnabled}
        <div class="border-t border-base-200 dark:border-base-800 pt-6">
          <div class="flex flex-col gap-2">
            <p class="block text-sm font-medium mb-1 text-base-900 dark:text-base-100">
              Space handle
            </p>
            {#if currentHandle}
              <p class="text-sm text-base-900 dark:text-base-100 font-mono">
                {currentHandle}
              </p>
            {/if}
            <p class="text-sm text-base-500 dark:text-base-400">
              {#if handleDomains.length === 1}
                Set a handle for this space on its account. It must end in
                {handleDomains[0]}.
              {:else if handleDomains.length > 1}
                Set a handle for this space on its account. It must end in one
                of {handleDomains.join(", ")}.
              {:else}
                Set a handle for this space on its account.
              {/if}
            </p>
            <p class="text-sm text-base-500 dark:text-base-400">
              <strong>Note:</strong> This feature is experimental and may not be
              fully functional yet.
            </p>
            <div class="flex items-center gap-2">
              <Input
                placeholder={handleDomains.length
                  ? `myname${handleDomains[0]}`
                  : "handle"}
                bind:value={spaceHandle}
                class="flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onclick={setHandle}
                asyncState={handleSaving ? { status: "loading" } : { status: "idle" }}
                disabled={!spaceHandle.trim()}
              >
                {handleSaving ? "Setting…" : "Set handle"}
              </Button>
            </div>
            {#if handleError}
              <p class="text-sm text-red-600">{handleError}</p>
            {/if}
          </div>
        </div>
        {/if}
      </form>
    {/if}
  {:else}
    <div class="flex flex-col items-center gap-4 py-12">
      <p class="text-sm text-base-500 dark:text-base-400">
        You don't have permission to edit this space's settings.
      </p>
    </div>
  {/if}

  <!-- Danger zone: available to all members. -->
  <div class="mt-8 pt-6 border-t border-base-200 dark:border-base-800">
    <Button variant="red" onclick={onLeave} disabled={isLeaving}>
      {isLeaving ? "Leaving…" : "Leave Space"}
    </Button>
  </div>
</div>
