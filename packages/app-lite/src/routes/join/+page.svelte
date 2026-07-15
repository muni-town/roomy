<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import JoinDialog from "@roomy/design/components/modals/JoinDialog.svelte";
  import type {
    JoinResolveState,
    JoinState,
  } from "@roomy/design/components/modals/JoinDialog.svelte";
  import type { RhythmLevel } from "@roomy/design/components/user/UpdateRhythmChooser.svelte";
  import { cache } from "@roomy-space/sdk";
  import { auth, px } from "$lib/auth.svelte";
  import { queryClient } from "$lib/client";
  import { joinSpace } from "$lib/mutations/space";
  import { setSpacePushLevel } from "$lib/mutations/push-preferences";

  const { queryKey } = cache;

  const spaceId = $derived(page.url.searchParams.get("space") ?? "");
  const inviteToken = $derived(page.url.searchParams.get("invite") ?? undefined);

  let resolveState = $state<JoinResolveState>({ status: "loading" });
  let joinState = $state<JoinState>({ status: "idle" });

  // Translate a raw joinSpace XRPC error into something the user can act on.
  // The thrown error's message looks like
  //   "XRPC space.roomy.space.joinSpace failed (403): <server message>"
  // which is opaque (and gets ellipsis-truncated by the UI), so map the
  // known server messages to plain-English guidance and log the full error
  // for debugging.
  function joinErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number } | null)?.status;
    if (raw.includes("Invalid invite token")) {
      return "This invite link is no longer valid or has been revoked.";
    }
    if (raw.includes("requires an invite token to join")) {
      return "This space is invite-only. You need an invite link to join.";
    }
    if (raw.includes("banned from this space")) {
      return "You are banned from this space.";
    }
    if (status !== undefined && status >= 500) {
      return "Something went wrong on the server. Please try again.";
    }
    return raw;
  }

  $effect(() => {
    if (!spaceId) {
      resolveState = { status: "error", message: "Missing space ID in URL." };
      return;
    }
    // Wait for the OAuth session to be restored before fetching metadata.
    // px() throws "Not authenticated" until the session is ready; unlike the
    // reactive createQuery used on space pages, this one-shot fetchQuery
    // would otherwise surface that as a permanent "Something went wrong"
    // modal. Reading `auth.authenticated` re-runs this effect once auth
    // completes, so the metadata fetch is retried at the right time.
    if (!auth.authenticated) return;
    resolveState = { status: "loading" };
    queryClient
      .fetchQuery({
        queryKey: queryKey("space.roomy.space.getMetadata", { spaceId }),
        queryFn: () => px().query("space.roomy.space.getMetadata", { spaceId }),
      })
      .then((meta) => {
        if (meta.isMember) {
          goto(`/${spaceId}`);
          return;
        }
        resolveState = {
          status: "success",
          data: {
            name: meta.name ?? spaceId,
            allowPublicJoin: meta.joinPolicy.allowPublicJoin,
          },
        };
      })
      .catch((err: unknown) => {
        resolveState = {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      });
  });

  async function onJoin(level: RhythmLevel) {
    if (!spaceId) return;
    joinState = { status: "loading" };
    try {
      await joinSpace(spaceId, inviteToken);
      // Invalidate cached queries for this space so stale pre-join responses
      // (e.g. getMetadata with isMember=false, room metadata canWrite=false)
      // are cleared before we navigate into the space. The appserver also
      // emits invalidation signals over WebSocket, but those race with the
      // immediate navigation below; doing it eagerly avoids a flash of the
      // "you need an invite" modal for a user who just accepted an invite.
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const nsid = query.queryKey[0];
          if (typeof nsid !== "string") return false;
          const params = query.queryKey[1];
          if (
            params != null &&
            typeof params === "object" &&
            !Array.isArray(params) &&
            (params as Record<string, unknown>).spaceId === spaceId
          ) {
            return true;
          }
          // Room-scoped queries key on roomId, not spaceId — match by NSID
          // prefix so stale canWrite=false / no-read-access errors clear.
          if (nsid.startsWith("space.roomy.room.")) return true;
          return false;
        },
      });
      // Persist the chosen notification rhythm for this space. Best-effort: a
      // failure here must not block the join — the level just defaults to the
      // appserver default ("engaged") until the user changes it in settings.
      try {
        await setSpacePushLevel(spaceId, level);
        await queryClient.invalidateQueries({
          queryKey: cache.queryKey("space.roomy.push.getPreferences"),
        });
      } catch (err) {
        console.warn("[join] could not save notification rhythm:", err);
      }
      joinState = { status: "success" };
      goto(`/${spaceId}`);
    } catch (err) {
      console.error("[join] joinSpace failed", err);
      joinState = {
        status: "error",
        message: joinErrorMessage(err),
      };
    }
  }
</script>

<JoinDialog {resolveState} {joinState} {inviteToken} {onJoin}>
  {#snippet avatar()}
    <div class="w-10 h-10 rounded-full bg-base-200 dark:bg-base-700"></div>
  {/snippet}
</JoinDialog>
