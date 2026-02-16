<script lang="ts">
  import { Button, toast } from "@fuxui/base";
  import { calendarLinkQuery } from "$lib/queries/calendar.svelte";
  import { current } from "$lib/queries";
  import { peer } from "$lib/workers";
  import { newUlid, type StreamDid } from "@roomy/sdk";

  let spaceId = $derived(current.joinedSpace?.id);
  let linkQuery = $derived(spaceId ? calendarLinkQuery(spaceId) : undefined);
  let existingLink = $derived(
    linkQuery?.current.status === "success"
      ? linkQuery.current.data[0]
      : undefined,
  );

  let groupSlug = $state("");
  let tenantId = $state("");
  let apiUrl = $state("https://api.openmeet.net");
  let saving = $state(false);

  $effect(() => {
    if (existingLink) {
      groupSlug = existingLink.groupSlug;
      tenantId = existingLink.tenantId;
      apiUrl = existingLink.apiUrl;
    }
  });

  async function save() {
    if (!spaceId || !groupSlug.trim() || !tenantId.trim()) return;
    saving = true;
    try {
      await peer.sendEvent(spaceId as StreamDid, {
        id: newUlid(),
        $type: "space.roomy.openmeet.configure.v0",
        groupSlug: groupSlug.trim(),
        tenantId: tenantId.trim(),
        apiUrl: apiUrl.trim() || "https://api.openmeet.net",
      });
      toast.success("Calendar link saved");
    } catch (e) {
      toast.error("Failed to save: " + (e as Error).message);
    } finally {
      saving = false;
    }
  }
</script>

<form
  class="pt-4"
  onsubmit={(e) => {
    e.preventDefault();
    save();
  }}
>
  <div class="space-y-8">
    <h2 class="text-base/7 font-semibold text-base-900 dark:text-base-100">
      OpenMeet Calendar
    </h2>

    <p class="text-sm text-base-600 dark:text-base-400">
      Connect this space to an OpenMeet group to show its events in the sidebar.
    </p>

    <div class="space-y-4">
      <div>
        <label
          for="groupSlug"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
        >
          Group Slug
        </label>
        <p class="mt-1 text-sm text-base-600 dark:text-base-400">
          The URL slug of the OpenMeet group (e.g., "my-community").
        </p>
        <input
          id="groupSlug"
          type="text"
          bind:value={groupSlug}
          placeholder="my-community"
          class="mt-2 block w-full rounded-md border border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 px-3 py-2 text-sm"
          required
        />
      </div>

      <div>
        <label
          for="tenantId"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
        >
          Tenant ID
        </label>
        <p class="mt-1 text-sm text-base-600 dark:text-base-400">
          The OpenMeet tenant identifier (e.g., "openmeet").
        </p>
        <input
          id="tenantId"
          type="text"
          bind:value={tenantId}
          placeholder="openmeet"
          class="mt-2 block w-full rounded-md border border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 px-3 py-2 text-sm"
          required
        />
      </div>

      <div>
        <label
          for="apiUrl"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
        >
          API URL
        </label>
        <p class="mt-1 text-sm text-base-600 dark:text-base-400">
          OpenMeet API endpoint. Leave default unless using a custom deployment.
        </p>
        <input
          id="apiUrl"
          type="url"
          bind:value={apiUrl}
          placeholder="https://api.openmeet.net"
          class="mt-2 block w-full rounded-md border border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 px-3 py-2 text-sm"
        />
      </div>
    </div>

    <Button
      type="submit"
      disabled={saving || !groupSlug.trim() || !tenantId.trim()}
    >
      {saving ? "Saving..." : existingLink ? "Update" : "Connect"}
    </Button>
  </div>
</form>
