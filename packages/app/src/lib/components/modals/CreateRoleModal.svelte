<script lang="ts">
  import { toast } from "@foxui/core";
  import RoleCreateForm from "@roomy/design/components/modals/RoleCreateForm.svelte";
  import { peer } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  import { newUlid } from "@roomy-space/sdk";

  const app = getAppState();

  let {
    open = $bindable(false),
    onCreated,
  }: {
    open: boolean;
    onCreated?: () => void;
  } = $props();

  let creating = $state(false);

  async function onCreate(name: string, description: string) {
    if (!app.joinedSpace) return;
    creating = true;
    try {
      await peer.sendEvent(app.joinedSpace.id, {
        id: newUlid(),
        $type: "space.roomy.role.createRole.v0",
        name,
        description: description || undefined,
      });
      open = false;
      onCreated?.();
    } catch (e) {
      toast.error("Failed to create role");
      console.error(e);
    } finally {
      creating = false;
    }
  }
</script>

<RoleCreateForm bind:open {creating} {onCreate} />
