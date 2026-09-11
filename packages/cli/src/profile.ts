import * as fs from "node:fs";
import type { Agent } from "@atproto/api";

export interface ProfileOptions {
  displayName?: string;
  description?: string;
  pronouns?: string;
  website?: string;
  /** Path to an image file to upload as the profile avatar (PNG/JPEG). */
  avatar?: string;
}

/**
 * Set (or update) the caller's Roomy profile by writing the
 * `space.roomy.user.profile/self` record on their PDS.
 */
export async function setProfile(
  agent: Agent,
  opts: ProfileOptions,
): Promise<void> {
  const record: Record<string, unknown> = {
    $type: "space.roomy.user.profile",
  };
  if (opts.displayName) record.displayName = opts.displayName;
  if (opts.description) record.description = opts.description;
  if (opts.pronouns) record.pronouns = opts.pronouns;
  if (opts.website) record.website = opts.website;
  if (opts.avatar) record.avatar = await uploadAvatar(agent, opts.avatar);

  await agent.com.atproto.repo.putRecord({
    collection: "space.roomy.user.profile",
    repo: agent.assertDid,
    rkey: "self",
    record,
  });
}

/** Upload a local image as an ATProto blob and return the blob ref for the profile record. */
async function uploadAvatar(agent: Agent, path: string): Promise<unknown> {
  const data = fs.readFileSync(path);
  const mimeType = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
  const resp = await agent.com.atproto.repo.uploadBlob(data, {
    headers: { "content-type": mimeType },
  });
  if (!resp.success) throw new Error("Avatar upload failed");
  return resp.data.blob;
}
