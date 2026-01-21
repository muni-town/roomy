<script lang="ts">
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { createSpace } from "$lib/mutations/space";
  import type { AsyncStateWithIdle } from "$lib/types/asyncState";
  import { navigate } from "$lib/utils.svelte";
  import { backendStatus } from "$lib/workers";
  import type { StreamDid } from "@roomy/sdk";
  import IconHeroiconsXMark from "~icons/heroicons/x-mark";
  import {
    Alert,
    Button,
    // Checkbox,
    Input,
    // Label,
    Textarea,
    toast,
  } from "@fuxui/base";

  type SpaceCreationState = AsyncStateWithIdle<{ spaceDid: StreamDid }>;

  let form = $state<{
    spaceName: string;
    spaceDescription: string;
    isDiscoverable: boolean;
    avatarFile: File | null;
    dismissAlert: boolean;
  }>({
    spaceName: "",
    spaceDescription: "",
    isDiscoverable: true,
    avatarFile: null,
    dismissAlert: false,
  });

  let avatarUrl = $derived.by(() => {
    if (form.avatarFile) {
      return URL.createObjectURL(form.avatarFile);
    }
    return undefined;
  });

  let spaceCreationState = $state<SpaceCreationState>({ status: "idle" });

  async function handleAvatarSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      if (file) {
        form.avatarFile = file;
      }
    }
  }

  let fileInput = $state<HTMLInputElement | null>(null);

  async function createSpaceSubmit(evt: Event) {
    evt.preventDefault();
    if (
      backendStatus.authState?.state != "authenticated" ||
      backendStatus.roomyState?.state !== "connected"
    )
      return;

    try {
      spaceCreationState = { status: "loading" };

      const { spaceDid } = await createSpace({
        spaceName: form.spaceName,
        spaceDescription: form.spaceDescription || undefined,
        avatarFile: form.avatarFile || undefined,
        creator: {
          did: backendStatus.authState.did,
          personalStreamId: backendStatus.roomyState.personalSpace,
        },
      });

      spaceCreationState = { status: "success", data: { spaceDid } };
      toast.success("Space created successfully", {
        position: "bottom-right",
      });

      // FIXME: add discoverable feed.
      // if (isDiscoverable) {
      //   console.log("Adding to discoverable spaces feed");
      //   await addToDiscoverableSpacesFeed(space.id);
      // }

      navigate({ space: spaceDid });
    } catch (e) {
      console.error("Error creating space:", e);
      const stringError =
        e instanceof Error
          ? ": " + e.message
          : typeof e === "string"
            ? ": " + e
            : "";
      spaceCreationState = { status: "error", message: stringError };
      toast.error("Error creating space" + stringError, {
        position: "bottom-right",
      });
    }
  }
</script>

<form class="pt-4" onsubmit={createSpaceSubmit}>
  <div class="space-y-8">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      Create a new space
    </h2>
    {#if !form.dismissAlert}
      <Alert type="info" class="text-sm flex items-start gap-2"
        ><div class="space-y-2 grow">
          <p>
            Spaces are a way to organize related rooms, pages, and members. You
            can think of them as communities or groups within the platform.
          </p>
          <p>
            <strong>We currently only support public spaces</strong>, meaning
            anyone can find and join them.
          </p>
        </div>
        <div>
          <Button
            class="hover:bg-blue-400/30 hover:text-black p-1.5"
            type="button"
            variant="ghost"
            onclick={() => (form.dismissAlert = true)}
            ><IconHeroiconsXMark /></Button
          >
        </div>
      </Alert>
    {/if}

    <div class=" grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
      <div class="sm:col-span-4">
        <label
          for="name"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >Name</label
        >
        <div class="mt-2">
          <Input id="name" bind:value={form.spaceName} class="w-full" />
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
          <Textarea
            bind:value={form.spaceDescription}
            class="w-full"
            rows={4}
          />
        </div>
      </div>

      <!-- <div class="sm:col-span-full">
        Spaces are currently publicly discoverable by default.
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
            checked={form.isDiscoverable}
            disabled={true}
          />
          <Label
            id="discovery-label"
            for="discovery"
            class="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Allow space to be publicly discoverable.
          </Label>
        </div>
      </div> -->
    </div>
  </div>

  <div class="mt-6 flex items-center justify-end gap-x-6">
    <div>
      <Button
        type="submit"
        disabled={!form.spaceName || spaceCreationState.status !== "idle"}
      >
        {#if spaceCreationState.status === "loading"}
          Creating...
        {:else}
          Create Space
        {/if}
      </Button>
    </div>
  </div>
</form>
