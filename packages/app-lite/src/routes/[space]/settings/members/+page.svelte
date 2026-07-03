<script lang="ts">
  import { page } from "$app/state";
  import { createMembersQuery } from "$lib/queries/members";
  import { resolveBlobUrl } from "$lib/utils";
  import { auth } from "$lib/auth.svelte";
  import { sendEvents } from "$lib/mutations/send-events";
  import { newUlid, type UserDid } from "@roomy-space/sdk";
  import { toast } from "@foxui/core";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import ContextMenu from "@roomy/design/components/ui/context-menu/ContextMenu.svelte";
  import ContextMenuItem from "@roomy/design/components/ui/context-menu/ContextMenuItem.svelte";
  import { IconEllipsisHorizontal } from "@roomy/design/icons";

  const spaceId = $derived(page.params.space!);
  const membersQuery = createMembersQuery(() => spaceId);

  const currentUserDid = $derived(auth.userDid);

  const currentUserIsAdmin = $derived(
    membersQuery.data?.members.some(
      (m) => m.did === currentUserDid && m.isAdmin,
    ) ?? false,
  );

  async function addAdmin(memberDid: string) {
    try {
      await sendEvents(spaceId, [
        {
          id: newUlid(),
          $type: "space.roomy.space.addAdmin.v0",
          userDid: memberDid as UserDid,
        },
      ]);
      toast.success("Member promoted to admin.");
      membersQuery.refetch();
    } catch (err) {
      toast.error("Failed to promote member.");
      console.error(err);
    }
  }

  async function removeAdmin(memberDid: string) {
    try {
      await sendEvents(spaceId, [
        {
          id: newUlid(),
          $type: "space.roomy.space.removeAdmin.v0",
          userDid: memberDid as UserDid,
        },
      ]);
      toast.success("Admin privileges removed.");
      membersQuery.refetch();
    } catch (err) {
      toast.error("Failed to demote member.");
      console.error(err);
    }
  }
</script>

<div class="max-w-2xl">
  {#if membersQuery.isPending}
    <p class="text-sm text-base-400">Loading…</p>
  {:else if membersQuery.isError}
    <ErrorMessage message={membersQuery.error.message} class="py-8" />
  {:else if membersQuery.data}
    {@const { members, externalAdmins } = membersQuery.data}

    <ul class="space-y-1 mb-6">
      {#each members as m (m.did)}
        <li class="flex items-center gap-3 p-2 rounded-xl bg-white dark:bg-base-900 border border-base-200 dark:border-base-800">
          <a href={`/user/${m.did}`}>
            <UserAvatar
              src={resolveBlobUrl(m.avatar)}
              name={m.did}
              size={32}
              class="size-8 shrink-0 rounded-full"
            />
          </a>
          <div class="min-w-0 flex-1">
            <a href={`/user/${m.did}`} class="text-sm font-medium truncate hover:underline">{m.name ?? m.did}</a>
            <a href={`/user/${m.did}`} class="text-xs text-base-400 truncate block hover:underline">{m.handle ?? m.did}</a>
          </div>
          {#if m.isAdmin}
            <span class="text-[10px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">admin</span>
          {/if}
          {#if currentUserIsAdmin && m.did !== currentUserDid}
            <ContextMenu>
              {#snippet trigger({ props })}
                <button
                  class="p-1 rounded-lg text-base-400 hover:text-base-700 dark:hover:text-base-300 hover:bg-base-200 dark:hover:bg-base-700 transition-colors"
                  aria-label="Member actions"
                  {...props}
                >
                  <IconEllipsisHorizontal class="size-4" />
                </button>
              {/snippet}
              {#if m.isAdmin}
                <ContextMenuItem onclick={() => removeAdmin(m.did)}>
                  Demote Admin
                </ContextMenuItem>
              {:else}
                <ContextMenuItem onclick={() => addAdmin(m.did)}>
                  Promote to Admin
                </ContextMenuItem>
              {/if}
            </ContextMenu>
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
