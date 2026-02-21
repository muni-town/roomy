<script lang="ts">
  import { page } from "$app/state";
  import InlineMono from "$lib/components/primitives/InlineMono.svelte";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { peer, peerStatus } from "$lib/workers";
  import { Alert, Badge, Button, Input, Tabs, toast } from "@fuxui/base";
  import { Handle, newUlid } from "@roomy/sdk";
  import { IconLoading } from "@roomy/design/icons";

  let spaceHandle = $state(
    app.space.status == "joined" ? app.space.space.handle : "",
  );
  $effect(() => {
    if (app.space.status == "joined") spaceHandle = app.space.space.handle;
  });
  let exampleSpaceHandle = $derived(
    spaceHandle || peerStatus.profile?.handle || "example.com",
  );
  let currentSpaceHandle = $derived(
    app.space.status == "joined" && app.space.space.handle,
  );
  let currentProfileSpace = $derived(peer.getProfileSpace());

  let handleResolvesToSpace = $state(new Promise<boolean>(() => {}));
  $effect(() => {
    const handle = spaceHandle;
    if (!handle || handle.split(".").length < 2) {
      handleResolvesToSpace = new Promise(() => {});
      return;
    }
    handleResolvesToSpace = peer
      .resolveSpaceId(Handle.assert(handle))
      .then(({ spaceId }) => {
        return app.space.status == "joined" && app.space.space.id == spaceId;
      })
      .catch(() => false);
  });

  const handleTabs = ["Use My Handle", "Use DNS"] as const;
  let activeHandleTab: (typeof handleTabs)[number] = $state("Use My Handle");

  async function setSpaceHandleUsingProfile() {
    if (
      app.space.status != "joined" ||
      peerStatus.authState?.state != "authenticated"
    )
      return;

    try {
      // Set this space as the user's profile space
      await peer.setProfileSpace(app.space.space.id);

      // Set the current user as the handle provider for the space
      await peer.sendEvent(app.space.space.id, {
        $type: "space.roomy.space.setHandleProvider.v0",
        id: newUlid(),
        did: peerStatus.authState.did,
      });

      // And reload the page
      window.location.reload();
    } catch (e) {
      console.error(e);
      toast.error("Error setting handle for space.");
    }
  }

  async function removeProfileSpaceRecord() {
    const currentProfileSpaceId = await currentProfileSpace;
    if (
      !currentProfileSpaceId ||
      app.space.status != "joined" ||
      app.space.space.id != currentProfileSpaceId ||
      peerStatus.authState?.state != "authenticated" ||
      !peerStatus.profile
    ) {
      return;
    }

    try {
      // If the current space handle matches our user's handle, then we need to clear the handle
      // provider for the space.
      if (currentSpaceHandle == peerStatus.profile.handle) {
        await peer.sendEvent(app.space.space.id, {
          $type: "space.roomy.space.setHandleProvider.v0",
          id: newUlid(),
          did: null,
        });
      }

      // Then we need remove the profile space record from the user's PDS.
      await peer.setProfileSpace(null);
      // And reload the page
      window.location.reload();
    } catch (e) {
      console.error(e);
      toast.error("Error unsetting handle for space.");
    }
  }

  function setHandleUsingDns() {
    if (app.space.status != "joined") return;
    const spaceId = app.space.space.id;
    peer
      .setSpaceHandle(spaceId, spaceHandle || null)
      .then(async () => {
        toast.success("Updated space handle");
        if (!spaceHandle || !(await handleResolvesToSpace)) {
          window.location.href = `/${spaceId}/settings/handle`;
        } else {
          window.location.href = `/${spaceHandle}/settings/handle`;
        }
      })
      .catch((e) => {
        toast.error(`Could not update space handle: ${e}`);
      });
  }
</script>

<div class="pt-8 mt-8 border-t border-base-200 dark:border-base-800">
  <h2
    class="text-xl/7 font-bold text-base-900 dark:text-base-100 mb-4 flex gap-3 items-center"
  >
    Space Handle <Badge>{currentSpaceHandle || "Not Set"}</Badge>
  </h2>

  <p class="mb-3 text-base-700 dark:text-base-300">
    Setting a space handle allows your space to be accessed with a nicer URL
    such as:
  </p>

  <div class="font-bold m-3 font-mono text-base-900 dark:text-base-100">
    {page.url.host}/{exampleSpaceHandle}
  </div>

  <p class="mb-3 text-base-700 dark:text-base-300">
    A space admin can use their handle for the space, or you can configure a
    handle using DNS.
  </p>

  <div class="flex">
    <Tabs
      items={handleTabs.map((name) => ({
        name,
        onclick: () => (activeHandleTab = name),
      }))}
      active={activeHandleTab}
      class="mb-4"
    />
  </div>

  {#if activeHandleTab == "Use My Handle"}
    {#await currentProfileSpace}
      <div class="flex justify-center">
        <IconLoading class="animate-spin" font-size={40} />
      </div>
    {:then profileSpace}
      <form class="items-start">
        {#if app.space.status == "joined" && app.space.space.id == profileSpace}
          <strong
            >Your ATProto handle <code>{peerStatus.profile?.handle}</code> is being
            used for this space.
          </strong>
        {:else if profileSpace}
          <Alert type="warning"
            ><div>
              <strong
                >Your ATProto handle <InlineMono
                  >{peerStatus.profile?.handle}</InlineMono
                > is being used for a
                <a href={`/${profileSpace}`} class="text-accent-500"
                  >different space</a
                >.</strong
              > Using your handle for this space will disconnect it from the other
              one.
            </div></Alert
          >
        {:else}
          <Alert type="info"
            ><span
              >Your ATProto handle <InlineMono
                >@{peerStatus.profile?.handle}</InlineMono
              > is not being used for any space.</span
            ></Alert
          >
        {/if}

        <div class="gap-2 flex flex-col items-start my-3 p-3">
          <!-- If the space is not currently using the user's handle. -->
          {#if peerStatus.profile && currentSpaceHandle != peerStatus.profile?.handle}
            <Button onclick={setSpaceHandleUsingProfile}
              >Use My Handle For This Space</Button
            >
          {/if}

          <!-- If space is currently using the user's handle. -->
          {#if app.space.status == "joined" && app.space.space.id == profileSpace}
            <Button onclick={removeProfileSpaceRecord}
              >Remove Your Handle From This Space</Button
            >
          {/if}
        </div>

        <!-- <div class="my-3 flex flex-col gap-2">
        {#await spaceForCurrentAccountHandleResp then resp}
          {#if resp && resp.spaceId != spaceId}
            <div>
              Your handle is currently being used for
              <a
                href={`${page.url.protocol}//${page.url.host}/${resp.spaceId}`}
                class="text-blue-400"
              >
                another space.
              </a> Using it for this space will mean it can't be used for the other
              space.
            </div>
          {/if}
        {/await}
      </div> -->
      </form>
    {/await}
  {:else if activeHandleTab == "Use DNS"}
    <form>
      <p class="mb-3 text-base-700 dark:text-base-300">
        In order to set a space handle you must create a DNS TXT record for your
        domain:
      </p>

      <pre
        class="font-bold m-4 font-mono text-base-900 dark:text-base-100">TXT    _leaf{exampleSpaceHandle.split(
          ".",
        ).length >= 3
          ? "."
          : ""}{exampleSpaceHandle.split(".").slice(0, -2)}    "did={app.space
          .status == "joined" && app.space.space.id}"</pre>

      <Input
        bind:value={spaceHandle}
        placeholder="example.com"
        class="w-full mt-2"
      />

      <div class="space-y-3 my-3 justify-end flex items-baseline gap-3">
        {#if spaceHandle}
          {#await handleResolvesToSpace}
            <span class="flex gap-2 items-center">
              Verifying <IconLoading class="animate-spin" />
            </span>
          {:then resolves}
            {#if resolves}
              <span class="text-green-600">Verified</span>
            {:else}
              <span class="text-red-600">DNS Resolution Failed</span>
            {/if}
          {/await}
        {/if}

        <Button type="submit" onclick={setHandleUsingDns}
          >{!spaceHandle && !!currentSpaceHandle
            ? "Remove Current Handle"
            : "Set Handle"}</Button
        >
      </div>
    </form>
  {/if}
</div>
