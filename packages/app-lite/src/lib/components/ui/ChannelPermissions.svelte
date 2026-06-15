<script lang="ts">
  import PermissionEditor, {
    type PermissionRole,
  } from "@roomy/design/components/ui/PermissionEditor.svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import { createRolesQuery, type Role as SdkRole } from "$lib/queries/roles";

  const { queryKey } = cache;

  type Role = PermissionRole & {
    rooms: { roomId: string; permission: string }[];
  };

  let {
    spaceId,
    roomId = undefined,
    accessMode = $bindable("open"),
    rolePermissions = $bindable({}),
    defaultAccess = $bindable<"readwrite" | "read" | "none">("readwrite"),
  }: {
    spaceId: string;
    roomId?: string;
    accessMode: "open" | "roles";
    rolePermissions: Record<string, "none" | "read" | "readwrite">;
    defaultAccess: "readwrite" | "read" | "none";
  } = $props();

  $effect(() => {
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
  $effect(() => {
    if (rolesInitialized) return;
    if (defaultAccess === "readwrite") return;
    if (!roles) return;
    for (const role of roles) {
      const existing = roomId
        ? role.rooms.find((rm) => rm.roomId === roomId)
        : undefined;
      rolePermissions[role.id] = (existing?.permission ?? "none") as
        | "none"
        | "read"
        | "readwrite";
    }
    rolesInitialized = true;
  });
</script>

<PermissionEditor
  bind:defaultAccess
  bind:rolePermissions
  {roles}
  rolesLoading={rolesQuery.isLoading}
/>
