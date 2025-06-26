<script lang="ts">
  import { page } from "$app/state";
  import { spaceMigrationReferenceId, SpaceMigrationReference } from "@roomy-chat/sdk";
  import { user } from "$lib/user.svelte";
  import { Button } from "bits-ui";
  import { CoState } from "jazz-svelte";

  let spaceMigrationReference = $derived(
    new CoState(SpaceMigrationReference, spaceMigrationReferenceId, {
      resolve: {
        $each: true,
        $onError: null,
      },
    }),
  );

  $inspect(page.params.id);
  $inspect(spaceMigrationReference.current?.toJSON());
  $inspect(spaceMigrationReference.current?.[page.params.id ?? ""]);
  let loading = $derived(!spaceMigrationReference.current);
  let moved = $derived(spaceMigrationReference.current?.[page.params.id ?? ""]);
</script>

<div class="dz-hero bg-base-200 min-h-screen overflow-y-scroll">
  <div class="dz-hero-content max-w-2xl">
    <div class="flex flex-col gap-8 items-center">
      {#if loading}
        <span class="dz-loading dz-loading-spinner mx-auto w-25"></span>
      {:else}
        <h1 class="text-5xl font-bold text-center">
          {#if moved}
            This space has been moved!
          {:else}
            This space is still using the old roomy version.
          {/if}
        </h1>
        <p class="text-lg font-medium max-w-2xl text-center">
          {#if moved}
            It now lives in the new version of Roomy.
          {:else}
            Please tell the space owner to migrate to the new version, by
            visiting the old version and exporting the space in the space
            settings, then importing it here.
          {/if}
        </p>
        <div class="flex gap-8 flex-col">
          {#if moved}
            <Button.Root
              href={`/${moved}`}
              class="dz-btn dz-btn-primary dz-btn-lg"
            >
              Go to new space!
            </Button.Root>
          {:else}
            <Button.Root
              target="_blank"
              href={`https://alpha2.roomy.chat/${page.params.id}`}
              class="dz-btn dz-btn-primary dz-btn-lg"
            >
              Go to old space version!
            </Button.Root>
          {/if}

          {#if user.session && !moved}
            <Button.Root href="/import-space" target="_blank" class="dz-btn dz-btn-outline"
              >Import space</Button.Root
            >
          {:else if !moved}
            <Button.Root
              onclick={() => (user.isLoginDialogOpen = true)}
              class="dz-btn dz-btn-outline"
            >
              Sign in to import space
            </Button.Root>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
