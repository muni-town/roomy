import type { OAuthSession } from "@atproto/oauth-client-browser";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { Agent } from "@atproto/api";
import toast from "svelte-french-toast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";

import { EntityId } from "@muni-town/leaf";

import { atproto } from "./atproto.svelte";
import { lexicons } from "./lexicons";
import { decodeBase32 } from "./base32";
import { isTauri } from "@tauri-apps/api/core";
import { navigate } from "$lib/utils.svelte";
import { handleOauthCallback } from "./handleOauthCallback";

// Reload app when this module changes to prevent accumulated connections
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

type Keypair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

let session: OAuthSession | undefined = $state();
let agent: Agent | undefined = $state();

/** The user's atproto profile information. */
let profile: { data: ProfileViewDetailed | undefined } = $derived.by(() => {
  let data: ProfileViewDetailed | undefined = $state();
  if (session && agent) {
    try {
      agent
        .getProfile({ actor: agent.assertDid })
        .then((res) => {
          data = res.data;
        })
        .catch((error) => {
          console.error("Failed to fetch profile:", error);
        });
    } catch (error) {
      console.error("Error in profile fetch:", error);
    }
  }
  return {
    get data() {
      return data;
    },
  };
});

/** The user's Roomy keypair. */
let keypair: {
  value: Keypair | undefined;
} = $derived.by(() => {
  let value: Keypair | undefined = $state();

  if (session && agent) {
    agent
      .call("chat.roomy.v0.key", undefined, undefined, {
        headers: {
          "atproto-proxy": "did:web:keyserver.roomy.chat#roomy_keyserver",
        },
      })
      .then((resp) => {
        value = {
          publicKey: new Uint8Array(decodeBase32(resp.data.publicKey)),
          privateKey: new Uint8Array(decodeBase32(resp.data.privateKey)),
        };
      });
  }
  return {
    get value() {
      return value;
    },
  };
});

/** The user's Roomy keypair. */
let catalogId: {
  value: string | undefined;
} = $derived.by(() => {
  let value: string | undefined = $state();

  if (session && agent) {
    agent.com.atproto.repo
      .getRecord({
        repo: agent.assertDid,
        collection: "chat.roomy.01JPNX7AA9BSM6TY2GWW1TR5V7.catalog",
        rkey: "self",
      })
      .then((resp) => {
        value = (resp.data.value as { id: string }).id;
      })
      .catch(async () => {
        const newCatalogId = new EntityId().toString();
        await agent?.com.atproto.repo.createRecord({
          collection: "chat.roomy.01JPNX7AA9BSM6TY2GWW1TR5V7.catalog",
          record: { id: newCatalogId },
          repo: agent.assertDid,
          rkey: "self",
        });
        value = newCatalogId;
      });
  }
  return {
    get value() {
      return value;
    },
  };
});

let isLoginDialogOpen = $state(false);

/** The user store. */
export const user = {
  get isLoginDialogOpen() {
    return isLoginDialogOpen;
  },
  set isLoginDialogOpen(value) {
    isLoginDialogOpen = value;
  },

  /**
   * The AtProto agent that can be used to interact with the AtProto API
   * through the user's login.
   * */
  get agent() {
    return agent;
  },

  get catalogId() {
    return catalogId;
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

  get keypair() {
    return keypair;
  },

  /**
   * Initialize the user store, setting up the oauth client, and restoring previous session if
   * necessary.
   * */
  async init() {
    // Add the user store to the global scope so it can easily be accessed in dev tools
    (globalThis as any).user = this;

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
    if (!session) {
      this.logout();
    }
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
    session = undefined;
    agent = undefined;
    navigate("home");
  },
};
