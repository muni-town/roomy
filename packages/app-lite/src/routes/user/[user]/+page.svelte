<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte";
  import UserProfile from "@roomy/design/components/user/UserProfile.svelte";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { setWideSidebar } from "$lib/components/layout/wide-sidebar.svelte";
  import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";

  let profile = $state<ProfileViewDetailed | undefined>(undefined);
  let error = $state<string | null>(null);

  $effect(() => {
    const actor = page.params.user;
    if (!actor || !auth.agent) return;

    auth.agent
      .getProfile({ actor })
      .then((resp) => {
        profile = resp.data;
      })
      .catch((err) => {
        error = err instanceof Error ? err.message : String(err);
      });
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
    <UserProfile {profile} />
  {:else}
    <div class="flex items-center justify-center h-full">
      <p class="text-sm text-base-400">Loading profile…</p>
    </div>
  {/if}
</div>
