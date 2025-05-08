<script lang="ts">
  import { page } from "$app/state";
  import PageEditor from "$lib/components/PageEditor.svelte";
  import { globalState } from "$lib/global.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { WikiPage, type IntoEntityId } from "@roomy-chat/sdk";

  const pg = derivePromise(
    null,
    async () =>
      await globalState.space?.wikipages.open(
        WikiPage,
        page.params.page as IntoEntityId,
      ),
  );
</script>

{#if pg.value}
  <div class="w-full">
    <PageEditor page={pg.value} />
  </div>
{/if}
