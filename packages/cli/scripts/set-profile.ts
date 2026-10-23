/**
 * One-off: set the caller's Roomy profile avatar (+ optional display name).
 *
 * Self-contained (only needs @atproto/api, a CLI dependency — no SDK
 * import), so workers can run it from any checkout that has the CLI
 * installed. Fetches the avatar image itself from AVATAR_URL.
 *
 * Usage (from packages/cli):
 *   export $(grep -vE '^\s*#|^\s*$' .env | xargs)
 *   AVATAR_URL=<raw image url> DISPLAY_NAME=<name> npx tsx scripts/set-profile.ts
 */
import { AtpAgent } from "@atproto/api";

const identifier = process.env.ATPROTO_IDENTIFIER ?? "";
const password = process.env.ATPROTO_APP_PASSWORD ?? "";
const avatarUrl = process.env.AVATAR_URL ?? "";
const displayName = process.env.DISPLAY_NAME ?? "";

/** Resolve the account's PDS from its DID document (same logic as cli/auth.ts). */
async function resolvePds(identifier: string): Promise<string> {
  const did = identifier.startsWith("did:")
    ? identifier
    : ((
        await (
          await fetch(
            `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`,
          )
        ).json()
      ).did as string | undefined) ?? "";
  const doc = (await (
    await fetch(`https://plc.directory/${encodeURIComponent(did)}`)
  ).json()) as { service?: { type?: string; serviceEndpoint?: string }[] };
  const pds = doc.service?.find((s) => s.type === "AtprotoPersonalDataServer");
  return pds?.serviceEndpoint ?? "https://bsky.social";
}

async function main(): Promise<void> {
  if (!identifier || !password) {
    throw new Error("ATPROTO_IDENTIFIER / ATPROTO_APP_PASSWORD required (export from packages/cli/.env)");
  }
  if (!avatarUrl) throw new Error("AVATAR_URL required");

  const pds = await resolvePds(identifier);
  const agent = new AtpAgent({ service: pds });
  await agent.login({ identifier, password });
  const did = agent.assertDid;
  console.log(`logged in as ${did} via ${pds}`);

  const resp = await fetch(avatarUrl);
  if (!resp.ok) throw new Error(`avatar download failed: ${resp.status} ${resp.statusText}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 1000000) {
    throw new Error(`avatar byte size out of range (1MB limit): ${bytes.length}`);
  }

  const upload = await agent.com.atproto.repo.uploadBlob(bytes);
  const blob = upload.data.blob;
  // Wire form of the blob ref (matches what the SDK/putRecord accept).
  const avatar = {
    $type: "blob",
    ref: { $link: blob.ref.toString() },
    mimeType: blob.mimeType,
    size: blob.size,
  };

  const record: Record<string, unknown> = {
    $type: "space.roomy.user.profile",
    avatar,
  };
  if (displayName) record.displayName = displayName;

  await agent.com.atproto.repo.putRecord(
    { collection: "space.roomy.user.profile", repo: did, rkey: "self", record },
    { headers: { "atproto-proxy": `${did}#atproto_pds` } },
  );
  console.log(
    `Profile updated for ${did}: displayName=${displayName || "(unchanged)"}, avatar=${avatar.ref.$link} (${blob.size} bytes)`,
  );
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
