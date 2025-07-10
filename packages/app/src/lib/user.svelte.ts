import type { OAuthSession } from "@atproto/oauth-client-browser";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { Agent } from "@atproto/api";
import toast from "svelte-french-toast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { atproto } from "./atproto.svelte";
import { lexicons } from "./lexicons";
import { isTauri } from "@tauri-apps/api/core";
import { navigate } from "$lib/utils.svelte";
import { handleOauthCallback } from "./handleOauthCallback";

// Reload app when this module changes to prevent accumulated connections
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

let session: OAuthSession | undefined = $state();
let agent: Agent | undefined = $state();

/** The user's atproto profile information. */
let profile: { data: ProfileViewDetailed | undefined } = $derived.by(() => {
  let data: ProfileViewDetailed | undefined = $state();
  if (session && agent) {
    agent
      .getProfile({ actor: agent.assertDid })
      .then((res) => {
        let lastLoginDid = localStorage.getItem("last-login");
        if (agent?.did && agent.did === lastLoginDid) {
          localStorage.setItem(
            `profile-${lastLoginDid}`,
            JSON.stringify(res.data),
          );
        }

        data = res.data;
      })
      .catch((error) => {
        console.error("Failed to fetch profile:", error);
      });
  }
  return {
    get data() {
      return data;
    },
  };
});

/** The user's Jazz passphrase from our Jazz keyserver. */
let passphrase: {
  value: string | undefined;
} = $derived.by(() => {
  let passphrase: string | undefined = $state();

  if (session && agent) {
    agent
      .call("chat.roomy.v1.passphrase", undefined, undefined, {
        headers: {
          "atproto-proxy": "did:web:jazz.keyserver.roomy.chat#roomy_keyserver",
        },
      })
      .then((resp) => {
        passphrase = resp.data;
      });
  }
  return {
    get value() {
      return passphrase;
    },
  };
});

/** The user store. */
export const user = {
  /**
   * The AtProto agent that can be used to interact with the AtProto API
   * through the user's login.
   * */
  get agent() {
    return agent;
  },

  /**
   * The AtProto OAuth login session for the user.
   */
  get session() {
    return session;
  },
  set session(newSession) {
    session = newSession;
    if (newSession) {
      // Store the user's DID on login
      localStorage.setItem("did", newSession.did);
      localStorage.setItem("last-login", newSession.did);

      agent = new Agent(newSession);
      lexicons.forEach((l) => agent!.lex.add(l));
    } else {
      this.logout();
    }
  },

  /**
   * The user's profile information from AtProto.
   */
  get profile() {
    return profile;
  },

  get passphrase() {
    return passphrase;
  },

  /**
   * Initialize the user store, setting up the oauth client, and restoring previous session if
   * necessary.
   * */
  async init() {
    // Add the user store to the global scope so it can easily be accessed in dev tools
    (globalThis as any).user = this;
    
    // Add dev mode debugging functions
    if (import.meta.env.DEV) {
      this.addDevModeHelpers();
    }

    // Initialize oauth client.
    await atproto.init();

    // if there's a stored DID on localStorage and no session
    // restore the session
    const storedDid = localStorage.getItem("did");
    if (!session && storedDid) {
      try {
        // atproto.oauth must be awaited to get the correct result
        const restoredSession = await atproto.oauth.restore(storedDid);
        this.session = restoredSession;
      } catch (error) {
        // Session expired, clean up previous session
        toast.error("Session expired. Please log in again.");
        console.error("Failed to restore session:", error);
        this.logout();
      }
    }

    // When user session is removed, clean up user
    // and redirect using logout function
    // if (!session) {
    //   //this.logout();
    // }
  },

  /** Login a user using their handle, replacing the existing session if any. */
  async loginWithHandle(handle: string) {
    localStorage.setItem("redirectAfterAuth", window.location.pathname);
    const url = await atproto.oauth.authorize(handle, {
      scope: atproto.scope,
    });
    if (isTauri()) {
      openUrl(url.toString());
      // runs on tauri desktop platforms
      await onOpenUrl((urls: string[]) => {
        if (!urls || urls.length < 1) return;
        const url = new URL(urls[0]!);
        // redirecting to "/oauth/callback" from here counts as opening the link twice.
        // instead we handle the returned searchParams directly here
        return handleOauthCallback(url.searchParams);
      });
    } else {
      window.location.href = url.href;

      // Protect against browser's back-forward cache
      await new Promise<never>((_resolve, reject) => {
        setTimeout(
          reject,
          10000,
          new Error("User navigated back from the authorization page"),
        );
      });
    }
  },

  async uploadBlob(blob: Blob) {
    if (!agent) return Promise.reject("No agent available");
    const resp = await agent.com.atproto.repo.uploadBlob(blob);
    const blobRef = resp.data.blob;
    // Create a record that links to the blob
    const record = {
      $type: "chat.roomy.v0.images",
      image: blobRef,
      alt: "User uploaded image", // You might want to make this parameter configurable
    };
    // Put the record in the repository
    const putResponse = await agent.com.atproto.repo.putRecord({
      repo: agent.did!,
      collection: "chat.roomy.v0.images",
      rkey: `${Date.now()}`, // Using timestamp as a unique key
      record: record,
    });
    const url = `https://cdn.bsky.app/img/feed_thumbnail/plain/${agent.did}/${blobRef.ipld().ref}`;
    return {
      blob: blobRef,
      uri: putResponse.data.uri,
      cid: putResponse.data.cid,
      url,
    };
  },

  /** Logout the user. */
  logout() {
    localStorage.removeItem("did");
    localStorage.removeItem("jazz-logged-in-secret");
    session = undefined;
    agent = undefined;
    navigate("home");
    // reload the page to clear the session
    window.location.reload();
  },

  /** Add dev mode helper functions to window (only in development) */
  addDevModeHelpers() {
    // Import SDK functions dynamically to avoid issues in production
    import("@roomy-chat/sdk").then(({ Space, IDList, allSpacesListId }) => {
      
      // Remove a space by ID
      (globalThis as any).removeSpace = async (spaceId: string) => {
        console.log(`🗑️ Removing space: ${spaceId}`);
        
        try {
          // Load the space
          const space = await Space.load(spaceId);
          if (!space) {
            console.error("❌ Space not found");
            return false;
          }
          
          console.log(`📝 Space name: ${space.name}`);
          console.log(`🔍 Space owner: ${space.creatorId}`);
          
          // Import Account to check permissions
          const { Account } = await import("@roomy-chat/sdk");
          const me = Account.getMe();
          
          // Check if we can modify this space
          if (!me.canAdmin(space)) {
            console.error("❌ No admin permissions for this space");
            console.log("💡 Tip: You can only remove spaces you created or have admin access to");
            return false;
          }
          
          // Remove from all spaces list first (this is usually more permissive)
          const allSpacesList = await IDList.load(allSpacesListId);
          if (allSpacesList) {
            const index = allSpacesList.findIndex(id => id === spaceId);
            if (index !== -1) {
              allSpacesList.splice(index, 1);
              console.log("✅ Removed from all spaces list");
            } else {
              console.log("⚠️ Space not found in all spaces list");
            }
          } else {
            console.error("❌ Could not load all spaces list");
          }
          
          console.log("✅ Space removed from system (soft delete not needed for cleanup)");
          console.log("🔄 Refresh the page to see the space disappear from the UI");
          return true;
        } catch (error) {
          console.error("❌ Error removing space:", error);
          
          // If it's a permission error, try to just remove from list
          if (error.message && error.message.includes("proxy set handler returned false")) {
            console.log("🔄 Trying alternative removal method (list removal only)...");
            try {
              const allSpacesList = await IDList.load(allSpacesListId);
              if (allSpacesList) {
                const index = allSpacesList.findIndex(id => id === spaceId);
                if (index !== -1) {
                  allSpacesList.splice(index, 1);
                  console.log("✅ Removed from all spaces list (alternative method)");
                  console.log("🔄 Refresh the page to see changes");
                  return true;
                }
              }
            } catch (altError) {
              console.error("❌ Alternative removal also failed:", altError);
            }
          }
          
          return false;
        }
      };
      
      // Remove multiple spaces by IDs
      (globalThis as any).removeSpaces = async (spaceIds: string[]) => {
        console.log(`🗑️ Removing ${spaceIds.length} spaces`);
        
        const results = [];
        for (const spaceId of spaceIds) {
          const result = await (globalThis as any).removeSpace(spaceId);
          results.push({ spaceId, success: result });
        }
        
        const successful = results.filter(r => r.success).length;
        console.log(`✅ Successfully removed ${successful}/${spaceIds.length} spaces`);
        return results;
      };
      
      // List all spaces (for debugging)
      (globalThis as any).listSpaces = async () => {
        console.log("📋 Listing all spaces:");
        
        try {
          const allSpacesList = await IDList.load(allSpacesListId);
          if (!allSpacesList) {
            console.log("❌ No spaces list found");
            return [];
          }
          
          const spaces = [];
          for (const spaceId of allSpacesList) {
            try {
              const space = await Space.load(spaceId);
              if (space) {
                spaces.push({
                  id: spaceId,
                  name: space.name,
                  description: space.description,
                  softDeleted: space.softDeleted || false,
                  memberCount: space.members?.length || 0
                });
              }
            } catch (error) {
              console.warn(`⚠️ Could not load space ${spaceId}:`, error);
            }
          }
          
          console.table(spaces);
          return spaces;
        } catch (error) {
          console.error("❌ Error listing spaces:", error);
          return [];
        }
      };
      
      // Remove joined spaces from user profile
      (globalThis as any).removeJoinedSpace = async (spaceId: string) => {
        console.log(`🚪 Removing joined space from profile: ${spaceId}`);
        
        try {
          const { Account } = await import("@roomy-chat/sdk");
          const me = Account.getMe();
          
          if (!me.profile?.joinedSpaces) {
            console.error("❌ No joined spaces list found in profile");
            return false;
          }
          
          // Find the space in joined spaces
          const spaceIndex = me.profile.joinedSpaces.findIndex(space => space?.id === spaceId);
          
          if (spaceIndex === -1) {
            console.log("⚠️ Space not found in joined spaces list");
            return false;
          }
          
          // Get space name for logging
          const spaceName = me.profile.joinedSpaces[spaceIndex]?.name || "Unknown";
          console.log(`📝 Removing: ${spaceName}`);
          
          // Remove the space from joined spaces
          me.profile.joinedSpaces.splice(spaceIndex, 1);
          
          console.log("✅ Space removed from joined spaces");
          return true;
        } catch (error) {
          console.error("❌ Error removing joined space:", error);
          return false;
        }
      };
      
      // Remove multiple joined spaces from profile
      (globalThis as any).removeJoinedSpaces = async (spaceIds: string[]) => {
        console.log(`🚪 Removing ${spaceIds.length} joined spaces from profile`);
        
        const results = [];
        for (const spaceId of spaceIds) {
          const result = await (globalThis as any).removeJoinedSpace(spaceId);
          results.push({ spaceId, success: result });
        }
        
        const successful = results.filter(r => r.success).length;
        console.log(`✅ Successfully removed ${successful}/${spaceIds.length} joined spaces`);
        return results;
      };
      
      // Clear all joined spaces from profile
      (globalThis as any).clearJoinedSpaces = async () => {
        console.log("🧹 Clearing all joined spaces from profile");
        
        try {
          const { Account } = await import("@roomy-chat/sdk");
          const me = Account.getMe();
          
          if (!me.profile?.joinedSpaces) {
            console.error("❌ No joined spaces list found in profile");
            return false;
          }
          
          const count = me.profile.joinedSpaces.length;
          console.log(`📊 Found ${count} joined spaces`);
          
          if (count === 0) {
            console.log("✅ No joined spaces to clear");
            return true;
          }
          
          // Clear all joined spaces
          me.profile.joinedSpaces.splice(0, me.profile.joinedSpaces.length);
          
          console.log(`✅ Cleared ${count} joined spaces from profile`);
          return true;
        } catch (error) {
          console.error("❌ Error clearing joined spaces:", error);
          return false;
        }
      };
      
      // List joined spaces in profile
      (globalThis as any).listJoinedSpaces = async () => {
        console.log("📋 Listing joined spaces in profile:");
        
        try {
          const { Account } = await import("@roomy-chat/sdk");
          const me = Account.getMe();
          
          if (!me.profile?.joinedSpaces) {
            console.log("❌ No joined spaces list found in profile");
            return [];
          }
          
          const joinedSpaces = [];
          for (const space of me.profile.joinedSpaces) {
            if (space) {
              joinedSpaces.push({
                id: space.id,
                name: space.name,
                description: space.description,
                memberCount: space.members?.length || 0,
                softDeleted: space.softDeleted || false
              });
            }
          }
          
          console.table(joinedSpaces);
          console.log(`📊 Total joined spaces: ${joinedSpaces.length}`);
          return joinedSpaces;
        } catch (error) {
          console.error("❌ Error listing joined spaces:", error);
          return [];
        }
      };

      console.log("🛠️ Dev mode helpers loaded:");
      console.log("  • removeSpace(spaceId) - Remove a single space");
      console.log("  • removeSpaces([spaceId1, spaceId2, ...]) - Remove multiple spaces");
      console.log("  • listSpaces() - List all spaces");
      console.log("  • removeJoinedSpace(spaceId) - Remove space from profile's joined spaces");
      console.log("  • removeJoinedSpaces([spaceId1, spaceId2, ...]) - Remove multiple joined spaces");
      console.log("  • clearJoinedSpaces() - Clear all joined spaces from profile");
      console.log("  • listJoinedSpaces() - List spaces in profile's joined spaces");
    });
  },
};
