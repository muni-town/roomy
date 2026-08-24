<script lang="ts">
  import { page } from "$app/state";
  import { queryClient } from "$lib/client";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import {
    createFederationRequestsQuery,
    createFederationOutgoingQuery,
    createFederationIncomingQuery,
    createFederationGrantsQuery,
  } from "$lib/queries/federation";
  import {
    requestFederation,
    respondFederation,
    removeFederation,
    setRoomPermission,
  } from "$lib/mutations/federation";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";
  import Textarea from "@roomy/design/components/ui/input/Textarea.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import {
    IconLoading,
    IconShare,
    IconCheck,
    IconX,
    IconSend,
  } from "@roomy/design/icons";

  const spaceId = $derived(page.params.space!);

  const flagsQuery = createFeatureFlagsQuery();
  const federationEnabled = $derived(
    flagsQuery.data?.flags.includes("channel-federation") ?? false,
  );

  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const isAdmin = $derived(metaQuery.data?.isAdmin ?? false);

  const requestsQuery = createFederationRequestsQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const outgoingQuery = createFederationOutgoingQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const incomingQuery = createFederationIncomingQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const grantsQuery = createFederationGrantsQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const spacesQuery = createSpacesQuery();

  // Own channels of this space (excludes federated channels shown in orphans).
  const ownChannels = $derived.by(() => {
    const meta = metaQuery.data;
    const out: { id: string; name: string }[] = [];
    for (const cat of meta?.sidebar.categories ?? []) {
      for (const ch of cat.channels ?? []) out.push({ id: ch.id, name: ch.name ?? ch.id });
    }
    for (const ch of meta?.sidebar.orphans ?? []) {
      if (!ch.federated) out.push({ id: ch.id, name: ch.name ?? ch.id });
    }
    return out;
  });

  function originGrantOf(b: string, roomId: string): string {
    const g = grantsQuery.data?.originGrants?.find(
      (x) => x.federatingSpaceDid === b && x.roomId === roomId,
    );
    return g?.permission ?? "none";
  }

  let busy = $state<string | null>(null);
  const isBusy = (key: string) => busy === key;

  const GRANT_OPTIONS = [
    { label: "Off", value: "none" },
    { label: "Read", value: "read" },
    { label: "Read + write", value: "readwrite" },
  ];

  async function refresh() {
    for (const nsid of [
      "space.roomy.federation.getGrants",
      "space.roomy.federation.getRequests",
      "space.roomy.federation.getIncoming",
      "space.roomy.federation.getOutgoing",
    ]) {
      await queryClient.invalidateQueries({ queryKey: [nsid] });
    }
    await queryClient.invalidateQueries({ queryKey: ["space.roomy.space.getMetadata"] });
  }

  async function onRespond(b: string, approve: boolean) {
    busy = `respond:${b}`;
    try {
      await respondFederation(spaceId, { federatingSpaceDid: b, approve });
      await refresh();
    } finally {
      busy = null;
    }
  }
  async function onRemove(b: string) {
    if (!confirm(`Remove the federation with ${b}? All shared channel access will be revoked.`)) return;
    busy = `remove:${b}`;
    try {
      await removeFederation(spaceId, b);
      await refresh();
    } finally {
      busy = null;
    }
  }
  async function onOriginGrant(b: string, roomId: string, permission: string) {
    busy = `og:${b}:${roomId}`;
    try {
      await setRoomPermission(spaceId, {
        federatingSpaceDid: b,
        roomId,
        permission: permission === "none" ? null : (permission as "read" | "readwrite"),
      });
      await refresh();
    } finally {
      busy = null;
    }
  }

  const pending = $derived(requestsQuery.data?.requests ?? []);
  const outgoingActive = $derived(
    (outgoingQuery.data?.federations ?? []).filter((f) => f.status === "active"),
  );
  const incomingAll = $derived(incomingQuery.data?.federations ?? []);
  // Non-active relationships from this space's perspective (B): pending
  // requests awaiting the origin's decision, plus rejected/removed history.
  const incomingStatusRows = $derived(
    incomingAll.filter((f) => f.status !== "active"),
  );

  // Spaces the user is a member of that could federate channels into this
  // space (B). Excludes this space itself and any origin with an existing
  // relationship (pending/active/rejected block a re-request; removed is
  // allowed as the recovery path).
  const mySpaces = $derived(
    (spacesQuery.data?.spaces ?? []).filter((s) => s.isMember && s.id !== spaceId),
  );
  const blockedOrigins = $derived(
    new Set(
      incomingAll
        .filter((f) => f.status !== "removed")
        .map((f) => f.originSpaceDid),
    ),
  );
  const requestableSpaces = $derived(
    mySpaces.filter((s) => !blockedOrigins.has(s.id)),
  );

  let requestTarget = $state("");
  let requestMessage = $state("");
  let requestError = $state<string | null>(null);
  let requestBusy = $state(false);

  function statusLabel(status: string): string {
    switch (status) {
      case "pending":
        return "Request pending approval";
      case "rejected":
        return "Request rejected";
      case "removed":
        return "Federation removed";
      default:
        return status;
    }
  }

  function spaceLabel(name: string | undefined, did: string): string {
    return name ?? did;
  }

  function requesterLabel(req: {
    requestedByName?: string;
    requestedByHandle?: string;
    requestedByDid: string;
  }): string {
    return req.requestedByName ?? req.requestedByHandle ?? req.requestedByDid;
  }

  async function onRequest() {
    if (!requestTarget || requestBusy) return;
    requestBusy = true;
    requestError = null;
    try {
      // Sent on the origin space's (A) stream: an admin of this space (B)
      // asks A to federate B in.
      await requestFederation(requestTarget, {
        federatingSpaceDid: spaceId,
        ...(requestMessage.trim() ? { message: requestMessage.trim() } : {}),
      });
      requestTarget = "";
      requestMessage = "";
      await refresh();
    } catch (e) {
      requestError = e instanceof Error ? e.message : "Failed to send federation request";
    } finally {
      requestBusy = false;
    }
  }
</script>

{#if !federationEnabled}
  <div class="py-12 text-center text-sm text-base-500 dark:text-base-400">
    Channel federation is not enabled on this space yet.
  </div>
{:else if !isAdmin}
  <div class="py-12 text-center text-sm text-base-500 dark:text-base-400">
    Only space admins can manage federations.
  </div>
{:else}
  <div class="space-y-10 max-w-2xl">
    <!-- Request federation: as an admin of this space (B), ask an origin
         space (A) you're a member of to share channels with B. -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold text-base-900 dark:text-base-100">
        Request federation
      </h2>
      <p class="text-sm text-base-400">
        Ask a space you're a member of to share channels with this space. An
        admin of that space has to approve the request.
      </p>
      <p class="text-sm text-base-400">
        These 'federated' channels will then show up in this space's sidebar.
      </p>
      {#if requestableSpaces.length === 0}
        <p class="text-sm text-base-400">
          No spaces available to request from. You need to be a member of the
          space you want to federate with.
        </p>
      {:else}
        <div class="flex flex-col gap-2">
          <select
            bind:value={requestTarget}
            class="rounded-md text-sm border-1 font-light focus-visible:outline-0 bg-neutral-300/50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-100 border-neutral-400/50 dark:border-neutral-700 px-3.5 py-1.5"
          >
            <option value="" disabled>Select a space…</option>
            {#each requestableSpaces as s (s.id)}
              <option value={s.id}>{s.name ?? s.id}</option>
            {/each}
          </select>
          <Textarea
            bind:value={requestMessage}
            sizeVariant="sm"
            placeholder="Message to the other space's admins (optional)"
          />
          {#if requestError}
            <ErrorMessage message={requestError} class="py-1" />
          {/if}
          <div class="flex justify-end">
            <Button
              size="sm"
              disabled={!requestTarget || requestBusy}
              onclick={onRequest}
            >
              {#if requestBusy}
                <IconLoading class="size-4 animate-spin" />
              {:else}
                <IconSend class="size-4" />
              {/if}
              Send request
            </Button>
          </div>
        </div>
      {/if}
    </section>

    <!-- Request status: relationships from this space's (B) perspective that
         aren't active yet (pending / rejected / removed). -->
    {#if incomingStatusRows.length > 0}
      <section class="space-y-3">
        <h2 class="text-base font-semibold text-base-900 dark:text-base-100">
          Request status
        </h2>
        <ul class="flex flex-col gap-2">
          {#each incomingStatusRows as f (f.originSpaceDid)}
            <li class="rounded-2xl border border-base-200 dark:border-base-800 p-3 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <div class="text-sm font-medium text-base-900 dark:text-base-100 truncate">
                  {spaceLabel(f.originSpaceName, f.originSpaceDid)}
                </div>
                <p class="text-xs text-base-400">
                  {statusLabel(f.status)}
                  {#if f.status === "pending"}
                    · requested {new Date(f.requestedAt).toLocaleString()}
                  {:else if f.decidedAt}
                    · decided {new Date(f.decidedAt).toLocaleString()}
                  {/if}
                </p>
              </div>
              {#if f.status === "removed"}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={requestBusy}
                  onclick={() => {
                    requestTarget = f.originSpaceDid;
                    requestMessage = "";
                    requestError = null;
                  }}
                >
                  Re-request
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Pending requests -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold text-base-900 dark:text-base-100">
        Pending requests
      </h2>
      {#if requestsQuery.isPending && pending.length === 0}
        <IconLoading class="animate-spin" />
      {:else if pending.length === 0}
        <p class="text-sm text-base-400">No pending federation requests.</p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each pending as req (req.federatingSpaceDid)}
            <li class="rounded-2xl border border-base-200 dark:border-base-800 p-3 flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <IconShare class="size-4 shrink-0 text-accent-500" />
                <span class="text-sm font-medium text-base-900 dark:text-base-100 truncate">
                  {spaceLabel(req.federatingSpaceName, req.federatingSpaceDid)}
                </span>
              </div>
              <p class="text-xs text-base-400">
                Requested {new Date(req.requestedAt).toLocaleString()} by {requesterLabel(req)}
                {#if req.message}<br />“{req.message}”{/if}
              </p>
              <div class="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isBusy(`respond:${req.federatingSpaceDid}`)}
                  onclick={() => onRespond(req.federatingSpaceDid, false)}
                >
                  <IconX class="size-4" /> Reject
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isBusy(`respond:${req.federatingSpaceDid}`)}
                  onclick={() => onRespond(req.federatingSpaceDid, true)}
                >
                  <IconCheck class="size-4" /> Approve
                </Button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Outgoing: channels this space shares with other spaces -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold text-base-900 dark:text-base-100">
        Shared channels
      </h2>
      {#if outgoingActive.length === 0}
        <p class="text-sm text-base-400">
          No active federations. Approve a pending request above to begin sharing channels.
        </p>
      {:else}
        <ul class="flex flex-col gap-3">
          {#each outgoingActive as f (f.federatingSpaceDid)}
            <li class="rounded-2xl border border-base-200 dark:border-base-800 p-3">
              <div class="flex items-center justify-between gap-2 mb-2">
                <span class="text-sm font-semibold text-base-900 dark:text-base-100 truncate">
                  {spaceLabel(f.federatingSpaceName, f.federatingSpaceDid)}
                </span>
                <Button variant="ghost" size="sm" class="text-red-600" disabled={isBusy(`remove:${f.federatingSpaceDid}`)} onclick={() => onRemove(f.federatingSpaceDid)}>
                  Remove
                </Button>
              </div>
              <div class="flex flex-col gap-2">
                {#each ownChannels as ch}
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-sm text-base-700 dark:text-base-300 truncate">{ch.name}</span>
                    <ToggleGroup
                      name={`og:${f.federatingSpaceDid}:${ch.id}`}
                      value={originGrantOf(f.federatingSpaceDid, ch.id)}
                      options={GRANT_OPTIONS}
                      onchange={(v) => onOriginGrant(f.federatingSpaceDid, ch.id, v)}
                    />
                  </div>
                {/each}
                {#if ownChannels.length === 0}
                  <p class="text-sm text-base-400">No channels to share.</p>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

  </div>
{/if}
