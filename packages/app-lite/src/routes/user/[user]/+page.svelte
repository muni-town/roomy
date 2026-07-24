<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte";
  import { uploadBlob } from "@roomy-space/sdk";
  import { resolveBlobUrl } from "$lib/utils";
  import UserProfile from "@roomy/design/components/user/UserProfile.svelte";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { setWideSidebar } from "$lib/components/layout/wide-sidebar.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import { IconPencil, IconEdit, IconCheck, IconX } from "@roomy/design/icons";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";
  import { createProfileQuery } from "$lib/queries/profile";
  import { queryClient } from "$lib/client";
  import { cache } from "@roomy-space/sdk";

  const actorParam = $derived(page.params.user ?? "");
  const profileQuery = createProfileQuery(() => actorParam);
  const profile = $derived(profileQuery.data);
  const error = $derived(
    profileQuery.error
      ? profileQuery.error instanceof Error
        ? profileQuery.error.message
        : String(profileQuery.error)
      : null,
  );

  const isOwnProfile = $derived(
    !!(profile?.did && auth.userDid && profile.did === auth.userDid),
  );

  // ── Edit state ──────────────────────────────────────────────────────────
  let editing = $state(false);
  let editDisplayName = $state("");
  let editDescription = $state("");
  let editPronouns = $state("");
  let editWebsite = $state("");
  let avatarFile = $state<File | null>(null);
  let avatarPreview = $state<string | null>(null);
  let bannerFile = $state<File | null>(null);
  let bannerPreview = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let avatarInput = $state<HTMLInputElement | null>(null);
  let bannerInput = $state<HTMLInputElement | null>(null);

  function clearAvatarSelection() {
    avatarFile = null;
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    avatarPreview = null;
  }

  function clearBannerSelection() {
    bannerFile = null;
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    bannerPreview = null;
  }

  function handleAvatarSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    avatarFile = file;
    avatarPreview = URL.createObjectURL(file);
  }

  function handleBannerSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    bannerFile = file;
    bannerPreview = URL.createObjectURL(file);
  }

  function startEditing() {
    if (!profile) return;
    editDisplayName = profile.displayName ?? "";
    editDescription = profile.description ?? "";
    editPronouns = profile.pronouns ?? "";
    editWebsite = profile.website ?? "";
    clearAvatarSelection();
    clearBannerSelection();
    saveError = null;
    editing = true;
  }

  function cancelEditing() {
    editing = false;
    clearAvatarSelection();
    clearBannerSelection();
    saveError = null;
  }

  async function saveProfile() {
    const agent = auth.agent;
    if (!agent) return;
    saving = true;
    saveError = null;

    try {
      const record: Record<string, unknown> = {
        $type: "space.roomy.user.profile",
      };
      if (editDisplayName) record.displayName = editDisplayName;
      if (editDescription) record.description = editDescription;
      if (editPronouns) record.pronouns = editPronouns;
      if (editWebsite) record.website = editWebsite;

      if (avatarFile) {
        const bytes = await avatarFile.arrayBuffer();
        const { blob } = await uploadBlob(agent, bytes, {
          mimetype: avatarFile.type,
        });
        record.avatar = blob;
      } else if (profile?.avatar) {
        // Reuse the existing avatar blob ref from the current Roomy profile
        // record (or the Bluesky profile record as fallback). The Roomy
        // record stores an atblob:// ref string, but putRecord needs the
        // raw blob ref object — fetch the PDS record to get it.
        const roomyRecord = await agent.com.atproto.repo.getRecord({
          collection: "space.roomy.user.profile",
          repo: agent.assertDid,
          rkey: "self",
        }).catch(() => null);
        const roomyVal = roomyRecord?.data.value as { avatar?: unknown } | undefined;
        if (roomyVal?.avatar) {
          record.avatar = roomyVal.avatar;
        } else {
          // Fall back to the Bluesky profile record for the blob ref.
          const bskyRecord = await agent.com.atproto.repo.getRecord({
            collection: "app.bsky.actor.profile",
            repo: agent.assertDid,
            rkey: "self",
          });
          const val = bskyRecord.data.value as { avatar?: unknown };
          if (val.avatar) {
            record.avatar = val.avatar;
          }
        }
      }

      if (bannerFile) {
        const bytes = await bannerFile.arrayBuffer();
        const { blob } = await uploadBlob(agent, bytes, {
          mimetype: bannerFile.type,
        });
        record.banner = blob;
      } else if (profile?.banner) {
        // Reuse the existing banner blob ref, same logic as avatar above.
        const roomyRecord = await agent.com.atproto.repo.getRecord({
          collection: "space.roomy.user.profile",
          repo: agent.assertDid,
          rkey: "self",
        }).catch(() => null);
        const roomyVal = roomyRecord?.data.value as { banner?: unknown } | undefined;
        if (roomyVal?.banner) {
          record.banner = roomyVal.banner;
        } else {
          const bskyRecord = await agent.com.atproto.repo.getRecord({
            collection: "app.bsky.actor.profile",
            repo: agent.assertDid,
            rkey: "self",
          });
          const val = bskyRecord.data.value as { banner?: unknown };
          if (val.banner) {
            record.banner = val.banner;
          }
        }
      }

      await agent.com.atproto.repo.putRecord(
        {
          collection: "space.roomy.user.profile",
          repo: agent.assertDid,
          rkey: "self",
          record,
        },
        {
          headers: {
            "atproto-proxy": `${agent.assertDid}#atproto_pds`,
          },
        },
      );

      // Invalidate the appserver profile query so it re-fetches from HappyView.
      await queryClient.invalidateQueries({
        queryKey: cache.queryKey("space.roomy.user.getProfile", { actor: agent.assertDid }),
      });
      editing = false;
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Failed to save profile";
      console.error("saveProfile error", e);
    } finally {
      saving = false;
    }
  }

  const avatarSrc = $derived(avatarPreview ?? resolveBlobUrl(profile?.avatar));
  const bannerSrc = $derived(bannerPreview ?? resolveBlobUrl(profile?.banner));

  // Resolve atblob:// refs to browser-fetchable URLs for display.
  const displayProfile = $derived({
    did: profile?.did,
    handle: profile?.handle,
    displayName: profile?.displayName,
    description: profile?.description,
    avatar: resolveBlobUrl(profile?.avatar),
    banner: resolveBlobUrl(profile?.banner),
  });

  onMount(() => {
    setNavbar(userNavbar);
    setSidebarContent(userSidebar);
    setWideSidebar(true);
    return () => {
      setNavbar(undefined);
      setSidebarContent(undefined);
      setWideSidebar(false);
    };
  });
</script>

<SeoMeta
  title={profile?.displayName ? `${profile.displayName} (@${profile.handle}) - Roomy` : `@${page.params.user} - Roomy`}
  description={profile?.description}
  image={profile?.avatar}
  type="profile"
/>

{#snippet userNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    User Profile
  </div>
{/snippet}

{#snippet userSidebar()}
  <SpaceSidebar />
{/snippet}

<div class="flex flex-col gap-4 w-full h-full overflow-y-auto sm:px-4 pb-8">
  {#if error}
    <div class="flex items-center justify-center h-full">
      <p class="text-sm text-red-600">Failed to load profile: {error}</p>
    </div>
  {:else if profile}
    {#if editing}
      <div class="mx-auto w-full max-w-full sm:max-w-2xl sm:py-6">
        <div class="flex items-center justify-between px-4 sm:px-0 mb-4">
          <h2 class="text-lg font-bold text-base-900 dark:text-base-100">Edit Profile</h2>
          <div class="flex gap-2">
            <Button variant="ghost" size="sm" onclick={cancelEditing} disabled={saving}>
              <IconX />
            </Button>
            <Button variant="primary" size="sm" onclick={saveProfile} asyncState={saving ? { status: "loading" } : { status: "idle" }}>
              <IconCheck /> Save
            </Button>
          </div>
        </div>

        {#if saveError}
          <div class="px-4 sm:px-0 mb-4">
            <p class="text-sm text-red-600">{saveError}</p>
          </div>
        {/if}

        <div class="flex flex-col gap-6">
          <!-- Banner — full width -->
          <div>
            <span class="block text-sm font-medium mb-2 text-base-900 dark:text-base-100 px-4 sm:px-0">
              Banner
            </span>
            <div class="relative">
              <button
                type="button"
                class="group relative w-full cursor-pointer"
                onclick={() => bannerInput?.click()}
              >
                {#if bannerSrc}
                  <img
                    src={bannerSrc}
                    alt=""
                    class="aspect-[3/1] w-full object-cover border border-base-300 dark:border-base-800 sm:rounded-xl sm:border"
                  />
                {:else}
                  <div class="aspect-[3/1] w-full bg-accent-100 dark:bg-base-900 border border-base-300 dark:border-base-800 sm:rounded-xl sm:border"></div>
                {/if}
                <div
                  class="absolute bottom-2 right-2 flex items-center justify-center size-6 rounded-full bg-base-900/70 text-white shadow-sm transition-opacity group-hover:bg-base-900/90"
                >
                  <IconEdit class="size-3.5" />
                </div>
              </button>
              <input
                type="file"
                accept="image/png,image/jpeg"
                class="hidden"
                bind:this={bannerInput}
                onchange={handleBannerSelect}
              />
            </div>
          </div>
          <!-- Avatar + name/pronouns row -->
          <div class="flex items-start gap-4 px-4 sm:px-0 flex-wrap max-w-2xl">
            <!-- Avatar -->
            <div class="shrink-0">
              <span class="block text-sm font-medium mb-2 text-base-900 dark:text-base-100">
                Avatar
              </span>
              <button
                type="button"
                class="group relative cursor-pointer"
                onclick={() => avatarInput?.click()}
              >
                <UserAvatar
                  src={avatarSrc}
                  name={profile.did}
                  class="size-22 sm:size-20 outline rounded-full outline-base-100 dark:outline-base-950"
                />
                <div
                  class="absolute bottom-0 right-0 flex items-center justify-center size-5 rounded-full bg-base-900/70 text-white shadow-sm transition-opacity group-hover:bg-base-900/90"
                >
                  <IconEdit class="size-3" />
                </div>
              </button>
              <input
                type="file"
                accept="image/png,image/jpeg"
                class="hidden"
                bind:this={avatarInput}
                onchange={handleAvatarSelect}
              />
            </div>

            <!-- Display Name + Pronouns (inline) -->
            <div class="flex min-w-0 max-w-full flex-1 flex-wrap items-start gap-x-3 gap-y-1 ">
              <div class="w-64 min-w-0 flex flex-col">
                <label class="block text-sm font-medium text-base-700 dark:text-base-300 mb-1 truncate" for="edit-displayName">Display Name</label>
                <Input id="edit-displayName" bind:value={editDisplayName} placeholder="Your display name" maxlength={640} class="w-full" />
              </div>
              <div class="w-64 shrink-0">
                <label class="block text-sm font-medium text-base-700 dark:text-base-300 mb-1" for="edit-pronouns">Pronouns</label>
                <Input id="edit-pronouns" bind:value={editPronouns} placeholder="e.g. they/them" maxlength={200} />
              </div>
            </div>
          </div>

          <!-- Bio -->
          <div class="px-4 sm:px-0">
            <label class="block text-sm font-medium text-base-700 dark:text-base-300 mb-1" for="edit-description">Bio</label>
            <textarea
              id="edit-description"
              bind:value={editDescription}
              placeholder="Tell us about yourself"
              maxlength={2560}
              rows={4}
              class="w-full rounded-md text-sm border-1 font-light focus-visible:outline-0 border-neutral-400/50 dark:border-neutral-700 bg-neutral-300/50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-100 placeholder:text-base-500 dark:placeholder:text-base-50/50 px-3 py-1.5 text-base min-h-[80px]"
            ></textarea>
          </div>

          <!-- Website -->
          <div class="px-4 sm:px-0">
            <label class="block text-sm font-medium text-base-700 dark:text-base-300 mb-1" for="edit-website">Website</label>
            <Input id="edit-website" bind:value={editWebsite} placeholder="https://example.com" type="url" />
          </div>
        </div>
      </div>
    {:else}
      <div class="mx-auto w-full max-w-full sm:max-w-2xl sm:py-6">
        {#if isOwnProfile}
          {#snippet editButton()}
            <Button variant="secondary" size="icon" class="rounded-full" onclick={startEditing} aria-label="Edit profile">
              <IconPencil class="size-4" />
            </Button>
          {/snippet}
          <UserProfile profile={displayProfile} actions={editButton} />
        {:else}
          <UserProfile profile={displayProfile} />
        {/if}
      </div>
    {/if}
  {:else}
    <div class="flex items-center justify-center h-full">
      <p class="text-sm text-base-400">Loading profile…</p>
    </div>
  {/if}
</div>
