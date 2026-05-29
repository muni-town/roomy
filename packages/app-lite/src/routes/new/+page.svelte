<script lang="ts">
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import Alert from "@roomy/design/components/ui/alert/Alert.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import ThinSidebar from "$lib/components/sidebar/ThinSidebar.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { createSpace } from "$lib/mutations/space";
  import { uploadFile } from "$lib/mutations/upload";
  import { goto } from "$app/navigation";
  import { IconXMark } from "@roomy/design/icons";

  let form = $state({
    spaceName: "",
    spaceDescription: "",
    avatarFile: null as File | null,
    dismissAlert: false,
  });

  let avatarUrl = $derived(
    form.avatarFile ? URL.createObjectURL(form.avatarFile) : undefined,
  );

  let creating = $state(false);
  let error = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  function handleAvatarSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      form.avatarFile = input.files[0] ?? null;
    }
  }

  async function handleSubmit(evt: Event) {
    evt.preventDefault();
    if (!form.spaceName || creating) return;
    creating = true;
    error = null;
    try {
      let avatar: string | undefined;
      if (form.avatarFile) {
        const { uri } = await uploadFile(form.avatarFile);
        avatar = uri;
      }
      const { spaceId } = await createSpace({
        name: form.spaceName,
        description: form.spaceDescription || undefined,
        avatar,
      });
      goto(`/${spaceId}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  $effect(() => {
    setNavbar(createSpaceNavbar);
    return () => setNavbar(undefined);
  });
</script>

<MainLayout>
  {#snippet serverBar()}
    <ThinSidebar />
  {/snippet}
  <div class="h-full overflow-y-auto">
    <form
      class="px-4 flex flex-col gap-8 py-8 max-w-3xl mx-auto w-full"
      onsubmit={handleSubmit}
    >
      <div class="space-y-8">
        <h2
          class="text-base/7 font-semibold text-base-900 dark:text-base-100"
        >
          Create a new space
        </h2>

        {#if !form.dismissAlert}
          <Alert type="info" class="text-sm flex items-start gap-2">
            <div class="space-y-2 grow">
              <p>
                Spaces are a way to organize related rooms, pages, and members.
                You can think of them as communities or groups within the
                platform.
              </p>
              <p>
                <strong>We currently only support public spaces</strong>,
                meaning anyone can find and join them.
              </p>
            </div>
            <div>
              <Button
                class="hover:bg-sky-400/30 hover:text-black p-1.5"
                type="button"
                variant="ghost"
                onclick={() => (form.dismissAlert = true)}
              >
                <IconXMark />
              </Button>
            </div>
          </Alert>
        {/if}

        <div class="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6">
          <div class="sm:col-span-4">
            <label
              for="name"
              class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
              >Name</label
            >
            <div class="mt-2">
              <Input id="name" bind:value={form.spaceName} class="w-full" />
            </div>
          </div>

          <div class="col-span-full">
            <label
              for="photo"
              class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
              >Avatar (optional)</label
            >
            <div class="mt-2 flex items-center gap-x-3">
              <SpaceAvatar src={avatarUrl} size={64} />
              <input
                type="file"
                accept="image/*"
                class="hidden"
                id="photo"
                onchange={handleAvatarSelect}
                bind:this={fileInput}
              />
              <Button
                variant="secondary"
                type="button"
                onclick={() => fileInput?.click()}
              >
                Upload Avatar
              </Button>
            </div>
          </div>

          <div class="sm:col-span-full">
            <label
              for="description"
              class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
              >Description (optional)</label
            >
            <div class="mt-2">
              <textarea
                id="description"
                bind:value={form.spaceDescription}
                class="w-full rounded-2xl text-sm font-medium transition-all duration-300 focus:ring-2 ring-1 ring-inset border-0 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 placeholder:text-accent-700/50 dark:placeholder:text-accent-400/50 ring-accent-500/30 dark:ring-accent-500/20 focus:ring-accent-500 dark:focus:ring-accent-500 px-3 py-1.5 text-base focus:transition-transform active:duration-100"
                rows={4}
              ></textarea>
            </div>
          </div>
        </div>
      </div>

      {#if error}
        <Alert type="error" class="text-sm">
          <p>{error}</p>
        </Alert>
      {/if}

      <div class="mt-6 flex items-center justify-end gap-x-6">
        <Button
          type="submit"
          disabled={!form.spaceName || creating}
        >
          {#if creating}
            Creating...
          {:else}
            Create Space
          {/if}
        </Button>
      </div>
    </form>
  </div>
</MainLayout>

{#snippet createSpaceNavbar()}
  <div class="flex w-full items-center gap-3">
    <Button variant="secondary" href="/">← Back</Button>
  </div>
{/snippet}
