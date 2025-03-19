import { atproto } from "./atproto.svelte";
import type { OAuthSession } from "@atproto/oauth-client-browser";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { Agent, ComAtprotoRepoUploadBlob } from "@atproto/api";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { lexicons } from "./lexicons";
import { decodeBase32 } from "./base32";
import { IN_TAURI, invoke } from "./tauri";
import { page } from "$app/state";

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
    agent.getProfile({ actor: agent.assertDid }).then((res) => {
      data = res.data;
    });
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

/** The user's automerge repository. */
let storage = $derived.by(() => {
  if (!session) return;
  const did = session.did;

  return new IndexedDBStorageAdapter(did, "autodoc");
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
      agent = new Agent(newSession);
      lexicons.forEach((l) => agent!.lex.add(l));
    } else {
      agent = undefined;
      localStorage.removeItem("did");
    }
  },

  /**
   * The user's profile information from AtProto.
   */
  get profile() {
    return profile;
  },

  /** User storage adapter. */
  get storage() {
    return storage;
  },

  get keypair() {
    return keypair;
  },

  /** Interface to the user's chat data. */
  get repo() {
    return storage;
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
      atproto.oauth.restore(storedDid).then((s) => (this.session = s));
    }
  },

  /** Login a user using their handle, replacing the existing session if any. */
  async loginWithHandle(handle: string) {
    localStorage.setItem("redirectAfterAuth", window.location.pathname);
    const url = await atproto.oauth.authorize(handle, {
      scope: atproto.scope,
    });
    if (IN_TAURI) {
      const { openUrl } = window.__TAURI__.opener
      const { onOpenUrl } = window.__TAURI__.deepLink

      openUrl(url)
      await onOpenUrl((urls) => {
        if (!urls || urls.length < 1) return
        const url = new URL(urls[0])
        const path = page.url

        path.search = url.search;
        path.pathname = url.pathname;
        window.location.href = path.href
      })

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
    console.log(resp.data.blob.toJSON());
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
  },
};
