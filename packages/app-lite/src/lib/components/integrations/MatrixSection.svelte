<script lang="ts">
  import { schemas } from "@roomy-space/sdk";
  import { toast } from "@foxui/core";
  import Badge from "@roomy/design/components/ui/badge/Badge.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import InlineMono from "@roomy/design/components/helper/InlineMono.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import LoadingSpinner from "@roomy/design/components/helper/LoadingSpinner.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";
  import { IconLoading, IconPlus, IconTrash } from "@roomy/design/icons";
  import { MATRIX_BRIDGE_CONFIGURED } from "$lib/config";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import {
    createMatrixBridgeHealthQuery,
    createMatrixBridgesQuery,
    matrixAdminErrorCopy,
    type MatrixBridge,
    type MatrixBridgeKind,
    type MatrixPortalState,
  } from "$lib/queries/matrix-bridge";
  import {
    createMatrixBridge,
    deleteMatrixBridge,
    updateMatrixBridge,
  } from "$lib/mutations/matrix-bridge";

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;

  let { spaceId }: { spaceId: string } = $props();

  const KIND_OPTIONS: { label: string; value: string }[] = [
    { label: "Room", value: "room" },
    { label: "Space", value: "space" },
  ];

  const configured = MATRIX_BRIDGE_CONFIGURED;

  const healthQuery = createMatrixBridgeHealthQuery({ enabled: () => configured });
  const bridgesQuery = createMatrixBridgesQuery(() => spaceId, {
    enabled: () => configured,
  });
  const metaQuery = createSpaceMetadataQuery(() => spaceId, {
    enabled: () => configured,
  });

  /**
   * Every channel and thread in this space, in sidebar order, for the target
   * picker. A thread is marked with a leading arrow so it reads as belonging
   * to the channel above it — `<option>` collapses leading whitespace, so the
   * indent has to be a visible character.
   */
  const roomOptions = $derived.by(() => {
    const meta = metaQuery.data;
    const out: { id: string; label: string }[] = [];
    const addChannel = (channel: SidebarChannel) => {
      out.push({ id: channel.id, label: channel.name ?? channel.id });
      for (const thread of channel.activeThreads ?? []) {
        out.push({ id: thread.id, label: `↳ ${thread.name ?? thread.id}` });
      }
    };
    const categories = [...(meta?.sidebar.categories ?? [])].sort(
      (a, b) => a.position - b.position,
    );
    for (const category of categories) {
      for (const channel of category.channels) addChannel(channel);
    }
    for (const channel of meta?.sidebar.orphans ?? []) addChannel(channel);
    return out;
  });

  /**
   * Why this string cannot name a Matrix room or space, or null when it can.
   * A Matrix address is an alias (`#alias:server`) or a room id (`!opaque`,
   * optionally `!opaque:server`).
   */
  function matrixReferenceError(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed === "") return "Enter a Matrix room or space.";
    if (/\s/.test(trimmed)) return "A Matrix address can't contain spaces.";
    if (trimmed.startsWith("#"))
      return trimmed.slice(1).includes(":")
        ? null
        : "An alias needs a server, like #general:matrix.org.";
    if (trimmed.startsWith("!")) return null;
    return "Start with # for an alias or ! for a room id.";
  }

  let matrixId = $state("");
  let kind = $state<MatrixBridgeKind>("room");
  let targetRoomId = $state("");
  let autoBridge = $state(false);
  let referenceError = $state<string | null>(null);
  let targetError = $state<string | null>(null);
  let createError = $state<string | null>(null);
  let creating = $state(false);
  let removingId = $state<string | null>(null);
  let updatingId = $state<string | null>(null);

  async function onConnect() {
    // Each error belongs under the field that caused it.
    referenceError = matrixReferenceError(matrixId);
    targetError =
      kind === "room" && targetRoomId === ""
        ? "Choose the channel this Matrix room relays into."
        : null;
    if (referenceError !== null || targetError !== null) return;

    creating = true;
    createError = null;
    try {
      await createMatrixBridge({
        spaceId,
        matrixId: matrixId.trim(),
        kind,
        mode: "full",
        ...(kind === "room" ? { targetRoomId } : { autoBridge }),
      });
      toast.success("Matrix bridge created.");
      matrixId = "";
      targetRoomId = "";
      autoBridge = false;
    } catch (e) {
      createError = matrixAdminErrorCopy(e);
    } finally {
      creating = false;
    }
  }

  async function onRemove(bridge: MatrixBridge) {
    const label = bridge.name ?? bridge.matrixId;
    if (
      !confirm(
        `Remove the bridge to ${label}? Messages already relayed stay in both rooms, but new messages stop flowing.`,
      )
    )
      return;

    removingId = bridge.id;
    try {
      await deleteMatrixBridge(bridge.id);
      toast.success("Matrix bridge removed.");
    } catch (e) {
      toast.error(matrixAdminErrorCopy(e));
    } finally {
      removingId = null;
    }
  }

  async function onToggleAutoBridge(bridge: MatrixBridge, next: boolean) {
    updatingId = bridge.id;
    try {
      await updateMatrixBridge(bridge.id, { autoBridge: next });
      toast.success(
        next
          ? "Rooms added to this space later will be bridged."
          : "Only the rooms bridged now stay bridged.",
      );
    } catch (e) {
      toast.error(matrixAdminErrorCopy(e));
    } finally {
      updatingId = null;
    }
  }

  function portalStateVariant(
    state: MatrixPortalState,
  ): "green" | "yellow" | "orange" | "red" {
    switch (state) {
      case "syncing":
        return "green";
      case "backfilling":
        return "yellow";
      case "paused":
        return "orange";
      case "blocked":
        return "red";
    }
  }
</script>

{#if !configured}
  <p class="text-sm text-base-500 dark:text-base-400">
    The Matrix bridge is not configured for this build. Set
    <InlineMono>PUBLIC_MATRIX_BRIDGE_DIDS</InlineMono> and
    <InlineMono>PUBLIC_MATRIX_BRIDGE_URL</InlineMono> to enable it.
  </p>
{:else}
  <div class="flex flex-col gap-6">
    <!-- Relaying is reading: the one fact an admin has to weigh before
         connecting an encrypted room. -->
    <section
      class="rounded-lg border border-base-200 px-4 py-3 dark:border-base-800"
    >
      <h3 class="text-sm font-semibold text-base-900 dark:text-base-100">
        How the bridge reads messages
      </h3>
      <p class="mt-1 text-sm text-base-600 dark:text-base-400">
        The bridge reads every message in the rooms it relays, because relaying
        is copying it across. It joins encrypted rooms as a single bridge
        device, so those rooms gain one extra member holding the decryption
        keys. Messages sent before the bridge joined an encrypted room cannot
        be decrypted and stay unreadable to it.
      </p>
      {#if healthQuery.data}
        <p class="mt-2 text-xs text-base-500 dark:text-base-400">
          Connected to <InlineMono>{healthQuery.data.homeserver}</InlineMono>.
          {healthQuery.data.e2ee
            ? "Encryption is available."
            : "Encryption is not available on this bridge."}
        </p>
      {:else if healthQuery.isLoadingError}
        <p class="mt-2 text-xs text-base-500 dark:text-base-400">
          The bridge isn't answering right now, so new bridges can't be set up.
        </p>
      {/if}
    </section>

    {#if bridgesQuery.isPending}
      <p class="text-sm text-base-400">Loading bridges…</p>
    {:else if bridgesQuery.isLoadingError}
      <ErrorMessage message={matrixAdminErrorCopy(bridgesQuery.error)} />
    {:else if bridgesQuery.data && bridgesQuery.data.bridges.length === 0}
      <p class="text-sm text-base-500 dark:text-base-400">
        This space isn't bridged to Matrix yet.
      </p>
    {:else if bridgesQuery.data}
      <ul class="flex flex-col gap-3">
        {#each bridgesQuery.data.bridges as bridge (bridge.id)}
          <li
            class="rounded-lg border border-base-200 px-4 py-3 dark:border-base-800"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 flex flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2">
                  <InlineMono>{bridge.matrixId}</InlineMono>
                  <Badge>{bridge.kind}</Badge>
                  <Badge variant="secondary">{bridge.mode}</Badge>
                </div>
                {#if bridge.name}
                  <p class="truncate text-sm text-base-600 dark:text-base-400">
                    {bridge.name}
                  </p>
                {/if}
                {#if bridge.targetRoomId}
                  <p class="text-xs text-base-500 dark:text-base-400">
                    Relays into room <InlineMono>{bridge.targetRoomId}</InlineMono>
                  </p>
                {/if}
              </div>
              <Button
                size="icon"
                variant="ghost"
                disabled={removingId === bridge.id}
                onclick={() => onRemove(bridge)}
              >
                {#if removingId === bridge.id}
                  <IconLoading class="size-4 animate-spin" />
                {:else}
                  <IconTrash class="size-4" />
                {/if}
                <span class="sr-only">Remove bridge to {bridge.matrixId}</span>
              </Button>
            </div>

            {#if bridge.kind === "space"}
              <label class="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-accent-500"
                  checked={bridge.autoBridge}
                  disabled={updatingId === bridge.id}
                  onchange={(e) =>
                    onToggleAutoBridge(bridge, e.currentTarget.checked)}
                />
                <span>
                  <span class="text-base-900 dark:text-base-100">
                    Also bridge rooms created later
                  </span>
                  <span class="block text-xs text-base-500 dark:text-base-400">
                    Rooms added to this space after today are bridged as they
                    appear.
                  </span>
                </span>
              </label>
            {/if}

            {#if bridge.portals.length > 0}
              <ul
                class="mt-3 flex flex-col gap-2 border-t border-base-200 pt-3 dark:border-base-800"
              >
                {#each bridge.portals as portal (portal.matrixRoomId)}
                  <li class="flex items-start justify-between gap-4 text-sm">
                    <span class="min-w-0">
                      <InlineMono>{portal.matrixRoomId}</InlineMono>
                      <span class="mt-0.5 block text-xs text-base-500 dark:text-base-400">
                        into <InlineMono>{portal.roomyRoomId}</InlineMono> · depth
                        {portal.depth}
                      </span>
                      {#if portal.reason && (portal.state === "paused" || portal.state === "blocked")}
                        <span class="mt-0.5 block text-xs text-base-600 dark:text-base-400">
                          {portal.reason}
                        </span>
                      {/if}
                    </span>
                    <span class="flex shrink-0 items-center gap-2">
                      {#if portal.encrypted}
                        <Badge variant="secondary">encrypted</Badge>
                      {/if}
                      {#if portal.state === "syncing" || portal.state === "backfilling"}
                        <LoadingSpinner size={12} />
                      {/if}
                      <Badge variant={portalStateVariant(portal.state)}>
                        {portal.state}
                      </Badge>
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <form
      class="flex flex-col gap-5"
      onsubmit={(e) => {
        e.preventDefault();
        onConnect();
      }}
    >
      <div>
        <label
          for="matrix-reference"
          class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
        >
          Matrix room or space
        </label>
        <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
          Paste an alias like <InlineMono>#general:matrix.org</InlineMono>, or a
          room id starting with <InlineMono>!</InlineMono>.
        </p>
        <input
          id="matrix-reference"
          type="text"
          bind:value={matrixId}
          oninput={() => (referenceError = null)}
          spellcheck={false}
          autocomplete="off"
          placeholder="#general:matrix.org"
          class="mt-2 w-full rounded-2xl border-0 bg-base-100 px-3 py-1.5 text-sm font-medium text-base-900 ring-1 ring-base-300 ring-inset transition-colors placeholder:text-base-400 focus:bg-accent-400/5 focus:ring-2 focus:ring-accent-500 focus:outline-none dark:bg-base-800/50 dark:text-base-100 dark:ring-base-700 dark:focus:bg-accent-600/5"
        />
        {#if referenceError}
          <p class="mt-1 text-sm text-red-600 dark:text-red-400">
            {referenceError}
          </p>
        {/if}
      </div>

      <div>
        <span class="block text-sm/6 font-medium text-base-900 dark:text-base-100">
          Bridge it as
        </span>
        <div class="mt-2">
          <ToggleGroup
            name="matrix-kind"
            value={kind}
            options={KIND_OPTIONS}
            onchange={(value) => (kind = value as MatrixBridgeKind)}
          />
        </div>
        <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
          A space bridge relays every room in the Matrix space. A room bridge
          relays one Matrix room into one channel here.
        </p>
      </div>

      {#if kind === "room"}
        <div>
          <label
            for="matrix-target"
            class="block text-sm/6 font-medium text-base-900 dark:text-base-100"
          >
            Roomy channel
          </label>
          <p class="mt-1 text-sm/6 text-base-600 dark:text-base-400">
            The channel or thread this Matrix room relays into.
          </p>
          <select
            id="matrix-target"
            bind:value={targetRoomId}
            onchange={() => (targetError = null)}
            class="mt-2 w-full rounded-2xl border-0 bg-base-100 px-3 py-1.5 text-sm text-base-900 ring-1 ring-base-300 ring-inset focus:ring-2 focus:ring-accent-500 focus:outline-none dark:bg-base-800/50 dark:text-base-100 dark:ring-base-700"
          >
            <option value="" disabled>Choose a channel…</option>
            {#each roomOptions as room (room.id)}
              <option value={room.id}>{room.label}</option>
            {/each}
          </select>
          {#if targetError}
            <p class="mt-1 text-sm text-red-600 dark:text-red-400">
              {targetError}
            </p>
          {/if}
        </div>
      {:else}
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5 size-4 accent-accent-500"
            bind:checked={autoBridge}
          />
          <span>
            <span class="text-base-900 dark:text-base-100">
              Also bridge rooms created later
            </span>
            <span class="block text-xs text-base-500 dark:text-base-400">
              Applies the bridge to rooms added to that space later, not only
              the ones it has now.
            </span>
          </span>
        </label>
      {/if}

      {#if createError}
        <ErrorMessage message={createError} />
      {/if}

      <div class="flex justify-end">
        <Button type="submit" variant="primary" size="sm" disabled={creating}>
          {#if creating}
            <IconLoading class="size-4 animate-spin" />
          {:else}
            <IconPlus class="size-4" />
          {/if}
          Connect
        </Button>
      </div>
    </form>
  </div>
{/if}
