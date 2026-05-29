<script lang="ts">
  import { toast } from "@foxui/core";
  import SpaceHeaderShell from "@roomy/design/components/sidebars/SpaceHeaderShell.svelte";
  import CreateRoomModal from "@roomy/design/components/modals/CreateRoomModal.svelte";
  import { navigate } from "$lib/utils.svelte";
  import { page } from "$app/state";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { getAppState } from "$lib/queries";
  import { peer, peerStatus } from "$lib/workers";
  import { newUlid, Ulid, ulidFactory } from "@roomy-space/sdk";
  import { deepClone } from "@ark/util";
  import InviteModal from "$lib/components/modals/InviteModal.svelte";

  const app = getAppState();

  let {
    isEditing = $bindable(false),
  }: {
    isEditing?: boolean;
  } = $props();

  let inviteModalOpen = $state(false);
  let createModalOpen = $state(false);

  let allowPublicJoin = $derived(
    app.currentSpaceState?.allowPublicJoin ?? true,
  );
  let allowMemberInvites = $derived(
    app.currentSpaceState?.allowMemberInvites ?? false,
  );
  let showInviteButton = $derived(
    allowPublicJoin || allowMemberInvites || app.isSpaceAdmin,
  );

  const spaceId = $derived(app.joinedSpace?.id ?? page.params.space);

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

  async function handleCreate(opts: {
    type: "Channel" | "Category";
    name: string;
  }) {
    if (!spaceId) return;

    if (opts.type === "Category") {
      const cats = app.categories;
      if (!cats) return;

      const newUlidFn = ulidFactory();
      const newCategories = deepClone(cats).map((c: { id?: string; name: string; children: { id: string }[] }) => ({
        id: c.id ?? newUlidFn(),
        name: c.name,
        children: c.children.map((ch: { id: string }) => Ulid.assert(ch.id)),
      }));

      newCategories.push({ id: newUlidFn(), name: opts.name, children: [] });

      await peer.sendEvent(spaceId, {
        id: newUlid(),
        $type: "space.roomy.space.updateSidebar.v1",
        categories: newCategories,
      });
    } else {
      const id = newUlid();

      await peer.sendEvent(spaceId, {
        id,
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.channel",
        name: opts.name,
      });

      navigate({ space: spaceId, object: id });
    }
  }
</script>

<SpaceHeaderShell
  spaceName={app.joinedSpace?.name}
  isAdmin={app.isSpaceAdmin}
  {showInviteButton}
  bind:isEditing
  onNew={() => (createModalOpen = true)}
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

<CreateRoomModal
  bind:open={createModalOpen}
  spaceId={spaceId}
  onCreate={handleCreate}
/>

<InviteModal bind:open={inviteModalOpen} />
