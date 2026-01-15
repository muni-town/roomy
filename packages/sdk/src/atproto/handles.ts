import type { Agent } from "@atproto/api";
import { Did, Handle, UserDid, type } from "../schema";

/** Resolve a handle to a DID via ATProto. */
export async function resolveDidFromHandle(
  agent: Agent,
  handle: Handle
): Promise<UserDid> {
  const profile = await agent.getProfile({ actor: handle });
  return profile.data.did as UserDid;
}

/** Check if a string is a DID or handle. */
export function parseIdentifier(
  value: string
): { type: "did"; did: Did } | { type: "handle"; handle: Handle } {
  const didParsed = Did(value);
  if (!(didParsed instanceof type.errors)) {
    return { type: "did", did: didParsed };
  }
  const handleParsed = Handle(value);
  if (!(handleParsed instanceof type.errors)) {
    return { type: "handle", handle: handleParsed };
  }
  throw new Error(`Invalid identifier: ${value}`);
}

/** Create a cached handle resolver. */
export function createHandleResolver(agent: Agent) {
  const cache = new Map<Handle, UserDid>();

  return async (handle: Handle): Promise<UserDid> => {
    const cached = cache.get(handle);
    if (cached) return cached;

    const did = await resolveDidFromHandle(agent, handle);
    cache.set(handle, did);
    return did;
  };
}
