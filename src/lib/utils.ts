import type { DidDocument } from "@atproto/oauth-client-browser";
import type { Doc } from "@automerge/automerge";
import * as Automerge from "@automerge/automerge";
import { decodeBase32 } from "./base32";

/** Cleans a handle string by removing any characters not valid for a domain. */
export function cleanHandle(handle: string): string {
  return handle.replaceAll(/[^a-z0-9-\.]/gi, "");
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

export function unreadCount<Channel>(
  doc: Doc<Channel>,
  viewedHeads: Automerge.Heads,
): number {
  let count = 0;
  try {
    const patches = Automerge.diff(doc, viewedHeads, Automerge.getHeads(doc));
    for (const patch of patches) {
      if (
        patch.action == "put" &&
        patch.path.length == 2 &&
        patch.path[0] == "messages"
      ) {
        count += 1;
      }
    }
  } catch (e) {
    console.error("Error getting unread count:", e);
  }
  return count;
}
