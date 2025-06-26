<script lang="ts">
  import { atproto } from "$lib/atproto.svelte";
  import { user } from "$lib/user.svelte";
  import { onMount } from "svelte";

  let error = $state("");

  onMount(async () => {
    await atproto.init();
    const searchParams = new URL(globalThis.location.href).searchParams;

    atproto.oauth
      .callback(searchParams)
      .then((result) => {
        user.session = result.session;

        window.location.href = localStorage.getItem("redirectAfterAuth") || "/";
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
