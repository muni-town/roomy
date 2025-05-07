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
  <p>
    Error logging in: {error}.
  </p>
  <p>
    <a href="/">Go Home</a>
  </p>
{/if}
