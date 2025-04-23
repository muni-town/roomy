import type { DidDocument } from "@atproto/oauth-client-browser";
import { decodeBase32 } from "./base32";
import type { EntityIdStr } from "@muni-town/leaf";
import { goto } from "$app/navigation";
import type { JSONContent } from "@tiptap/core";

/** Cleans a handle string by removing any characters not valid for a domain. */
export function cleanHandle(handle: string): string {
  return handle.replaceAll(/[^a-z0-9-\.]/gi, "");
}

export type NavigationTarget =
  | "home"
  | { space: string; channel?: string; thread?: string; wiki?: string };

/** A helper function to navigate to a specific roomy object, like a space, channel, or thread */
export function navigate(target: NavigationTarget) {
  if (target == "home") {
    goto("/home");
  } else if ("space" in target) {
    let url = ``;
    if (target.space.includes(".")) {
      url += "/-";
    }
    url += `/${target.space}`;
    if (target.channel) {
      url += `/${target.channel}`;
    } else if (target.thread) {
      url += `/thread/${target.thread}`;
    } else if (target.wiki) {
      url += `/wiki/${target.wiki}`;
    }
    goto(url);
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
): Promise<EntityIdStr | undefined> {
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
      console.error('Error parsing message JSON:', e);
      return {};
    }
  }



/**
 * Helper that allows you to do something similar to the `$derive` rune but for a function returning
 * a promise.
 *
 * @param default_value The initial value to set the reactive state to before the promise has
 * resolved.
 * @param get A reactive closure that returns a promise with the target value. This will be re-run
 * if any reactive state that it depends on has changed, just like `$derive`.
 * */
export function derivePromise<T>(
  default_value: T,
  get: () => Promise<T>,
): {
  /** Accessor for the inner, reactive value. */
  value: T;
} {
  let state = $state({ value: default_value });
  $effect(() => {
    get().then((v) => {
      state.value = v;
    });
  });
  return state;
}

// export function unreadCount<Channel>(
//   doc: Doc<Channel>,
//   viewedHeads: Automerge.Heads,
// ): number {
//   let count = 0;
//   try {
//     const patches = Automerge.diff(doc, viewedHeads, Automerge.getHeads(doc));
//     for (const patch of patches) {
//       if (
//         patch.action == "put" &&
//         patch.path.length == 2 &&
//         patch.path[0] == "messages"
//       ) {
//         count += 1;
//       }
//     }
//   } catch (e) {
//     console.error("Error getting unread count:", e);
//   }
//   return count;
// }
