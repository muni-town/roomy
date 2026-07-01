<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import JoinDialog from "@roomy/design/components/modals/JoinDialog.svelte";
  import type {
    JoinResolveState,
    JoinState,
  } from "@roomy/design/components/modals/JoinDialog.svelte";
  import { cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import { queryClient } from "$lib/client";
  import { joinSpace } from "$lib/mutations/space";

  const { queryKey } = cache;

  const spaceId = $derived(page.url.searchParams.get("space") ?? "");
  const inviteToken = $derived(page.url.searchParams.get("invite") ?? undefined);

  let resolveState = $state<JoinResolveState>({ status: "loading" });
  let joinState = $state<JoinState>({ status: "idle" });

  $effect(() => {
    if (!spaceId) {
      resolveState = { status: "error", message: "Missing space ID in URL." };
      return;
    }
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

  async function onJoin() {
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
      joinState = { status: "success" };
      goto(`/${spaceId}`);
    } catch (err) {
      joinState = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
</script>

<JoinDialog {resolveState} {joinState} {inviteToken} {onJoin}>
  {#snippet avatar()}
    <div class="w-10 h-10 rounded-full bg-base-200 dark:bg-base-700"></div>
  {/snippet}
</JoinDialog>
