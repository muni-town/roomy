import type { DidDocument } from "@atproto/oauth-client-browser";
import { decodeBase32 } from "./utils/base32";
import { goto } from "$app/navigation";
import type { JSONContent } from "@tiptap/core";
import { writable } from "svelte/store";
import { backend, backendStatus } from "./workers";
import { toast } from "@fuxui/base";
import { ulid } from "ulidx";
import { sql } from "./utils/sqlTemplate";
import { id } from "./workers/encoding";

/** Cleans a handle string by removing any characters not valid for a domain. */
export function cleanHandle(handle: string): string {
  return handle.replaceAll(/[^a-z0-9-\.]/gi, "");
}

export type NavigationTarget =
  | "home"
  | {
      space?: string;
      channel?: string;
      thread?: string;
      page?: string;
      object?: string;
    };

/** A helper function to navigate to a specific roomy object, like a space, channel, or thread */
export function navigate(target: NavigationTarget) {
  const targetUrl = navigateSync(target);
  if (targetUrl) {
    goto(targetUrl);
  }
}

/** A helper function to create a route to a specific roomy object, like a space, channel, or thread */
export function navigateSync(target: NavigationTarget) {
  if (target == "home") {
    return "/home";
  } else if (target.space) {
    let url = `/${target.space}`;

    if (target.object) {
      url += `/${target.object}`;
      return url;
    }

    if (target.channel) {
      url += `/${target.channel}`;
    } else if (target.thread) {
      url += `/thread/${target.thread}`;
    } else if (target.page) {
      url += `/page/${target.page}`;
    }
    return url;
  }
}

const handleCache: { [did: string]: DidDocument } = {};
export async function resolveDid(
  did: string,
): Promise<DidDocument | undefined> {
  if (handleCache[did]) return handleCache[did];
  try {
    const resp = await fetch(`https://plc.directory/${did}`);
    const json = await resp.json();
    return json;
  } catch (_e) {
    // Ignore error
  }
}

const keyCache: { [did: string]: Uint8Array } = {};
export async function resolvePublicKey(did: string): Promise<Uint8Array> {
  if (keyCache[did]) return keyCache[did];
  const resp = await fetch(
    `https://keyserver.roomy.chat/xrpc/chat.roomy.v0.key.public?did=${encodeURIComponent(did)}`,
  );
  const json = await resp.json();
  keyCache[did] = decodeBase32(json.publicKey);
  return keyCache[did];
}

export async function resolveLeafId(
  handle: string,
): Promise<string | undefined> {
  const resp = await fetch(
    `https://leaf-resolver.roomy.chat/xrpc/town.muni.01JQ1SV7YGYKTZ9JFG5ZZEFDNK.resolve-leaf-id?domain=${encodeURIComponent(handle)}`,
    {
      headers: [["accept", "application/json"]],
    },
  );
  const json = await resp.json();
  const id = json.id;
  return id;
}

// Helper function to safely parse message content
export function parseMessageContent(bodyJson: string | undefined): JSONContent {
  try {
    if (!bodyJson) return {};
    return JSON.parse(bodyJson);
  } catch (e) {
    console.error("Error parsing message JSON:", e);
    return {};
  }
}

export const Toggle = ({
  value: init,
  key,
}: {
  value: boolean;
  key?: string;
}) => {
  let value = $state(init);

  // Wrapped in a function to avoid calling toString() on the value
  // which has a chance of not being updated.
  const stringValue = () => value.toString();

  if (key) {
    let localValue = localStorage.getItem(key);
    if (localValue) {
      value = JSON.parse(localValue);
    } else {
      localStorage.setItem(key, stringValue());
    }
  }
  return {
    get value() {
      return value;
    },
    toggle() {
      value = !value;
      if (key) localStorage.setItem(key, stringValue());
      return value;
    },
  };
};

/**
 * Takes an image URI, which may be a normal http URL or possibly an atblob:// URI and returns an
 * HTTP URL that can be used to display the image.
 *
 * Returns undefined if the URI fails to parse
 * */
export function cdnImageUrl(
  uri: string,
  opts?: { size: "full" | "thumbnail" },
): string | undefined {
  if (uri.startsWith("atblob://")) {
    const split = uri.split("atblob://")[1]?.split("/");
    if (!split || split.length != 2) return;
    const [did, cid] = split as [string, string];
    return `https://cdn.bsky.app/img/${opts?.size == "thumbnail" ? "feed_thumbnail" : "feed_fullsize"}/plain/${did}/${cid}`;
  } else {
    return uri;
  }
}

/**
 * Wait for backend to be ready (personalStreamId to be set)
 */
async function waitForBackendReady(maxWaitMs = 15000): Promise<boolean> {
  if (backendStatus.personalStreamId) {
    return true;
  }

  if (!backendStatus.did) {
    console.warn("User not logged in - cannot join space");
    return false;
  }

  const startTime = Date.now();
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (backendStatus.personalStreamId) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (elapsed > maxWaitMs) {
        clearInterval(checkInterval);
        console.error(
          `Backend not ready after ${elapsed}ms. Status:`,
          {
            did: backendStatus.did,
            leafConnected: backendStatus.leafConnected,
            personalStreamId: backendStatus.personalStreamId,
            authLoaded: backendStatus.authLoaded,
          },
        );
        resolve(false);
      }
    }, 100);
  });
}

/**
 * Join a space.
 */
export async function joinSpace(spaceIdOrHandle: string) {
  try {
    let spaceId: string | undefined;
    if (spaceIdOrHandle.includes(".")) {
      // Try to resolve via ATProto record first
      console.log("Attempting to resolve handle:", spaceIdOrHandle);
      const resp = await backend.resolveSpaceFromHandleOrDid(spaceIdOrHandle);
      console.log("Resolution result:", resp);
      if (resp?.spaceId) {
        spaceId = resp.spaceId;
        console.log("Resolved space ID:", spaceId);
      } else {
        // Fallback: resolve handle to DID and find space locally
        const handleDid = await backend.resolveHandleToDid(spaceIdOrHandle);
        if (handleDid) {
          try {
            // Query local spaces to find one with matching handle_account
            const spaces = await backend.runQuery(
              sql`-- find space by handle account
                select json_object(
                  'id', id(cs.entity)
                ) as json
                from comp_space cs
                where cs.handle_account = ${handleDid}
                  and hidden = 0
                limit 1
              `,
            );
            if (spaces.rows && spaces.rows.length > 0) {
              const space = JSON.parse(spaces.rows[0].json as string);
              spaceId = space.id;
            }
          } catch (e) {
            // Database might not be initialized yet or space not in local DB
            // This is expected if the user hasn't joined the space yet
            console.warn("Could not find space locally by handle account", e);
          }
        }
      }
    } else {
      spaceId = spaceIdOrHandle;
    }
    console.log("Space ID resolved:", spaceId);
    if (!spaceId) {
      console.error("Cannot join space - space ID not resolved");
      toast.error(
        "Could not join space. The space handle record may not exist yet. Please ask the space admin to set up the handle record, or use the space ID directly.",
      );
      return;
    }

    // Wait for backend to be ready if it's not already
    if (!backendStatus.personalStreamId) {
      console.log("Waiting for backend to be ready...");
      const backendReady = await waitForBackendReady();
      if (!backendReady) {
        console.error(
          "Cannot join space - backend not initialized after waiting",
        );
        toast.error(
          "Cannot join space. The backend is not ready yet. Please wait a moment and try again, or refresh the page.",
        );
        return;
      }
      console.log(
        "Backend is now ready, personalStreamId:",
        backendStatus.personalStreamId,
      );
    }
    // Add the space to the personal list of joined spaces
    await backend.sendEvent(backendStatus.personalStreamId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.space.join.0",
        data: {
          spaceId,
        },
      },
    });
    // Tell the space that we joined.
    await backend.sendEvent(spaceId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.room.join.0",
        data: undefined,
      },
    });
  } catch (e) {
    console.error(e);
    toast.error("Could not join space. It's possible it does not exist.");
  }
}

// For global access to a ref on scrollable div
export const scrollContainerRef = writable<HTMLDivElement | null>(null);
