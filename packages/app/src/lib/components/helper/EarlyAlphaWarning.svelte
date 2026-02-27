<script lang="ts">
  import { Alert } from "$lib/components/ui/alert";
  // import { onMount } from "svelte";

  let showAlphaWarning = $state(true);
  // onMount(() => {
  //   showAlphaWarning = localStorage.getItem("showAlphaWarning") !== "false";
  // });
</script>

{#if showAlphaWarning}
  <div class="p-2">
    <Alert type="warning" class=" max-w-2xl mx-auto bg-amber-100/30">
      <div class="prose text-sm">
        <p>
          Roomy is in an unstable, early "Alpha" state. This means that it is a
          work-in-progress and is under heavy development. Many things may not
          work as expected and, though we do have backups as a precaution, <strong
            class="font-medium dark:text-white"
            >data might not be preserved</strong
          >.
        </p>
        <p>
          If you would like to try Roomy as an early adopter reach out to us on <a
            class="text-blue-400"
            href="https://discord.gg/BkEpMzzh38">Discord</a
          >
          or
          <a class="text-blue-400" href="https://bsky.app/profile/roomy.space"
            >Bluesky</a
          > and we can consider helping you specifically to maintain your data across
          updates to Roomy, until it becomes stable.
        </p>
      </div>

      <span class="flex flex-row-reverse grow">
        <!-- <Button
            size="sm"
            variant="amber"
            onclick={() => {
              showAlphaWarning = false;
              localStorage.setItem("showAlphaWarning", "false");
            }}>Dismiss</Button
          > -->
      </span>
    </Alert>
  </div>
{/if}
