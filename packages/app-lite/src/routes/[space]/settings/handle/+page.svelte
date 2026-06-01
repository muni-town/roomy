<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { auth, px } from "$lib/auth.svelte";
  import { CONFIG } from "$lib/config";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { sendEvents } from "$lib/mutations/send-events";
  import { createProfileSpaceRecord, removeProfileSpaceRecord, newUlid } from "@roomy-space/sdk";
  import { transport } from "@roomy-space/sdk";

  const { agentProcedure } = transport;
  import Alert from "@roomy/design/components/ui/alert/Alert.svelte";
  import Badge from "@roomy/design/components/ui/badge/Badge.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import Input from "@roomy/design/components/ui/input/Input.svelte";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";
  import InlineMono from "@roomy/design/components/helper/InlineMono.svelte";
  import { IconLoading } from "@roomy/design/icons";

  const spaceId = $derived(page.params.space!);
  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const meta = $derived(metaQuery.data);
  const currentSpaceHandle = $derived(meta?.handle ?? "");

  // Current profile space record — which space (if any) the user's handle is linked to
  let profileSpaceId = $state<string | null | undefined>(undefined); // undefined = loading, null = not found

  // Resolve the profile space record on mount
  $effect(() => {
    const agent = auth.agent;
    if (!agent) return;
    profileSpaceId = undefined;
    agent.com.atproto.repo
      .getRecord({
        collection: CONFIG.profileSpaceNsid,
        repo: agent.assertDid,
        rkey: "self",
      })
      .then((resp) => {
        const record = resp.data.value as { id?: string };
        profileSpaceId = record?.id ?? null;
      })
      .catch((err) => {
        if ((err as { error?: string }).error === "RecordNotFound") {
          profileSpaceId = null;
        } else {
          console.error("Failed to resolve profile space record", err);
          profileSpaceId = null;
        }
      });
  });

  const userHandle = $derived(auth.agent?.assertDid ?? "");
  const userDid = $derived(auth.agent?.assertDid ?? "");

  // Tab state
  const handleTabs = ["Use My Handle", "Use DNS"] as const;
  let activeTab: (typeof handleTabs)[number] = $state("Use My Handle");

  // DNS tab state
  let dnsHandle = $state(currentSpaceHandle);
  let handleResolvesToSpace = $state<boolean | undefined>(undefined);
  let isVerifyingHandle = $state(false);

  // Sync DNS handle input with current space handle
  $effect(() => {
    if (currentSpaceHandle) dnsHandle = currentSpaceHandle;
  });

  // Verify DNS handle resolves to this space
  $effect(() => {
    const handle = dnsHandle;
    if (!handle || handle.split(".").length < 2) {
      handleResolvesToSpace = undefined;
      return;
    }
    isVerifyingHandle = true;
    handleResolvesToSpace = undefined;
    fetch(
      `https://resolver.roomy.chat/xrpc/town.muni.leaf.resolveHandle?handle=${encodeURIComponent(handle)}`,
    )
      .then((r) => r.json())
      .then((data) => {
        handleResolvesToSpace = data.did === spaceId;
      })
      .catch(() => {
        handleResolvesToSpace = false;
      })
      .finally(() => {
        isVerifyingHandle = false;
      });
  });

  let isSaving = $state(false);
  let error = $state<string | null>(null);

  async function setHandleViaProfile() {
    const agent = auth.agent;
    if (!agent || !spaceId) return;
    isSaving = true;
    error = null;
    try {
      // Write PDS record linking user's profile to this space
      await createProfileSpaceRecord(agent, spaceId, {
        collection: CONFIG.profileSpaceNsid,
      });

      // Notify the space to use this user's handle
      await sendEvents(spaceId, [
        {
          $type: "space.roomy.space.setHandleProvider.v0",
          id: newUlid(),
          did: userDid,
        },
      ]);

      // Navigate to the handle-based URL (or space ID if handle doesn't resolve yet)
      goto(`/${spaceId}/settings/handle`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to set handle";
      console.error("setHandleViaProfile error", e);
    } finally {
      isSaving = false;
    }
  }

  async function removeHandleViaProfile() {
    const agent = auth.agent;
    if (!agent || !spaceId) return;
    isSaving = true;
    error = null;
    try {
      // Clear the handle provider for the space
      await sendEvents(spaceId, [
        {
          $type: "space.roomy.space.setHandleProvider.v0",
          id: newUlid(),
          did: null,
        },
      ]);

      // Remove the PDS record
      await removeProfileSpaceRecord(agent, {
        collection: CONFIG.profileSpaceNsid,
      });

      // Navigate back using space ID
      goto(`/${spaceId}/settings/handle`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to remove handle";
      console.error("removeHandleViaProfile error", e);
    } finally {
      isSaving = false;
    }
  }

  async function setHandleViaDns() {
    if (!dnsHandle || !spaceId) return;
    isSaving = true;
    error = null;
    try {
      await agentProcedure(px(), "space.roomy.space.setHandle", {
        spaceId,
        handle: dnsHandle,
      });

      goto(`/${dnsHandle}/settings/handle`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to set handle via DNS";
    } finally {
      isSaving = false;
    }
  }

  const isCurrentUserSpace = $derived(
    meta?.isAdmin ?? false,
  );
</script>

<div class="max-w-2xl">
  <h2 class="text-base font-semibold mb-4 flex items-center gap-3">
    Space Handle
    {#if currentSpaceHandle}
      <Badge variant="secondary">{currentSpaceHandle}</Badge>
    {:else}
      <Badge variant="red">Not Set</Badge>
    {/if}
  </h2>

  <p class="mb-3 text-sm text-base-700 dark:text-base-300">
    Setting a space handle allows your space to be accessed with a nicer URL
    such as:
  </p>

  <div class="font-bold my-3 font-mono text-sm text-base-900 dark:text-base-100">
    {page.url.host}/{currentSpaceHandle || spaceId}
  </div>

  <p class="mb-4 text-sm text-base-700 dark:text-base-300">
    A space admin can use their handle for the space, or you can configure a
    handle using DNS.
  </p>

  <!-- Tab switcher -->
  <div class="flex gap-1 mb-4 border-b border-base-200 dark:border-base-800">
    {#each handleTabs as tab}
      <button
        class="px-4 py-2 text-sm font-medium transition-colors
          {activeTab === tab
            ? 'text-accent-600 dark:text-accent-400 border-b-2 border-accent-500'
            : 'text-base-500 hover:text-base-700 dark:hover:text-base-300'}"
        onclick={() => (activeTab = tab)}
      >
        {tab}
      </button>
    {/each}
  </div>

  {#if error}
    <Alert type="error" class="mb-4">
      <div>{error}</div>
    </Alert>
  {/if}

  {#if activeTab === "Use My Handle"}
    {#if profileSpaceId === undefined}
      <div class="flex justify-center py-8">
        <LoadingSpinner size={32} />
      </div>
    {:else}
      <div class="flex flex-col gap-4">
        {#if spaceId === profileSpaceId}
          <Alert type="info">
            <div>
              Your ATProto handle <InlineMono>{userHandle}</InlineMono> is being
              used for this space.
            </div>
          </Alert>
        {:else if profileSpaceId}
          <Alert type="warning">
            <div>
              Your ATProto handle <InlineMono>{userHandle}</InlineMono> is being
              used for a
              <a
                href="/{profileSpaceId}/settings/handle"
                class="text-accent-500 underline"
              >different space</a>.
              Using your handle for this space will disconnect it from the other
              one.
            </div>
          </Alert>
        {:else}
          <Alert type="info">
            <div>
              Your ATProto handle <InlineMono>@{userHandle}</InlineMono> is not
              being used for any space.
            </div>
          </Alert>
        {/if}

        <div class="flex flex-col items-start gap-2">
          {#if spaceId !== profileSpaceId}
            <Button
              onclick={setHandleViaProfile}
              disabled={isSaving || !auth.agent}
            >
              {isSaving ? "Setting…" : "Use My Handle For This Space"}
            </Button>
          {:else}
            <Button
              onclick={removeHandleViaProfile}
              variant="secondary"
              disabled={isSaving || !auth.agent}
            >
              {isSaving ? "Removing…" : "Remove Your Handle From This Space"}
            </Button>
          {/if}
        </div>
      </div>
    {/if}

  {:else if activeTab === "Use DNS"}
    <div class="flex flex-col gap-4">
      <p class="text-sm text-base-700 dark:text-base-300">
        In order to set a space handle you must create a DNS TXT record for your
        domain:
      </p>

      {#if currentSpaceHandle || dnsHandle}
        <pre
          class="font-bold p-3 rounded-xl bg-base-100 dark:bg-base-900 font-mono text-xs text-base-900 dark:text-base-100 overflow-x-auto"
        >TXT    _leaf.{dnsHandle.split(".").slice(0, -1).join(".")}    "did={spaceId}"</pre>
      {/if}

      <Input bind:value={dnsHandle} placeholder="example.com" class="w-full" />

      <div class="flex items-center justify-end gap-3">
        {#if dnsHandle && dnsHandle.split(".").length >= 2}
          {#if isVerifyingHandle}
            <span class="flex items-center gap-1 text-sm text-base-500">
              <IconLoading class="animate-spin size-4" />
              Verifying…
            </span>
          {:else if handleResolvesToSpace === true}
            <span class="text-sm text-green-600">Verified</span>
          {:else if handleResolvesToSpace === false}
            <span class="text-sm text-red-600">DNS Resolution Failed</span>
          {/if}
        {/if}

        <Button
          onclick={setHandleViaDns}
          disabled={isSaving || !dnsHandle}
        >
          {!dnsHandle && !!currentSpaceHandle
            ? "Remove Current Handle"
            : "Set Handle"}
        </Button>
      </div>
    </div>
  {/if}
</div>
