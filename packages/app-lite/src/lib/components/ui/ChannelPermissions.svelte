<script lang="ts">
  import PermissionEditor, {
    type PermissionRole,
  } from "@roomy/design/components/ui/PermissionEditor.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";
  import { IconLoading } from "@roomy/design/icons";
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
   * (A) and the origin grant level (`permission`) that caps what roles in
   * this space (B) can be granted. */
  type FederatedInfo = {
    originSpaceId: string;
    originSpaceName?: string;
    permission: "read" | "readwrite";
  };

  const PERM_OPTIONS = [
    { label: "None", value: "none" },
    { label: "Read", value: "read" },
    { label: "Read & Write", value: "readwrite" },
  ];

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
     * receiver-grant toggles per role in THIS space instead of the native
     * members/roles editor. */
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

  /**
   * Clamp a role toggle to the origin grant's ceiling: a receiver grant can
   * never exceed what the origin space offered (server enforces the same cap
   * at read time via minPermission — this keeps the UI from showing a
   * setting that silently reads back lower).
   */
  function onRoleChange(roleId: string, v: string) {
    const ceiling = federated?.permission;
    const perm: LocalPermission =
      v === "none" ? "none" : ceiling === "read" && v === "readwrite" ? "read" : (v as LocalPermission);
    rolePermissions[roleId] = perm;
  }
</script>

{#if federated && roomId}
  <div class="flex flex-col gap-5">
    <div class="flex items-center justify-between">
      <span class="text-md font-regular text-base-900 dark:text-base-100 shrink-0">
        Federated channel access
      </span>
      <span class="text-sm text-base-500 dark:text-base-400 shrink-0">
        Origin grants {federated.permission === "readwrite" ? "Read & Write" : "Read"}
      </span>
    </div>
    <p class="text-sm text-base-400">
      This channel belongs to {federated.originSpaceName ?? federated.originSpaceId}.
      The origin space exposes it at most
      {federated.permission === "readwrite" ? "read & write" : "read"}; choose which
      roles in this space can use it, up to that ceiling.
    </p>
    {#if rolesQuery.isLoading && roles === null}
      <IconLoading class="animate-spin" font-size={20} />
    {:else if roles !== null && roles.length === 0}
      <p class="text-sm text-base-400">
        No roles configured. Create roles in <b>Space Settings -&gt; Permissions</b> to
        grant access to this channel.
      </p>
    {:else if roles !== null}
      <div class="flex flex-col">
        {#each roles as role (role.id)}
          <div class="flex items-center justify-between gap-4">
            <span class="text-md font-regular text-base-900 dark:text-base-100 shrink-0">
              {role.name ?? "Unnamed role"}
            </span>
            <ToggleGroup
              name={`fed-role-${role.id}`}
              value={rolePermissions[role.id] ?? "none"}
              options={PERM_OPTIONS}
              onchange={(v) => onRoleChange(role.id, v)}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <PermissionEditor
    bind:defaultAccess
    bind:rolePermissions
    {roles}
    rolesLoading={rolesQuery.isLoading}
  />
{/if}
