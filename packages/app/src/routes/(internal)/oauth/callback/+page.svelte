<script lang="ts">
  import { backend } from "$lib/workers";
  import { onMount } from "svelte";

  let error = $state("");

  onMount(async () => {
    const searchParams = new URL(globalThis.location.href).searchParams;

    backend
      .oauthCallback(searchParams.toString())
      .then(() => {
        // TODO remember location to redirect back to.
        window.location.href = "/";
        localStorage.setItem("just-logged-in", "1");
      })
      .catch((e) => {
        error = e.toString();
      });
  });
</script>

{#if error}
  <p class="text-base-900 dark:text-base-100">
    Error logging in: {error}.
  </p>
  <p class="text-base-900 dark:text-base-100">
    <a href="/">Go Home</a>
  </p>
{/if}
