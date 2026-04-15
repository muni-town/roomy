<script lang="ts">
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { createSpace } from "$lib/mutations/space";
  import { navigate } from "$lib/utils.svelte";
  import { peerStatus } from "$lib/workers";
  import type { AsyncStateWithIdle, StreamDid } from "@roomy-space/sdk";
  import { IconXMark } from "@roomy/design/icons";
  import { flags } from "$lib/config";
  import ToggleGroup from "$lib/components/ui/ToggleGroup.svelte";
  import {
    Alert,
    Button,
    Input,
    Textarea,
    toast,
  } from "@foxui/core";

  type SpaceCreationState = AsyncStateWithIdle<{ spaceDid: StreamDid }>;

  let form = $state<{
    spaceName: string;
    spaceDescription: string;
    isDiscoverable: boolean;
    avatarFile: File | null;
    dismissAlert: boolean;
    allowPublicJoin: string;
    allowMemberInvites: string;
  }>({
    spaceName: "",
    spaceDescription: "",
    isDiscoverable: true,
    avatarFile: null,
    dismissAlert: false,
    allowPublicJoin: "yes",
    allowMemberInvites: "no",
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
      peerStatus.authState?.state != "authenticated" ||
      peerStatus.roomyState?.state !== "connected"
    )
      throw new Error("Not connected");

    try {
      spaceCreationState = { status: "loading" };

      const { spaceDid } = await createSpace({
        spaceName: form.spaceName,
        spaceDescription: form.spaceDescription || undefined,
        avatarFile: form.avatarFile || undefined,
        allowPublicJoin: flags.inviteOnly ? form.allowPublicJoin === "yes" : undefined,
        allowMemberInvites: flags.inviteOnly && form.allowPublicJoin === "no" ? form.allowMemberInvites === "yes" : undefined,
        creator: {
          did: peerStatus.authState.did,
          personalStreamId: peerStatus.roomyState.personalSpace,
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
          {#if !flags.inviteOnly}
            <p>
              <strong>We currently only support public spaces</strong>, meaning
              anyone can find and join them.
            </p>
          {/if}
        </div>
        <div>
          <Button
            class="hover:bg-blue-400/30 hover:text-black p-1.5"
            type="button"
            variant="ghost"
            onclick={() => (form.dismissAlert = true)}><IconXMark /></Button
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

      {#if flags.inviteOnly}
        <div class="col-span-full flex flex-col gap-6">
          <div>
            <p class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1">
              Allow anyone to join?
            </p>
            <ToggleGroup
              name="allowPublicJoin"
              bind:value={form.allowPublicJoin}
              options={[
                { label: "Yes", value: "yes" },
                { label: "Require Invite", value: "no" },
              ]}
            />
          </div>

          {#if form.allowPublicJoin === "no"}
            <div>
              <p class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1">
                Allow any member to create an invite link?
              </p>
              <ToggleGroup
                name="allowMemberInvites"
                bind:value={form.allowMemberInvites}
                options={[
                  { label: "Yes", value: "yes" },
                  { label: "Admins Only", value: "no" },
                ]}
              />
            </div>
          {/if}
        </div>
      {/if}
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
