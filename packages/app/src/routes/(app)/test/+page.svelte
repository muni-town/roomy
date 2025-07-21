<script lang="ts">
  import { AccountCoState } from "jazz-tools/svelte";
  import { user } from "$lib/user.svelte";
  import { publicGroup, RoomyAccount, RoomyEntityList } from "@roomy-chat/sdk";

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        $onError: null,
      },
      root: true,
    },
  });
  const { children } = $props();

  $effect(() => {
    if (!user.profile.data?.handle || !me.current) {
      console.log("couldnt find handle or me");
      return;
    }

    if (!me.current.profile) {
      console.log("couldnt find profile");
      return;
    }

    console.log("me.current.profile", me.current.profile);
    console.log(
      "me.current.profile.newJoinedSpacesTest",
      me.current.profile.newJoinedSpacesTest,
    );

    if (me.current.profile?.newJoinedSpacesTest) {
      console.log("deleting newJoinedSpacesTest");
      // me.current.profile.newJoinedSpacesTest = null;
      delete me.current.profile.newJoinedSpacesTest;
    }
    // if(!me.current.profile?.newJoinedSpacesTest === null) {
    //   console.log("couldnt find newJoinedSpacesTest, creating new one");
    //   me.current.profile.newJoinedSpacesTest = RoomyEntityList.create([], publicGroup("reader"));
    // }

    // if(!me.current.profile?.joinedDate === null) {
    //   me.current.profile.joinedDate = new Date();
    // }

    // if (me.current.profile.name !== user.profile.data?.handle) {
    //   me.current.profile.name = user.profile.data?.handle;
    // }

    // if (me.current.profile.imageUrl !== user.profile.data?.avatar) {
    //   me.current.profile.imageUrl = user.profile.data?.avatar;
    // }

    // if (me.current.profile.blueskyHandle !== user.profile.data?.handle) {
    //   me.current.profile.blueskyHandle = user.profile.data?.handle;
    // }

    // if (me.current.profile.bannerUrl !== user.profile.data?.banner) {
    //   me.current.profile.bannerUrl = user.profile.data?.banner;
    // }

    // if (me.current.profile.description !== user.profile.data?.description) {
    //   me.current.profile.description = user.profile.data?.description;
    // }
  });
</script>

{@render children?.()}
