<script lang="ts">
  import PermissionEditor, {
    type PermissionRole,
  } from "@roomy/design/components/ui/PermissionEditor.svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import { createRolesQuery, type Role as SdkRole } from "$lib/queries/roles";
  import { createFederationGrantsQuery } from "$lib/queries/federation";

  const { queryKey } = cache;

  type LocalPermission = "none" | "read" | "readwrite";

  type Role = PermissionRole & {
    rooms: { roomId: string; permission: string }[];
  };

  /** Federated-channel context (from the sidebar entry): the origin space
   * (A) and the origin grant level (`permission`) that caps what members and
   * roles in this space (B) can be granted. */
  type FederatedInfo = {
    originSpaceId: string;
    originSpaceName?: string;
    permission: "read" | "readwrite";
  };

  let {
    spaceId,
    roomId = undefined,
    federated = undefined,
    accessMode = $bindable("open"),
    rolePermissions = $bindable({}),
    defaultAccess = $bindable<"readwrite" | "read" | "none">("readwrite"),
  }: {
    spaceId: string;
    roomId?: string;
    /** When set, the room is a federated (remote) channel: the editor shows
     * receiver-grant toggles for THIS space's members and roles instead of
     * the native members/roles editor. */
    federated?: FederatedInfo;
    accessMode: "open" | "roles";
    rolePermissions: Record<string, LocalPermission>;
    defaultAccess: "readwrite" | "read" | "none";
  } = $props();

  $effect(() => {
    if (federated) return;
    accessMode = defaultAccess === "readwrite" ? "open" : "roles";
  });

  const roomQuery = createQuery(() => ({
    queryKey: queryKey("space.roomy.room.getMetadata", { roomId }),
    queryFn: () =>
      roomId
        ? px().query("space.roomy.room.getMetadata", { roomId })
        : null,
    enabled: !!roomId,
  }));

  $effect(() => {
    if (federated) return;
    const access = roomQuery.data?.defaultAccess;
    if (access) {
      defaultAccess = access;
    }
  });

  const rolesQuery = createRolesQuery(() => spaceId);

  const roles = $derived.by<Role[] | null>(() => {
    const fetched = rolesQuery.data?.roles as SdkRole[] | undefined;
    if (!fetched) return null;
    return fetched.map((role) => ({
      id: role.id,
      name: role.name ?? null,
      rooms: role.rooms,
    }));
  });

  let rolesInitialized = $state(false);
  let receiverInitialized = $state(false);

  // Reset all per-room permission state whenever the edited room changes
  // (the modal stays mounted across opens; without this the previous
  // channel's toggles leak into the next edit). Compared by string key, not
  // by object identity — the parent's `federated` prop is a fresh object on
  // every sidebar refetch, and an identity-only change must NOT wipe the
  // user's in-progress toggles.
  let lastRoomKey: string | null = null;
  $effect(() => {
    if (!roomId) return;
    const key = federated ? `${federated.originSpaceId}\0${roomId}` : `native\0${roomId}`;
    if (key === lastRoomKey) return;
    lastRoomKey = key;
    rolePermissions = {};
    // Federated rooms have no server defaultAccess; the Members toggle is
    // grant-driven and must start at "none" until grants load.
    if (federated) defaultAccess = "none";
    rolesInitialized = false;
    receiverInitialized = false;
  });

  $effect(() => {
    if (federated) return;
    if (rolesInitialized) return;
    if (defaultAccess === "readwrite") return;
    if (!roles) return;
    for (const role of roles) {
      const existing = roomId
        ? role.rooms.find((rm) => rm.roomId === roomId)
        : undefined;
      rolePermissions[role.id] = (existing?.permission ?? "none") as LocalPermission;
    }
    rolesInitialized = true;
  });

  // ── Federated mode: receiver grants ────────────────────────────────────
  // Admin-gated query (getGrants requires a space admin); only fetched when
  // this instance is actually showing a federated channel.
  const grantsQuery = createFederationGrantsQuery(() => spaceId, {
    enabled: () => !!federated && !!roomId,
  });

  // The modal instance is reused across rooms (it stays mounted in the
  // sidebar); the reset effect above already re-arms `receiverInitialized`
  // and clears `rolePermissions` on room change, so this effect can proceed
  // straight to populating toggles from the grants for the current room.
  $effect(() => {
    if (!federated || !roomId) return;
    if (receiverInitialized) return;
    const grants = grantsQuery.data?.receiverGrants;
    if (!grants) return;
    const roles_ = roles;
    if (!roles_) return;
    // The "Members" toggle reflects the members-wide grant (kind='members',
    // grantee = this space's DID). The raw stored permission is shown — an
    // over-ceiling readwrite renders as a disabled Read & Write option.
    const membersGrant = grants.find(
      (x) =>
        x.originSpaceId === federated.originSpaceId &&
        x.roomId === roomId &&
        x.kind === "members",
    );
    defaultAccess = membersGrant
      ? (membersGrant.permission as LocalPermission)
      : "none";
    for (const role of roles_) {
      const g = grants.find(
        (x) =>
          x.originSpaceId === federated.originSpaceId &&
          x.roomId === roomId &&
          x.grantee === role.id &&
          x.kind === "role",
      );
      rolePermissions[role.id] = (g?.permission ?? "none") as LocalPermission;
    }
    receiverInitialized = true;
  });
</script>

<PermissionEditor
  bind:defaultAccess
  bind:rolePermissions
  {roles}
  rolesLoading={rolesQuery.isLoading}
  ceiling={federated?.permission ?? "readwrite"}
/>
