<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import JoinDialog from "@roomy/design/components/modals/JoinDialog.svelte";
  import type {
    JoinResolveState,
    JoinState,
  } from "@roomy/design/components/modals/JoinDialog.svelte";
  import { transport, cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import { queryClient } from "$lib/client";
  import { joinSpace } from "$lib/mutations/space";

  const { agentQuery } = transport;
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
        queryFn: () => agentQuery(px(), "space.roomy.space.getMetadata", { spaceId }),
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
