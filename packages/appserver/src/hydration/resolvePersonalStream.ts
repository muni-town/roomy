/**
 * Resolve a user DID → personal-stream DID via the user's PDS.
 *
 * The mapping lives as a record at `<collection>/<schemaVersion>` in the
 * user's repo (see SDK's `getPersonalStreamId`). We hit the PDS directly,
 * unauthenticated — `com.atproto.repo.getRecord` is public for public repos.
 *
 * The resolved mapping is cached in `comp_user_personal_stream`; the PDS
 * record is meant to be stable per user, so no TTL.
 */

import type { DbLike } from "../db/types.ts";
import { AtpAgent } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { StreamDid, type, type UserDid } from "@roomy-space/sdk";
import { getStreamManager } from "../streams/StreamManager.ts";

const PERSONAL_STREAM_NSID =
  process.env.APPSERVER_PERSONAL_STREAM_NSID ??
  "space.roomy.space.personal.dev";
const PERSONAL_STREAM_SCHEMA_VERSION =
  process.env.APPSERVER_PERSONAL_STREAM_SCHEMA_VERSION ?? "4";
const PLC_DIRECTORY_URL =
  process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";

const idResolver = new IdResolver({ plcUrl: PLC_DIRECTORY_URL });

export class PersonalStreamRecordNotFound extends Error {
  constructor(userDid: string) {
    super(`Personal-stream record not found for ${userDid}`);
    this.name = "PersonalStreamRecordNotFound";
  }
}

export interface ResolveOpts {
  /** Override the IdResolver (tests). */
  resolveDid?: (did: string) => Promise<{ pdsEndpoint: string }>;
  /** Override the PDS getRecord call (tests). */
  fetchRecord?: (
    pdsEndpoint: string,
    repo: string,
  ) => Promise<{ id?: unknown } | null>;
}

/**
 * Cache lookup → returns the cached personal stream DID if we have one.
 */
export async function readCachedPersonalStreamDid(
  db: DbLike,
  userDid: UserDid,
): Promise<StreamDid | undefined> {
  const row = await db
    .query("select personal_stream_did from comp_user_personal_stream where user_did = ?")
    .get<{ personal_stream_did: string }>(userDid);
  if (!row) return undefined;
  const parsed = StreamDid(row.personal_stream_did);
  if (parsed instanceof type.errors) return undefined;
  return parsed;
}

/** Persist a resolved mapping. Idempotent; later writes overwrite. */
async function writeCachedPersonalStreamDid(
  db: DbLike,
  userDid: UserDid,
  streamDid: string,
): Promise<void> {
  await db.run(
    "insert into comp_user_personal_stream (user_did, personal_stream_did, resolved_at) " +
      "values (?, ?, ?) on conflict(user_did) do update set " +
      "personal_stream_did = excluded.personal_stream_did, " +
      "resolved_at = excluded.resolved_at",
    [userDid, streamDid, Date.now()],
  );
}

/**
 * Create a new personal stream locally, cache the mapping, and return the
 * new stream DID.
 *
 * The appserver has authority to create streams (via StreamManager), but
 * cannot write the PDS record on the user's behalf. The caller should
 * return the new DID to the client so it can save the record.
 */
export async function createAndCachePersonalStream(
  db: DbLike,
  userDid: UserDid,
): Promise<StreamDid> {
  const streamManager = getStreamManager();
  const streamDid = await streamManager.createStream(userDid);

  await writeCachedPersonalStreamDid(db, userDid, streamDid);
  return streamDid;
}

/**
 * Resolve userDid → personal stream DID. Cache hit returns immediately.
 * On miss, walk DID → PDS endpoint → getRecord, then cache.
 *
 * Throws `PersonalStreamRecordNotFound` if the user has no personal-stream
 * record on their PDS (e.g. they've never logged into Roomy).
 */
export async function resolvePersonalStreamDid(
  db: DbLike,
  userDid: UserDid,
  opts: ResolveOpts = {},
): Promise<StreamDid> {
  const cached = await readCachedPersonalStreamDid(db, userDid);
  if (cached) return cached;

  const pdsEndpoint = await (opts.resolveDid ?? defaultResolveDid)(
    userDid,
  ).then((r) => r.pdsEndpoint);

  const record = await (opts.fetchRecord ?? defaultFetchRecord)(
    pdsEndpoint,
    userDid,
  );
  if (!record) throw new PersonalStreamRecordNotFound(userDid);

  const id = (record as { id?: unknown }).id;
  if (typeof id !== "string") throw new PersonalStreamRecordNotFound(userDid);

  const parsed = StreamDid(id);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Personal-stream record for ${userDid} has invalid DID: ${id}`,
    );
  }

  await writeCachedPersonalStreamDid(db, userDid, parsed);
  return parsed;
}

async function defaultResolveDid(
  did: string,
): Promise<{ pdsEndpoint: string }> {
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`Could not resolve DID document for ${did}`);
  const pds = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!pds || typeof pds.serviceEndpoint !== "string") {
    throw new Error(`No #atproto_pds service in DID document for ${did}`);
  }
  return { pdsEndpoint: pds.serviceEndpoint };
}

async function defaultFetchRecord(
  pdsEndpoint: string,
  repo: string,
): Promise<{ id?: unknown } | null> {
  const agent = new AtpAgent({ service: pdsEndpoint });
  try {
    const resp = await agent.com.atproto.repo.getRecord({
      repo,
      collection: PERSONAL_STREAM_NSID,
      rkey: PERSONAL_STREAM_SCHEMA_VERSION,
    });
    return resp.data.value as { id?: unknown };
  } catch (err) {
    if ((err as { error?: string }).error === "RecordNotFound") return null;
    throw err;
  }
}
