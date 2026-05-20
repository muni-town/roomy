<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import SidebarLayout from "@roomy/design/components/sidebars/SidebarLayout.svelte";
  import SpaceHeaderShell from "@roomy/design/components/sidebars/SpaceHeaderShell.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconArrowLeft } from "@roomy/design/icons";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { leaveSpace } from "$lib/mutations/space";

  let { spaceId }: { spaceId: string } = $props();

  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const meta = $derived(metaQuery.data);

  let isEditing = $state(false);

  const showInviteButton = $derived(
    (meta?.joinPolicy.allowPublicJoin ?? false) ||
      (meta?.joinPolicy.allowMemberInvites ?? false) ||
      (meta?.isAdmin ?? false),
  );

  const tabs = [
    { slug: "", label: "General" },
    { slug: "roles", label: "Roles" },
    { slug: "members", label: "Members" },
    { slug: "invites", label: "Invites" },
  ];

  function isActive(slug: string) {
    const base = `/${spaceId}/settings`;
    return slug === ""
      ? page.url.pathname === base
      : page.url.pathname === `${base}/${slug}`;
  }

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

<SidebarLayout>
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
    <Button class="w-full justify-start mb-4" href={`/${spaceId}`}>
      <IconArrowLeft class="size-4" />
      Back to space
    </Button>
  {/snippet}

  {#snippet body()}
    <div class="flex flex-col w-full gap-2">
      {#each tabs as tab (tab.slug)}
        <Button
          variant="ghost"
          class="w-full justify-start"
          href={`/${spaceId}/settings${tab.slug ? `/${tab.slug}` : ""}`}
          data-current={isActive(tab.slug)}
        >
          {tab.label}
        </Button>
      {/each}
    </div>
  {/snippet}
</SidebarLayout>
