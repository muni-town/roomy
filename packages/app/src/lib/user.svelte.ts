import type { OAuthSession } from "@atproto/oauth-client-browser";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { Agent, BlobRef } from "@atproto/api";
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

  /**
   * Upload a video to Bluesky
   */

  async uploadVideo(file: File) {
    const VIDEO_SERVICE = "https://video.bsky.app";
    const videoName = file.name;
    const mimeType = "video/mp4"; // Assuming you're only allowing .mp4

    const agent = this.agent;
    if (!agent) throw new Error("No agent initialised");

    if (!agent.did) {
      throw new Error("Agent did not resolve");
    }

    const { data: repoInfo } = await agent.com.atproto.repo.describeRepo({
      repo: agent.did,
    });

    const pdsHost = new URL((repoInfo.didDoc.service as any)[0].serviceEndpoint)
      .host;
    const audience = `did:web:${pdsHost}`;

    // Step 1: Get a service auth token
    const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth(
      {
        aud: audience,
        exp: Math.floor(Date.now() / 1000 + 60 * 30), // 30 minutes expiry
        lxm: "com.atproto.repo.uploadBlob",
      },
    );

    const token = serviceAuth.token;

    // Step 2: Upload the video to the video service
    const uploadUrl = new URL(
      `${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`,
    );
    uploadUrl.searchParams.append("did", agent.did);
    uploadUrl.searchParams.append("name", videoName);

    const uploadResponse = await fetch(uploadUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
        "Content-Length": file.arrayBuffer.length.toString(),
      },
      body: file,
    });

    const uploadResponseJson = await uploadResponse.json();
    if (!uploadResponse.ok) {
      if (uploadResponseJson.state !== "JOB_STATE_COMPLETED") {
        throw new Error(
          `Upload failed: ${uploadResponse.status} ${uploadResponseJson}`,
        );
      }
    }

    const jobStatus = uploadResponseJson;
    console.log("Job status response:", jobStatus);
    if (!jobStatus.jobId && !jobStatus.blob) {
      throw new Error("Video upload failed: No jobId or blob in response");
    }

    // Step 3: Poll for job completion
    let blob: BlobRef | undefined = jobStatus.blob;
    const jobId = jobStatus.jobId;
    const videoAgent = new Agent({ service: VIDEO_SERVICE });

    while (!blob) {
      const { data: status } = await videoAgent.app.bsky.video.getJobStatus({
        jobId,
      });

      console.log(
        "Video processing...",
        status.jobStatus.state,
        status.jobStatus.progress || "",
      );

      if (status.jobStatus.blob) {
        blob = status.jobStatus.blob;
      } else if (status.jobStatus.state === "failed") {
        throw new Error("Video processing failed");
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Step 4: Create your custom record referencing the blob
    const rkey = `${Date.now()}`;
    const record = {
      $type: "chat.roomy.v0.videos",
      video: blob,
      alt: "User uploaded video",
    };

    await agent.com.atproto.repo.putRecord({
      repo: agent.did!,
      collection: "chat.roomy.v0.videos",
      rkey,
      record,
    });

    // Step 5: Create a dummy embed post to activate CDN caching
    const embedRecord = {
      $type: "app.bsky.embed.video",
      video: blob,
      aspectRatio: await getAspectRatio(file),
    };

    await agent.com.atproto.repo.putRecord({
      repo: agent.did!,
      collection: "chat.roomy.v0.videoEmbeds",
      rkey: `embed-${rkey}`,
      record: {
        $type: "chat.roomy.v0.videoEmbeds",
        embed: embedRecord,
        createdAt: new Date().toISOString(),
      },
    });

    const url = `https://video.cdn.bsky.app/hls/${agent.did}/${blob.ref}/720p/video.m3u8`;
    console.log("✅ Video uploaded and processed. CDN URL:", url);

    return {
      url,
      mediaType: "video",
      duration: undefined,
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
};

function getAspectRatio(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src); // clean up
      if (video.videoWidth && video.videoHeight) {
        const aspect = video.videoWidth / video.videoHeight;
        resolve(parseFloat(aspect.toFixed(2)));
      } else {
        reject(new Error("Unable to determine video dimensions"));
      }
    };
    video.onerror = () => {
      reject(new Error("Failed to load video metadata"));
    };

    video.src = URL.createObjectURL(file);
  });
}
