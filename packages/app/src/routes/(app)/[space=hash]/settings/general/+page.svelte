<script lang="ts">
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { current } from "$lib/queries.svelte";
  import { backend } from "$lib/workers";
  import { Button, Input, Textarea, toast } from "@fuxui/base";
  import { ulid } from "ulidx";

  let spaceName = $derived(current.space?.name ?? "");
  let avatarUrl = $derived(current.space?.avatar ?? "");
  let spaceDescription = $derived(current.space?.description ?? "");

  let avatarFile = $state<File | null>(null);

  let isSaving = $state(false);

  let nameChanged = $derived(spaceName != current.space?.name);
  let avatarChanged = $derived(avatarUrl != current.space?.avatar);
  let descriptionChanged = $derived(
    spaceDescription != current.space?.description,
  );
  let hasChanged = $derived(nameChanged || avatarChanged || descriptionChanged);

  function resetData() {
    spaceName = current.space?.name ?? "";
    avatarUrl = current.space?.avatar ?? "";
    avatarFile = null;
  }

  async function save() {
    if (!current.space) return;

    try {
      isSaving = true;

      const avatarUpload =
        avatarFile &&
        (await backend.uploadToPds(await avatarFile.arrayBuffer()));

      // Update space info
      await backend.sendEvent(current.space.id, {
        ulid: ulid(),
        parent: undefined,
        variant: {
          kind: "space.roomy.info.0",
          data: {
            avatar:
              avatarChanged && avatarUpload
                ? { set: avatarUpload.uri }
                : { ignore: undefined },
            name: nameChanged ? { set: spaceName } : { ignore: undefined },
            description: descriptionChanged
              ? { set: spaceDescription }
              : { ignore: undefined },
          },
        },
      });

      toast.success("Space updated successfully", {
        position: "bottom-right",
      });
    } catch (e) {
      console.error("Error updating space:", e);
      toast.error("Error updating space", {
        position: "bottom-right",
      });
    } finally {
      isSaving = false;
    }
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

  let fileInput = $state<HTMLInputElement | null>(null);
</script>

<form class="pt-4">
  <div class="space-y-12">
    <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">
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
          <SpaceAvatar imageUrl={avatarUrl} id={current.space?.id} size={64} />

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
