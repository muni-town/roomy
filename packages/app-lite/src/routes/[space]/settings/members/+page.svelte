<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { createMembersQuery } from "$lib/queries/members";

  const spaceId = $derived(page.params.space!);
  const membersQuery = createMembersQuery(() => spaceId);
</script>

<div class="max-w-2xl">
  <h2 class="text-base font-semibold mb-3">Members</h2>

  {#if membersQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if membersQuery.isError}
    <p class="text-sm text-red-600">{membersQuery.error.message}</p>
  {:else if membersQuery.data}
    {@const { members, externalAdmins } = membersQuery.data}

    <ul class="space-y-1 mb-6">
      {#each members as m (m.did)}
        <li class="flex items-center gap-3 p-2 rounded-xl bg-white dark:bg-base-900 border border-base-200 dark:border-base-800">
          <button
            onclick={() => goto(`/user/${m.did}`)}
            class="w-8 h-8 rounded-full bg-base-200 dark:bg-base-700 flex items-center justify-center text-xs font-bold text-base-500 hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer shrink-0"
          >
            {(m.name ?? "?")[0]?.toUpperCase() ?? "?"}
          </button>
          <div class="min-w-0 flex-1">
            <a href={`/user/${m.did}`} class="text-sm font-medium truncate hover:underline">{m.name ?? m.did}</a>
            <a href={`/user/${m.did}`} class="text-xs text-base-400 truncate block hover:underline">{m.handle ?? m.did}</a>
          </div>
          {#if m.isAdmin}
            <span class="text-[10px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">admin</span>
          {/if}
        </li>
      {/each}
    </ul>

    {#if externalAdmins.length > 0}
      <h3 class="text-sm font-semibold mt-4 mb-2">External admins</h3>
      <ul class="space-y-1">
        {#each externalAdmins as a (a.did)}
          <li class="flex items-center gap-3 p-2 rounded-xl bg-white dark:bg-base-900 border border-base-200 dark:border-base-800">
            <div class="text-sm">{a.name ?? a.handle ?? a.did}</div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
