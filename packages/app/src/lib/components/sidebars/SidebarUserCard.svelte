<script lang="ts">
  import UserMenu from "@roomy/design/components/user/UserMenu.svelte";
  import { peer, peerStatus } from "$lib/workers";

  const connected = $derived(peerStatus.authState?.state === "authenticated");

  const versionLabel = $derived(
    `Roomy ${__APP_VERSION__}${__BUILD_ID__ ? ` ( ${__BUILD_ID__} )` : ""}`,
  );

  function onLogout() {
    peer.logout().then(() => {
      window.location.reload();
    });
  }
</script>

<div class="shrink-0 px-2 pb-2 pt-1 border-t border-base-300/20 dark:border-base-700/20">
  <UserMenu
    {connected}
    avatar={peerStatus.profile?.avatar}
    displayName={peerStatus.profile?.displayName}
    handle={peerStatus.profile?.handle}
    profileHref={peerStatus.profile ? `/user/${peerStatus.profile.id}` : undefined}
    {versionLabel}
    {onLogout}
  />
</div>