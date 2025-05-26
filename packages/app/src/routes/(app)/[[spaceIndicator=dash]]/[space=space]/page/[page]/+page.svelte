<script lang="ts">
  import { page } from "$app/state";
  import PageEditor from "$lib/components/PageEditor.svelte";
  import { globalState } from "$lib/global.svelte";
  import { derivePromise } from "$lib/utils.svelte";
  import { WikiPage } from "$lib/schema";


</script>

<div class="w-full h-full flex flex-col">
  <PageEditor  />
</div>
