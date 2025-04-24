<script lang="ts">
  import { page } from "$app/state";
  import WikiEditor from "$lib/components/WikiEditor.svelte";
  import { g } from "$lib/global.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { Channel, WikiPage } from "@roomy-chat/sdk";

  const wiki = derivePromise(
    null,
    async () => await g.space?.wikipages.open(WikiPage, page.params.wiki),
  );
</script>

{#if wiki.value}
  <div class="w-full">
    <WikiEditor wiki={wiki.value} />
  </div>
{/if}
