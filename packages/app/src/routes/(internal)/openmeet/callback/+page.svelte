<script lang="ts">
  import { goto } from "$app/navigation";
  import { storeTokens, getAndClearReturnUrl } from "$lib/services/openmeet";
  import { Alert, Button } from "@fuxui/base";
  import { onMount } from "svelte";
  import { IconLoading } from "@roomy/design/icons";

  let error = $state("");

  onMount(() => {
    try {
      const params = new URL(globalThis.location.href).searchParams;
      const token = params.get("token");
      const refreshToken = params.get("refreshToken");
      const tokenExpires = params.get("tokenExpires");
      const profile = params.get("profile");

      if (!token || !refreshToken || !tokenExpires) {
        error = "Missing authentication parameters from OpenMeet";
        return;
      }

      storeTokens({ token, refreshToken, tokenExpires, profile: profile ?? undefined });

      const returnUrl = getAndClearReturnUrl();
      goto(returnUrl || "/home");
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<div
  class="flex h-screen w-screen justify-center items-center fixed top-0 left-0 bg-base-50 dark:bg-base-950 z-50"
>
  {#if error}
    <Alert class="text-lg w-auto flex flex-col items-center gap-2">
      <p class="text-base-900 dark:text-base-100">
        Error connecting to OpenMeet: {error}
      </p>
      <Button href="/">Go Home</Button>
    </Alert>
  {:else}
    <IconLoading font-size="8em" class="animate-spin text-primary" />
  {/if}
</div>
