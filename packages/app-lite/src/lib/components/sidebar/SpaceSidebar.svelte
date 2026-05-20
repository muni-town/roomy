<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { schemas } from "@roomy-space/sdk";
  import SidebarLayout from "@roomy/design/components/sidebars/SidebarLayout.svelte";
  import SpaceHeaderShell from "@roomy/design/components/sidebars/SpaceHeaderShell.svelte";
  import SidebarItemShell from "@roomy/design/components/sidebars/SidebarItemShell.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconHome } from "@roomy/design/icons";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { leaveSpace } from "$lib/mutations/space";

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let { spaceId }: { spaceId: string } = $props();

  const metaQuery = createSpaceMetadataQuery(() => spaceId);

  let isEditing = $state(false);

  const meta = $derived(metaQuery.data);
  const showInviteButton = $derived(
    (meta?.joinPolicy.allowPublicJoin ?? false) ||
      (meta?.joinPolicy.allowMemberInvites ?? false) ||
      (meta?.isAdmin ?? false),
  );

  function onInvite() {
    if (meta?.joinPolicy.allowPublicJoin) {
      const url = new URL(page.url.href);
      url.pathname = `/${spaceId}`;
      navigator.clipboard.writeText(url.href);
    } else {
      goto(`/${spaceId}/settings/invites`);
    }
  }

  async function onLeave() {
    try {
      await leaveSpace(spaceId);
    } finally {
      goto("/");
    }
  }
</script>

<SidebarLayout loading={metaQuery.isPending}>
  {#snippet header()}
    <SpaceHeaderShell
      spaceName={meta?.name ?? spaceId}
      isAdmin={meta?.isAdmin ?? false}
      {showInviteButton}
      bind:isEditing
      settingsHref={`/${spaceId}/settings`}
      {onInvite}
      {onLeave}
    >
      {#snippet avatar()}
        <SpaceAvatar src={meta?.avatar ?? undefined} id={spaceId} name={meta?.name ?? undefined} />
      {/snippet}
    </SpaceHeaderShell>
  {/snippet}

  {#snippet prefix()}
    <Button
      class="w-full justify-start mb-2"
      variant="ghost"
      href={`/${spaceId}`}
      data-current={page.url.pathname === `/${spaceId}`}
    >
      <IconHome class="shrink-0" />
      Index
    </Button>
    <hr class="my-2 border-base-800/10 dark:border-base-100/5" />
  {/snippet}

  {#snippet body()}
    {#if metaQuery.isError}
      <p class="px-2 text-sm text-red-600">{metaQuery.error.message}</p>
    {:else if meta}
      <div class="flex flex-col w-full min-h-4">
        {#each meta.sidebar.categories as category (category.id ?? category.name)}
          <div class="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-base-400 dark:text-base-500">
            {category.name}
          </div>
          {#each category.channels as channel (channel.id)}
            {@render channelItem(channel)}
          {/each}
        {/each}
        {#each meta.sidebar.orphans as channel (channel.id)}
          {@render channelItem(channel)}
        {/each}
      </div>
    {/if}
  {/snippet}
</SidebarLayout>

{#snippet channelItem(channel: SidebarChannel)}
  <div class={!channel.canRead ? "opacity-50 pointer-events-none" : ""}>
    <SidebarItemShell
      variant="channel"
      name={channel.name ?? channel.id}
      href={`/${spaceId}/${channel.id}`}
      active={page.params.room === channel.id}
      hasUnreadDot={channel.unreadCount > 0}
      unreadCount={channel.unreadCount}
      showUnreadCount={channel.unreadCount > 0}
    />
  </div>
{/snippet}
