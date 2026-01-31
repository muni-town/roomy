<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import InlineMono from "$lib/components/primitives/InlineMono.svelte";
  import { current } from "$lib/queries";
  import { backend, backendStatus } from "$lib/workers";
  import {
    Alert,
    Badge,
    Button,
    Input,
    Tabs,
    toast,
  } from "@fuxui/base";
  import { Handle, newUlid } from "@roomy/sdk";

  import IconMdiLoading from "~icons/mdi/loading";

  let spaceHandle = $state(
    current.space.status == "joined" ? current.space.space.handle : "",
  );
  $effect(() => {
    if (current.space.status == "joined")
      spaceHandle = current.space.space.handle;
  });
  let exampleSpaceHandle = $derived(
    spaceHandle || backendStatus.profile?.handle || "example.com",
  );
  let currentSpaceHandle = $state(
    current.space.status == "joined" ? current.space.space.handle : "",
  );
  let profileSpace = $state<string | null>(null);

  let handleResolvesToSpace = $state(new Promise<boolean>(() => {}));
  $effect(() => {
    const handle = spaceHandle;
    if (!handle || handle.split(".").length < 2) {
      handleResolvesToSpace = new Promise(() => {});
      return;
    }
    handleResolvesToSpace = backend
      .resolveSpaceId(Handle.assert(handle))
      .then(({ spaceId }) => {
        return (
          current.space.status == "joined" && current.space.space.id == spaceId
        );
      })
      .catch(() => false);
  });

  const handleTabs = ["Use My Handle", "Use DNS"] as const;
  let activeHandleTab: (typeof handleTabs)[number] = $state("Use My Handle");

  $effect(() => {
    (async () => {
      profileSpace = await backend.getProfileSpace() ?? null;
    })();
  });

  async function setSpaceHandleUsingProfile() {
    if (
      current.space.status != "joined" ||
      backendStatus.authState?.state != "authenticated"
    )
      return;

    try {
      // Set this space as the user's profile space
      await backend.setProfileSpace(current.space.space.id);

      // Set the current user as the handle provider for the space
      await backend.sendEvent(current.space.space.id, {
        $type: "space.roomy.space.setHandleProvider.v0",
        id: newUlid(),
        did: backendStatus.authState.did,
      });

      // Update reactive state
      currentSpaceHandle = backendStatus.profile?.handle ?? "";
      profileSpace = current.space.space.id;

      // Navigate to this page using the new space handle to reflect changes
      await goto(`/${backendStatus.profile?.handle}/settings/handle`)

      toast.success("Updated space handle");

    } catch (e) {
      console.error(e);
      toast.error("Error setting handle for space.");
    }
  }

  async function removeProfileSpaceRecord() {
    if (
      !profileSpace ||
      current.space.status != "joined" ||
      current.space.space.id != profileSpace ||
      currentSpaceHandle != backendStatus.profile?.handle ||
      backendStatus.authState?.state != "authenticated" ||
      !backendStatus.profile
    ) {
      return;
    }

    try {
      // Unset the user's profile space
      await backend.setProfileSpace(null);

      // Unset the current handle provider for the space
      await backend.sendEvent(current.space.space.id, {
        $type: "space.roomy.space.setHandleProvider.v0",
        id: newUlid(),
        did: null,
      });

      // Update reactive state
      currentSpaceHandle = ""
      profileSpace = null

      // Navigate to this page using the space ID to reflect changes
      await goto(`/${current.space.space.id}/settings/handle`)

      toast.success("Updated space handle");

    } catch (e) {
      console.error(e);
      toast.error("Error unsetting handle for space.");
    }
  }

  async function setHandleUsingDns() {
    if (
      current.space.status != "joined" ||
      backendStatus.authState?.state != "authenticated"
    ) 
      return;
    
    try {
      // Set the space handle to the new value
      await backend.setSpaceHandle(current.space.space.id, spaceHandle || null)

      // Update reactive state
      currentSpaceHandle = spaceHandle;
      profileSpace = current.space.space.id;

      // Navigate to this page using the new space handle to reflect changes
      const url = !spaceHandle || !handleResolvesToSpace
        ? `/${current.space.space.id}/settings/handle`
        : `/${spaceHandle}/settings/handle`;
      await goto(url)

      toast.success("Updated space handle");
      
    } catch (e) {
      console.error(e)
      toast.error(`Error setting handle for space: ${e}`);
    }
  }
</script>

<!-- Space Handle Form -->
<div class="pt-4">
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
    {#await profileSpace}
      <div class="flex justify-center">
        <IconMdiLoading class="animate-spin" font-size={40} />
      </div>
    {:then profileSpace}
      <form class="items-start">
        {#if current.space.status == "joined" && current.space.space.id == profileSpace}
          <strong
            >Your ATProto handle <code>{backendStatus.profile?.handle}</code> is
            being used for this space.
          </strong>
        {:else if profileSpace}
          <Alert type="warning"
            ><div>
              <strong
                >Your ATProto handle <InlineMono
                  >{backendStatus.profile?.handle}</InlineMono
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
                >@{backendStatus.profile?.handle}</InlineMono
              > is not being used for any space.</span
            ></Alert
          >
        {/if}

        <div class="gap-2 flex flex-col items-start my-3 p-3">
          <!-- If the space is not currently using the user's handle. -->
          {#if backendStatus.profile && currentSpaceHandle != backendStatus.profile?.handle}
            <Button onclick={setSpaceHandleUsingProfile}
              >Use My Handle For This Space</Button
            >
          {/if}

          <!-- If space is currently using the user's handle. -->
          {#if current.space.status == "joined" && current.space.space.id == profileSpace}
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
          : ""}{exampleSpaceHandle.split(".").slice(0, -2)}    "did={current
          .space.status == "joined" && current.space.space.id}"</pre>

      <Input
        bind:value={spaceHandle}
        placeholder="example.com"
        class="w-full mt-2"
      />

      <div class="space-y-3 my-3 justify-end flex items-baseline gap-3">
        {#if spaceHandle}
          {#await handleResolvesToSpace}
            <span class="flex gap-2 items-center">
              Verifying <IconMdiLoading class="animate-spin" />
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
