<script lang="ts">
  import { toast } from "@foxui/core";
  import SpaceHeaderShell from "@roomy/design/components/sidebars/SpaceHeaderShell.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { getAppState } from "$lib/queries";
  import { peer, peerStatus } from "$lib/workers";
  import { newUlid } from "@roomy-space/sdk";
  import InviteModal from "$lib/components/modals/InviteModal.svelte";

  const app = getAppState();

  let {
    isEditing = $bindable(false),
  }: {
    isEditing?: boolean;
  } = $props();

  let inviteModalOpen = $state(false);

  let allowPublicJoin = $derived(
    app.currentSpaceState?.allowPublicJoin ?? true,
  );
  let allowMemberInvites = $derived(
    app.currentSpaceState?.allowMemberInvites ?? false,
  );
  let showInviteButton = $derived(
    allowPublicJoin || allowMemberInvites || app.isSpaceAdmin,
  );

  function onInvite() {
    if (allowPublicJoin) {
      const url = new URL(page.url.href);
      url.pathname = `/${page.params.space}`;
      navigator.clipboard.writeText(url.href);
      toast.success("Invite link copied to clipboard");
    } else {
      inviteModalOpen = true;
    }
  }

  async function onLeave() {
    const spaceDid = app.joinedSpace?.id;

    if (peerStatus.roomyState?.state !== "connected") return;
    if (!spaceDid || !peerStatus.roomyState.personalSpace) return;

    peer.sendEvent(spaceDid, {
      id: newUlid(),
      $type: "space.roomy.space.leaveSpace.v0",
    });

    await peer.sendEvent(peerStatus.roomyState.personalSpace, {
      id: newUlid(),
      $type: "space.roomy.space.personal.leaveSpace.v0",
      spaceDid: spaceDid,
    });

    navigate("home");
  }
</script>

<SpaceHeaderShell
  spaceName={app.joinedSpace?.name}
  isAdmin={app.isSpaceAdmin}
  {showInviteButton}
  bind:isEditing
  newHref={app.joinedSpace ? `/${app.joinedSpace.id}/new` : undefined}
  settingsHref={`/${page.params.space}/settings`}
  {onInvite}
  {onLeave}
>
  {#snippet avatar()}
    <SpaceAvatar
      imageUrl={app.joinedSpace?.avatar}
      id={app.joinedSpace?.id}
    />
  {/snippet}
</SpaceHeaderShell>

<InviteModal bind:open={inviteModalOpen} />
