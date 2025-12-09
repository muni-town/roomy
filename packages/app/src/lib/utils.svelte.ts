import type { DidDocument } from "@atproto/oauth-client-browser";
import { decodeBase32 } from "./utils/base32";
import { goto } from "$app/navigation";
import type { JSONContent } from "@tiptap/core";
import { writable } from "svelte/store";

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

// For global access to a ref on scrollable div
export const scrollContainerRef = writable<HTMLDivElement | null>(null);
