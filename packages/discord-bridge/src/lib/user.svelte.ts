import type { OAuthSession } from "@atproto/oauth-client-browser";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { Agent } from "@atproto/api";
import toast from "svelte-french-toast";
import { atproto } from "./atproto.svelte";
import { navigate } from "./utils.svelte";
import { handleOauthCallback } from "./handleOauthCallback";
import { lexicons } from "./lexicons";

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

  /**
   * The AtProto OAuth login session for the user.
   */
  get session() {
    return session;
  },  set session(newSession) {
    session = newSession;
    if (newSession) {
      // Store the user's DID on login
      localStorage.setItem("did", newSession.did);
      agent = new Agent(newSession);
      lexicons.forEach((l: any) => agent!.lex.add(l));
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
  },  /** Login a user using their handle, replacing the existing session if any. */
  async loginWithHandle(handle: string) {
    localStorage.setItem("redirectAfterAuth", window.location.pathname);
    const url = await atproto.oauth.authorize(handle, {
      scope: atproto.scope,
    });
    if (url) {
      window.location.href = url.toString();
    }

    // Protect against browser's back-forward cache
    await new Promise<never>((_resolve, reject) => {
      setTimeout(
        reject,
        10000,
        new Error("User navigated back from the authorization page"),
      );
    });
  },  /** Login via Bluesky's default flow */
  async signInWithBluesky() {
    localStorage.setItem("redirectAfterAuth", window.location.pathname);
    const url = await atproto.oauth.signIn("https://bsky.social") as URL;
    window.location.href = url.href;

    // Protect against browser's back-forward cache
    await new Promise<never>((_resolve, reject) => {
      setTimeout(
        reject,
        10000,
        new Error("User navigated back from the authorization page"),
      );
    });
  },

  /** Logout the user. */
  logout() {
    session = undefined;
    agent = undefined;
    localStorage.removeItem("did");
    navigate("home");
  },
};
