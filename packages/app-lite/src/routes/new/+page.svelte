<script lang="ts">
  import { onMount } from "svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import Alert from "@roomy/design/components/ui/alert/Alert.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import Textarea from "@roomy/design/components/ui/input/Textarea.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { createSpace } from "$lib/mutations/space";
  import { uploadFile } from "$lib/mutations/upload";
  import { goto } from "$app/navigation";

  let form = $state({
    spaceName: "",
    spaceDescription: "",
    avatarFile: null as File | null,
    allowPublicJoin: "yes" as string,
    allowMemberInvites: "no" as string,
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
        allowPublicJoin: form.allowPublicJoin === "yes",
        allowMemberInvites:
          form.allowPublicJoin === "no"
            ? form.allowMemberInvites === "yes"
            : undefined,
      });
      goto(`/${spaceId}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  onMount(() => {
    setNavbar(createSpaceNavbar);
    setSidebarContent(undefined);
    return () => {
      setNavbar(undefined);
      setSidebarContent(undefined);
    };
  });
</script>

<div class="h-full overflow-y-auto dark:bg-base-950 text-base-800 dark:text-base-200">
    
    <form
      class="px-4 flex flex-col gap-8 py-8 max-w-3xl mx-auto w-full"
      onsubmit={handleSubmit}
    >
        
        <div class="text-base-900 dark:text-base-100">
          <h2 class="text-3xl font-bold text-base-900 dark:text-base-100 mb-2">
            Create your space
          </h2>
          <p class="text-base-500 dark:text-base-400 font-light">
            Every space is composed of channels, pages and members.
          </p>
        </div>
    
        <div class="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-6">
          <div class="sm:col-span-4">
            <label
              for="name"
              class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
              >Name</label
            >
            <div class="mt-2">
              <Input
                id="name"
                placeholder="Poetry Club"
                bind:value={form.spaceName}
                class="w-full"
                autofocus
              />
            </div>
          </div>
    
          <div class="col-span-full">
            <label
              for="photo"
              class="block text-sm/6 font-medium text-base-900 dark:text-base-100">
              <div class="flex flex-row items-baseline gap-1">
                Avatar
                <span class="text-base-400 dark:text-base-500 font-light text-xs italic">(optional)</span>
              </div>
            </label>
            <div class="mt-2 flex items-center gap-x-4">
              <SpaceAvatar src={avatarUrl} size={64} />
    
              <input
                type="file"
                accept="image/*"
                class="hidden"
                id="photo"
                onchange={handleAvatarSelect}
                bind:this={fileInput}
              />
              <Button variant="secondary" onclick={() => fileInput?.click()}>
                Upload Avatar
              </Button>
            </div>
          </div>

          <div class="sm:col-span-full">
            <label
              for="username"
              class="block text-sm/6 font-medium text-base-900 dark:text-base-100">
              <div class="flex flex-row items-baseline gap-1">
                Description
                <span class="text-base-400 dark:text-base-500 font-light text-xs italic">(optional)</span>
              </div>
            </label>
            <div class="mt-2">
              <Textarea
                placeholder="A short description helps people know what your space is about."
                bind:value={form.spaceDescription}
                class="w-full"
                rows={5}
              />
            </div>
          </div>

          <div class="col-span-full flex flex-col gap-6">
            <div>
              <p
                class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1"
              >
                Who can join this space?
              </p>
              <ToggleGroup
                name="allowPublicJoin"
                bind:value={form.allowPublicJoin}
                options={[
                  { label: "Anyone", value: "yes" },
                  { label: "Invite only", value: "no" },
                ]}
              />
            </div>

            {#if form.allowPublicJoin === "no"}
              <div>
                <p
                  class="block text-sm/6 font-medium text-base-900 dark:text-base-100 mb-1"
                >
                  Who can create invite links?
                </p>
                <ToggleGroup
                  name="allowMemberInvites"
                  bind:value={form.allowMemberInvites}
                  options={[
                    { label: "Any member", value: "yes" },
                    { label: "Admins only", value: "no" },
                  ]}
                />
              </div>
            {/if}
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
            Creating…
          {:else}
            Create Space
          {/if}
        </Button>
      </div>
      </form>
      
  </div>

{#snippet createSpaceNavbar()}
  <div class="flex w-full items-center gap-3">
    <Button variant="secondary" href="/">← Back</Button>
  </div>
{/snippet}
