<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import { auth, login, logout } from "$lib/auth.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { schemas } from "@roomy-space/sdk";

  type Space = typeof schemas.queries.getSpaces.Space.infer;

  let handle = $state("");

  async function onLogin() {
    const h = handle.trim();
    if (!h) return;
    await login(h);
  }
</script>

<div class="min-h-screen bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
  {#if auth.initError}
    <pre class="m-4 p-3 rounded-2xl text-sm whitespace-pre-wrap bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300">{auth.initError}</pre>
  {:else if !auth.authenticated}
    <div class="flex items-center justify-center min-h-screen">
      <div class="w-full max-w-sm px-4">
        <h1 class="text-2xl font-bold mb-1">Roomy</h1>
        <p class="text-base-500 dark:text-base-400 mb-6 text-sm">Sign in with your ATProto handle</p>

        <label for="handle" class="block mb-1 font-medium text-sm">ATProto handle</label>
        <Input id="handle" placeholder="user.bsky.social" bind:value={handle} />

        <Button class="mt-4 w-full" onclick={onLogin} disabled={!handle.trim()}>
          Login
        </Button>
      </div>
    </div>
  {:else}
    {@render spaceList()}
  {/if}
</div>

{#snippet spaceList()}
  {@const spacesQuery = createSpacesQuery()}

  <header class="flex items-center justify-between px-4 py-2 border-b border-base-200 dark:border-base-800 bg-white dark:bg-base-900">
    <div class="flex items-center gap-3">
      <span class="font-bold text-lg">Roomy</span>
      <span class="text-sm text-base-500 dark:text-base-400">{auth.agent?.did}</span>
    </div>
    <Button variant="ghost" size="sm" onclick={logout}>Logout</Button>
  </header>

  <main class="max-w-2xl mx-auto px-4 py-6">
    <h2 class="text-lg font-semibold mb-3">Your spaces</h2>

    {#if spacesQuery.isPending}
      <p class="text-sm text-base-400">Loading spaces…</p>
    {:else if spacesQuery.isError}
      <p class="text-sm text-red-600">Error: {spacesQuery.error.message}</p>
    {:else if spacesQuery.data}
      {@const spaces = spacesQuery.data.spaces}
      {#if spaces.length === 0}
        <p class="text-sm text-base-400">No spaces found.</p>
      {:else}
        <ul class="space-y-2">
          {#each spaces as space (space.id)}
            {@render spaceItem(space)}
          {/each}
        </ul>
      {/if}
    {/if}
  </main>
{/snippet}

{#snippet spaceItem(space: Space)}
  <li>
    <a
      href={`/${space.id}`}
      class="block p-3 rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900 hover:border-base-300 dark:hover:border-base-700"
    >
    <div class="flex items-center justify-between">
      <span class="font-medium text-sm truncate">{space.name || space.id.slice(0, 12) + "…"}</span>
      {#if space.unreadCount > 0}
        <span class="bg-accent-500 text-white text-xs px-1.5 py-0.5 rounded-full font-medium min-w-[20px] text-center">
          {space.unreadCount}
        </span>
      {/if}
    </div>
    <div class="flex gap-1 mt-1">
      {#if space.isMember}
        <span class="text-[10px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">member</span>
      {/if}
      {#if space.isAdmin}
        <span class="text-[10px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">admin</span>
      {/if}
    </div>
    </a>
  </li>
{/snippet}
