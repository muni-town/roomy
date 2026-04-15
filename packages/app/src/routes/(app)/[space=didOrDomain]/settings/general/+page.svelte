<script lang="ts">
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { peer } from "$lib/workers";
  import { Button, Input, Textarea, toast } from "@foxui/core";
  import { newUlid } from "@roomy-space/sdk";
  import { page } from "$app/state";
  import { flags } from "$lib/config";
  import ToggleGroup from "$lib/components/ui/ToggleGroup.svelte";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";

  let currentSpace = $derived(app.joinedSpace);
  let spaceId = $derived(currentSpace?.id);
  let spaceName = $derived(currentSpace?.name ?? "");
  let avatarUrl = $derived(currentSpace?.avatar ?? "");
  let spaceDescription = $derived(currentSpace?.description ?? "");

  let avatarFile = $state<File | null>(null);
  let isSaving = $state(false);

  // ── Join policy ────────────────────────────────────────────────────────────

  type JoinPolicyRow = {
    allow_public_join: number | null;
    allow_member_invites: number | null;
  };

  const joinPolicyQuery = new LiveQuery<JoinPolicyRow>(
    () =>
      sql`SELECT allow_public_join, allow_member_invites FROM comp_space WHERE entity = ${spaceId}`,
  );

  // Stored values from DB
  let storedAllowPublicJoin = $derived(
    joinPolicyQuery.result?.[0]?.allow_public_join === 0 ? "no" : "yes",
  );
  let storedAllowMemberInvites = $derived(
    joinPolicyQuery.result?.[0]?.allow_member_invites === 1 ? "yes" : "no",
  );

  let allowPublicJoin = $state("yes");
  let allowMemberInvites = $state("no");

  // Initialise editable state from DB once loaded; also re-syncs after save
  $effect(() => {
    if (joinPolicyQuery.result === undefined) return;
    allowPublicJoin = storedAllowPublicJoin;
    allowMemberInvites = storedAllowMemberInvites;
  });

  let spaceUrlLabel = $derived(
    `${page.url.host}/${currentSpace?.handle ?? page.params.space}`,
  );

  // ── Change detection ───────────────────────────────────────────────────────

  let nameChanged = $derived(spaceName != currentSpace?.name);
  let avatarChanged = $derived(avatarUrl != currentSpace?.avatar);
  let descriptionChanged = $derived(
    spaceDescription != currentSpace?.description,
  );
  let joinPolicyChanged = $derived(
    flags.inviteOnly &&
      (allowPublicJoin !== storedAllowPublicJoin ||
        allowMemberInvites !== storedAllowMemberInvites),
  );
  let hasChanged = $derived(
    nameChanged || avatarChanged || descriptionChanged || joinPolicyChanged,
  );

  // ── Actions ────────────────────────────────────────────────────────────────

  function resetData() {
    spaceName = currentSpace?.name ?? "";
    avatarUrl = currentSpace?.avatar ?? "";
    avatarFile = null;
    allowPublicJoin = storedAllowPublicJoin;
    allowMemberInvites = storedAllowMemberInvites;
  }

  async function save() {
    if (!spaceId) return;

    try {
      isSaving = true;

      const avatarUpload =
        avatarFile && (await peer.uploadToPds(await avatarFile.arrayBuffer()));

      await peer.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.updateSpaceInfo.v0",
        avatar: avatarChanged ? avatarUpload?.uri : undefined,
        name: nameChanged ? spaceName : undefined,
        description: descriptionChanged ? spaceDescription : undefined,
        allowPublicJoin:
          allowPublicJoin !== storedAllowPublicJoin
            ? allowPublicJoin === "yes"
            : undefined,
        allowMemberInvites:
          allowMemberInvites !== storedAllowMemberInvites
            ? allowMemberInvites === "yes"
            : undefined,
      });

      toast.success("Space updated successfully", { position: "bottom-right" });
    } catch (e) {
      console.error("Error updating space:", e);
      toast.error("Error updating space", { position: "bottom-right" });
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
          <SpaceAvatar imageUrl={avatarUrl} id={spaceId} size={64} />

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

      {#if flags.inviteOnly}
        <div class="col-span-full flex flex-col gap-6">
          <div>
            <p class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1">
              Allow anyone to join via <span class="font-mono">{spaceUrlLabel}</span>?
            </p>
            <ToggleGroup
              name="allowPublicJoin"
              bind:value={allowPublicJoin}
              options={[
                { label: "Yes", value: "yes" },
                { label: "Require Invite", value: "no" },
              ]}
            />
          </div>

          {#if allowPublicJoin === "no"}
            <div>
              <p class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1">
                Allow any member to create an invite link?
              </p>
              <ToggleGroup
                name="allowMemberInvites"
                bind:value={allowMemberInvites}
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
