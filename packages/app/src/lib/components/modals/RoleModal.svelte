<script lang="ts">
  import { toast } from "@foxui/core";
  import RoleEditForm from "@roomy/design/components/modals/RoleEditForm.svelte";
  import { peer } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  import { newUlid, Ulid } from "@roomy-space/sdk";

  const app = getAppState();

  let {
    open = $bindable(false),
    role,
    onSaved,
  }: {
    open: boolean;
    role: {
      id: string;
      name: string | null;
      description: string | null;
    } | null;
    onSaved?: () => void;
  } = $props();

  let saving = $state(false);

  async function onSave(name: string, description: string) {
    if (!role || !app.joinedSpace) return;
    saving = true;
    try {
      await peer.sendEvent(app.joinedSpace.id, {
        id: newUlid(),
        $type: "space.roomy.role.updateRole.v0",
        roleId: Ulid.assert(role.id),
        name: name || undefined,
        description: description || undefined,
      });
      open = false;
      onSaved?.();
    } catch (e) {
      toast.error("Failed to update role");
      console.error(e);
    } finally {
      saving = false;
    }
  }
</script>

<RoleEditForm bind:open {role} {saving} {onSave} />
