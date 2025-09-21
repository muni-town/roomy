<script lang="ts">
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { backend } from "$lib/workers";
  import { Textarea, Button, ScrollArea } from "@fuxui/base";

  let query = $state(
    localStorage.getItem("roomy-debug-query") ||
      "select format_hash(id), name, avatar, description\nfrom spaces;",
  );
  $effect(() => {
    localStorage.setItem("roomy-debug-query", query);
  });
  let queryResult = $state(undefined) as unknown;

  async function runQuery() {
    try {
      queryResult = await backend.runQuery(query);
    } catch (e: any) {
      queryResult = e.toString();
    }
  }
</script>

<MainLayout>
  {#snippet navbar()}
    <div class="flex items-center justify-center w-full">
      <h1 class="font-bold text-xl">SQL Query</h1>
    </div>
  {/snippet}

  <div class="flex flex-col mt-8 max-h-full min-h-0">
    <div class="mx-auto max-w-full p-3">
      <form onsubmit={runQuery}>
        <Textarea bind:value={query} class="w-[30em] max-w-full resize" rows={5}
        ></Textarea>
        <div class="flex w-full justify-end">
          <Button type="submit">Run Query</Button>
        </div>
      </form>
    </div>
    <ScrollArea>
      <pre class="grow overflow-y-auto">{typeof queryResult == "object"
          ? JSON.stringify(queryResult, undefined, "  ")
          : queryResult}</pre>
    </ScrollArea>
  </div>
</MainLayout>
