<script lang="ts">
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { toast } from "@foxui/core";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { getBlueskyProfile, upsertBlueskyProfile } from "$lib/mutations/bluesky-profile";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import ScopeGate from "$lib/components/ScopeGate.svelte";

  const spaceId = $derived(page.params.space!);

  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const meta = $derived(metaQuery.data);
  const isAdmin = $derived(metaQuery.data?.isAdmin ?? false);
  // Space-account-management flag gates this arbiter-powered WIP feature
  // (direct navigation lands here even when the section is hidden).
  const flagsQuery = createFeatureFlagsQuery();
  const spaceAccountMgmtEnabled = $derived(
    flagsQuery.data?.flags.includes("space-account-management") ?? false,
  );

  // Bluesky profile state: whether the space has a profile record yet.
  let profileLoading = $state(true);
  let profileError = $state<string | null>(null);
  let hasProfile = $state(false);
  let saving = $state(false);

  $effect(() => {
    if (!isAdmin || !spaceAccountMgmtEnabled) {
      profileLoading = false;
      return;
    }
    getBlueskyProfile(spaceId)
      .then((s) => {
        hasProfile = s.hasProfile;
        profileError = null;
      })
      .catch((e) => {
        profileError = e instanceof Error ? e.message : "Failed to read Bluesky profile";
      })
      .finally(() => {
        profileLoading = false;
      });
  });

  async function onToggleProfile() {
    if (saving || !meta) return;
    saving = true;
    const wasCreate = !hasProfile;
    try {
      await upsertBlueskyProfile(spaceId, {
        displayName: meta.name ?? undefined,
        description: meta.description ?? undefined,
        avatarUri: meta.avatar ?? undefined,
      });
      hasProfile = true;
      toast.success(wasCreate ? "Bluesky profile created." : "Bluesky profile updated.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update Bluesky profile");
    } finally {
      saving = false;
    }
  }
</script>

{#if !spaceAccountMgmtEnabled}
  <p class="text-sm text-base-500 dark:text-base-400">
    Space account management is not enabled for your account yet.
  </p>
{:else if metaQuery.isPending}
  <p class="text-sm text-base-400">Loading…</p>
{:else if metaQuery.isLoadingError}
  <ErrorMessage message={metaQuery.error.message} class="py-8" />
{:else if meta}
  <ScopeGate
    tier="base"
    title="Manage this Space's bluesky profile"
    description="Publishing this Space's profile writes through the Space's arbiter. A session from before this capability shipped needs to re-confirm its access — the consent screen will show the exact permission it requests."
  >
    <div class="flex flex-col gap-6">
      {#if profileLoading}
        <p class="text-sm text-base-400">Checking for an existing profile…</p>
      {:else if profileError}
        <ErrorMessage message={profileError} class="py-4" />
      {:else}
        <Button
          variant="secondary"
          size="sm"
          onclick={onToggleProfile}
          asyncState={saving ? { status: "loading" } : { status: "idle" }}
        >
          {hasProfile ? "Update Bluesky Profile" : "Create Bluesky Profile"}
        </Button>
        <p class="text-sm text-base-500 dark:text-base-400">
          {hasProfile
            ? "This space already has a Bluesky profile. Updating it will refresh the name and description from this space's settings."
            : "This will create a Bluesky profile for the space using its current name and description."}
        </p>
      {/if}
    </div>
  </ScopeGate>
{/if}
