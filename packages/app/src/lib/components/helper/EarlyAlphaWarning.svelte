<script lang="ts">
  import { Alert, Button } from "@fuxui/base";
  import { onMount } from "svelte";

  let showAlphaWarning = $state(false);
  onMount(() => {
    showAlphaWarning = localStorage.getItem("showAlphaWarning") !== "false";
  });
</script>

{#if showAlphaWarning}
  <div class="p-2">
    <Alert type="warning" class="text-sm max-w-2xl mx-auto bg-amber-100/30">
      <span class="flex items-center gap-2 text-amber-800 dark:text-amber-200"
        >Roomy is in an early "Alpha" state. This means that it is a
        work-in-progress and is under heavy development. Many things may not
        work as expected and data is preserved on a best-effort basis for the
        time being.
        <span class="flex flex-row-reverse grow">
          <Button
            size="sm"
            variant="amber"
            onclick={() => {
              showAlphaWarning = false;
              localStorage.setItem("showAlphaWarning", "false");
            }}>Dismiss</Button
          >
        </span>
      </span>
    </Alert>
  </div>
{/if}
