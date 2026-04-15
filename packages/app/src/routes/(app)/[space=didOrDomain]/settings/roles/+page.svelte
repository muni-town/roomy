<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getAppState } from "$lib/queries";
  import Button from "$lib/components/ui/button/Button.svelte";

  const app = getAppState();

  $effect(() => {
    if (app.space.status === "joined" && !app.space.isSpaceAdmin) {
      goto(`/${page.params.space}`);
    }
  });
</script>

<div class="space-y-12 pt-4 overflow-y-auto">
  <div class="space-y-6">
    <h2 class="text-xl/7 font-bold text-base-900 dark:text-base-100">Roles</h2>
    <p class="text-sm text-base-500 dark:text-base-400">
      Create and manage roles to control access to channels and features in your
      space.
    </p>

    <div class="flex items-center justify-between">
      <h3 class="text-lg font-semibold text-base-900 dark:text-base-100">
        Roles
      </h3>
      <Button>Create Role</Button>
    </div>

    <p class="text-sm text-base-400 italic">No roles created yet.</p>
  </div>
</div>
