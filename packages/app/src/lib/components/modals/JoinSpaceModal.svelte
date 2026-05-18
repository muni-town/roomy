<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import JoinDialog, {
    type JoinResolveState,
    type JoinState,
  } from "@roomy/design/components/modals/JoinDialog.svelte";
  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import { joinSpace } from "$lib/mutations/space";
  import { type SpaceIdOrHandle } from "$lib/workers/types";
  import { peer } from "$lib/workers";
  import { StreamDid } from "@roomy-space/sdk";

  let spaceDid = $state<StreamDid>();

  let resolved = $state<{
    spaceId: StreamDid;
    name: string;
    avatar?: string;
    allowPublicJoin: boolean;
  } | null>(null);

  let resolveState = $state<JoinResolveState>({ status: "loading" });
  let joinState = $state<JoinState>({ status: "idle" });

  let inviteToken = $derived(page.url.searchParams.get("invite") ?? undefined);
  let urlError = $derived(page.url.searchParams.get("joinError") ?? undefined);

  $effect(() => {
    (async () => {
      if (!page.params.space) {
        resolveState = {
          status: "error",
          message: "No space ID or handle provided",
        };
        return;
      }
      const resolvedSpace = await peer.resolveSpaceId(
        page.params.space as SpaceIdOrHandle,
      );
      if (resolvedSpace) {
        spaceDid = resolvedSpace.spaceId;
      } else {
        resolveState = {
          status: "error",
          message: "This space doesn't exist or has been deleted...",
        };
      }
    })();
  });

  $effect(() => {
    const spaceId = spaceDid;
    if (spaceId) {
      peer.getSpaceInfo(spaceId).then((info) => {
        if (info && info.name) {
          resolved = {
            spaceId,
            name: info.name,
            avatar: info?.avatar,
            allowPublicJoin: info.allowPublicJoin ?? true,
          };
          resolveState = {
            status: "success",
            data: {
              name: info.name,
              allowPublicJoin: info.allowPublicJoin ?? true,
            },
          };
        } else {
          resolveState = {
            status: "error",
            message: "This space doesn't exist or has been deleted...",
          };
        }
      });
    }
  });

  async function onJoin() {
    if (!resolved) return;
    joinState = { status: "loading" };

    if (page.url.searchParams.has("joinError")) {
      const url = new URL(page.url.href);
      url.searchParams.delete("joinError");
      await goto(url.toString(), {
        replaceState: true,
        noScroll: true,
        keepFocus: true,
      });
    }

    try {
      await joinSpace(resolved.spaceId, inviteToken);
      joinState = { status: "success", data: undefined };
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message.includes("this space requires an invite to join")
            ? "Invalid invite link"
            : e.message
          : "Failed to join space";

      joinState = { status: "error", message };
      const url = new URL(page.url.href);
      url.searchParams.set("joinError", message);
      goto(url.toString(), {
        replaceState: true,
        noScroll: true,
        keepFocus: true,
      });
    }
  }
</script>

<JoinDialog {resolveState} {joinState} {inviteToken} {urlError} {onJoin}>
  {#snippet avatar()}
    <SpaceAvatar
      imageUrl={resolved?.avatar ?? ""}
      id={page.params.space}
      name={resolved?.name ?? ""}
      size={50}
    />
  {/snippet}
</JoinDialog>
