/**
 * The OAuth session, kept in the shell's native store as well as in the
 * webview's.
 *
 * `@atproto/oauth-client-browser` keeps the session in its own IndexedDB
 * database and has no seam for another store: `BrowserOAuthClient` builds that
 * database itself and passes the resulting stores to `OAuthClient` after the
 * caller's options, so an injected store is overwritten. What it does expose is
 * the `onUpdate`/`onDelete` hooks and the store itself, reachable through the
 * session getter ({@link clientSessionStore}); those are enough for a second
 * copy:
 *
 *   - every write and delete the client makes is mirrored into the shell's
 *     native store (a JSON file in the app's data directory, outside the
 *     webview), and
 *   - before `init()` runs, that copy is written back into the client's own
 *     session store, so a launch whose IndexedDB was evicted still restores.
 *
 * Only a shell supplies a store; a web build supplies none and nothing here
 * runs.
 *
 * The DPoP key is why this is more than a copy. The session holds a
 * `CryptoKeyPair`, which IndexedDB stores by structured clone, and the client
 * generates it non-extractable — so it cannot be exported as JWK and a naive
 * JSON copy of the session loses the one part that signs requests. The
 * `@atproto/oauth-client-browser` patch in `patches/` makes that optional: the
 * patched runtime honours `globalThis.__ROOMY_EXPORTABLE_DPOP_KEY__`, which
 * {@link enableExportableDpopKeys} raises for a shell that holds a mirror. Keys
 * stay non-extractable everywhere else.
 *
 * The store is injected, never opened here: this package has no dependency on
 * the plugin (see `tauri-store-persister.ts`), and the shell is the only thing
 * that can reach it. Every operation degrades rather than throws — a store that
 * is missing, unreadable or holding an unusable snapshot leaves startup exactly
 * where it was without one.
 *
 * What a launch found is also written back beside the session, under its own
 * key: whether a session was restored, whether the shell's copy was there, and
 * the name of the error `init()` raised. A shell has no log sink a tester can
 * read, so those facts are kept where the app can show them.
 */
import {
  WebcryptoKey,
  type OAuthSession,
  type Session,
  type SessionStore,
} from "@atproto/oauth-client-browser";
import type { Diagnostic } from "../cache/persister";
import type { TauriStoreLike } from "./tauri-store-persister";

/** The store key. One client, one session, so one key. */
export const NATIVE_SESSION_KEY = "roomy-oauth-session";

/**
 * The key the last launch's outcome is kept under. A key of its own, beside
 * the session rather than inside it: the record has to outlive a sign-out, and
 * it holds no token, key or DID.
 */
export const NATIVE_AUTH_DIAGNOSTIC_KEY = "roomy-auth-diagnostics";

/**
 * Snapshot format version. A record stamped with another version is discarded:
 * the shape below is this module's, not a dependency's, so it can change.
 */
const SNAPSHOT_VERSION = 1;

/**
 * How long a hook may wait for the store before the OAuth client is released.
 *
 * The hooks are awaited inside the client's `setStored`/`delStored`, so an IPC
 * call that never answers would hold a token refresh — or a sign-out, which the
 * app follows with a reload — forever. The plugin answered `load` within the
 * shell's open bound (2s, `cache-store.ts`), so a write that takes longer than
 * this has stopped answering; the client proceeds and the write stays queued.
 */
const WRITE_BOUND_MS = 5_000;

/** The DPoP key, as the two JWKs a `CryptoKeyPair` needs to be rebuilt. */
export interface SerializedDpopKey {
  kid: string;
  alg: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/**
 * What the shell keeps. JSON-shaped throughout: the store serialises through
 * JSON, and nothing in the session is a structured-clone object once the key
 * pair is exported.
 */
export interface NativeSessionSnapshot {
  version: number;
  sub: string;
  dpopKey: SerializedDpopKey;
  authMethod: unknown;
  tokenSet: Record<string, unknown>;
}

/**
 * What one launch found, as the shell keeps it. Fixed shape on purpose: there
 * is nowhere in it to put a token, a key or a DID, so a record copied off a
 * tester's phone is safe to paste into a chat.
 */
export interface NativeAuthDiagnostic {
  version: number;
  /** ISO timestamp of the launch that wrote it. */
  at: string;
  /** Whether the client came up with a session. */
  session: boolean;
  /** Whether the shell's own copy of the session was in the store. */
  nativeSnapshot: boolean;
  /** The `name` of the error `init()` raised, or `null`. */
  initError: string | null;
}

const DIAGNOSTIC_VERSION = 1;

/** The `name` of an error, which is the part that identifies the failure mode. */
function errorName(error: unknown): string | null {
  if (error === undefined) return null;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Keep one launch's outcome, for a tester to read back from the app. Never
 * throws: a store that will not take a diagnostic is not a reason to fail a
 * launch.
 */
export async function recordLaunchDiagnostic(
  store: TauriStoreLike | null | undefined,
  facts: { session: boolean; nativeSnapshot: boolean; error?: unknown },
): Promise<void> {
  if (!store) return;
  const record: NativeAuthDiagnostic = {
    version: DIAGNOSTIC_VERSION,
    at: new Date().toISOString(),
    session: facts.session,
    nativeSnapshot: facts.nativeSnapshot,
    initError: errorName(facts.error),
  };
  try {
    await store.set(NATIVE_AUTH_DIAGNOSTIC_KEY, record);
    await store.save();
  } catch {
    // Nothing to do: the console line has already been emitted.
  }
}

/**
 * The last launch's outcome, or `null` when the shell has not recorded one
 * (a web build, a store that will not open, or a first launch).
 */
export async function readAuthDiagnostic(
  store: TauriStoreLike | null | undefined,
): Promise<NativeAuthDiagnostic | null> {
  if (!store) return null;
  try {
    const raw = await store.get(NATIVE_AUTH_DIAGNOSTIC_KEY);
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Partial<NativeAuthDiagnostic>;
    if (record.version !== DIAGNOSTIC_VERSION) return null;
    if (typeof record.at !== "string") return null;
    if (typeof record.session !== "boolean") return null;
    if (typeof record.nativeSnapshot !== "boolean") return null;
    if (
      record.initError !== null &&
      typeof record.initError !== "string"
    )
      return null;
    return record as NativeAuthDiagnostic;
  } catch {
    return null;
  }
}

/** Whether the store holds a session snapshot at all, readable or not. */
export async function nativeSnapshotPresent(
  store: TauriStoreLike | null | undefined,
): Promise<boolean> {
  if (!store) return false;
  try {
    const raw = await store.get(NATIVE_SESSION_KEY);
    return raw !== undefined && raw !== null;
  } catch {
    return false;
  }
}

/** The import parameters for the algorithms a DPoP key can be generated with. */
const IMPORT_ALGORITHMS: Record<
  string,
  EcKeyImportParams | RsaHashedImportParams | Algorithm
> = {
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  ES384: { name: "ECDSA", namedCurve: "P-384" },
  ES512: { name: "ECDSA", namedCurve: "P-521" },
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  RS384: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
  RS512: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
  PS256: { name: "RSA-PSS", hash: "SHA-256" },
  PS384: { name: "RSA-PSS", hash: "SHA-384" },
  PS512: { name: "RSA-PSS", hash: "SHA-512" },
  EdDSA: { name: "Ed25519" },
  Ed25519: { name: "Ed25519" },
};

/**
 * Let the client generate exportable DPoP keys, so a shell holding a mirror can
 * snapshot them. Set once, before the client is constructed: the key is created
 * during `authorize()` and never re-keyable afterwards — nothing else in the
 * process may turn this on.
 */
export function enableExportableDpopKeys(): void {
  globalThis.__ROOMY_EXPORTABLE_DPOP_KEY__ = true;
}

/** The session as the shell's store holds it. Throws when the key is unexportable. */
export async function toSnapshot(
  sub: string,
  session: Session,
): Promise<NativeSessionSnapshot> {
  const key = session.dpopKey;
  if (!(key instanceof WebcryptoKey)) {
    throw new TypeError("auth: the session's DPoP key is not a WebcryptoKey");
  }
  const { privateKey, publicKey } = key.cryptoKeyPair;
  if (!privateKey.extractable) {
    throw new TypeError(
      "auth: the session's DPoP key is not exportable; it cannot be mirrored " +
        "(the client must be built with `enableExportableDpopKeys()`)",
    );
  }
  const kid = key.jwk.kid;
  if (!kid) throw new TypeError("auth: the session's DPoP key has no kid");

  return {
    version: SNAPSHOT_VERSION,
    sub,
    authMethod: session.authMethod,
    tokenSet: session.tokenSet as unknown as Record<string, unknown>,
    dpopKey: {
      kid,
      alg: key.alg,
      privateJwk: await crypto.subtle.exportKey("jwk", privateKey),
      publicJwk: await crypto.subtle.exportKey("jwk", publicKey),
    },
  };
}

/**
 * Rebuild a session from its snapshot: the key pair is re-imported as
 * extractable (so the next write can export it again) and wrapped in the
 * `WebcryptoKey` the client signs with.
 */
export async function fromSnapshot(
  snapshot: NativeSessionSnapshot,
): Promise<Session> {
  const { alg, kid, privateJwk, publicJwk } = snapshot.dpopKey;
  const algorithm = IMPORT_ALGORITHMS[alg];
  if (!algorithm) throw new TypeError(`unsupported DPoP algorithm "${alg}"`);

  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", privateJwk, algorithm, true, ["sign"]),
    crypto.subtle.importKey("jwk", publicJwk, algorithm, true, ["verify"]),
  ]);

  return {
    dpopKey: await WebcryptoKey.fromKeypair({ privateKey, publicKey }, kid),
    authMethod: snapshot.authMethod,
    tokenSet: snapshot.tokenSet,
  } as unknown as Session;
}

/**
 * Read a value from the store back into a snapshot, or `null` when it is not
 * one. Everything is checked here rather than attempted later: the client
 * rejects a session whose token set names another sub, and it is cheaper to
 * start cold than to find that out mid-restore.
 */
function readSnapshot(raw: unknown): NativeSessionSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const snapshot = raw as Partial<NativeSessionSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) return null;
  if (typeof snapshot.sub !== "string" || snapshot.sub === "") return null;
  if (typeof snapshot.tokenSet !== "object" || snapshot.tokenSet === null)
    return null;
  if (snapshot.tokenSet.sub !== snapshot.sub) return null;

  const key = snapshot.dpopKey;
  if (typeof key !== "object" || key === null) return null;
  if (typeof key.kid !== "string" || key.kid === "") return null;
  if (typeof key.alg !== "string") return null;
  if (typeof key.privateJwk !== "object" || key.privateJwk === null) return null;
  if (typeof key.publicJwk !== "object" || key.publicJwk === null) return null;

  return snapshot as NativeSessionSnapshot;
}

export interface NativeSessionMirrorOptions {
  /**
   * The shell's store, or `null` when it has none it could open. Absent is the
   * same thing: no store, no mirror.
   */
  store?: TauriStoreLike | null;
  /** Key inside the store. Distinct from the cache's. */
  key?: string;
  /** Diagnostic sink. Silent by default. */
  onDiagnostic?: Diagnostic;
}

/**
 * The second copy of the session, and the hooks that keep it current.
 *
 * Writes are queued, so a refresh that lands while an earlier write is still in
 * flight cannot be overtaken by it, and every write ends with an explicit
 * `save()` — the plugin's own autosave is a debounce, and a debounce that has
 * not fired when the process goes away has persisted nothing.
 */
export class NativeSessionMirror {
  private readonly store: TauriStoreLike | null;
  private readonly key: string;
  /** Diagnostic sink for everything this mirror discards or fails to write. */
  readonly report: Diagnostic;
  private writes: Promise<void> = Promise.resolve();
  /** Whether the last {@link load} found a snapshot, usable or not. */
  private snapshotPresent = false;

  /** The hooks the client is constructed with; see {@link NativeSessionMirror.hooks}. */
  readonly hooks: {
    onUpdate: (sub: string, session: Session) => Promise<void>;
    onDelete: (sub: string) => Promise<void>;
  };

  constructor(opts: NativeSessionMirrorOptions = {}) {
    this.store = opts.store ?? null;
    this.key = opts.key ?? NATIVE_SESSION_KEY;
    this.report = opts.onDiagnostic ?? (() => {});
    this.hooks = {
      onUpdate: (sub, session) => this.save(sub, session),
      onDelete: () => this.clear(),
    };
  }

  /** True when the shell supplied a native store. */
  get available(): boolean {
    return this.store !== null;
  }

  /**
   * The session the store holds, or `null` when it holds nothing usable.
   *
   * A snapshot that cannot be read back — another version, a missing field, a
   * token set naming another sub, a key the platform will not import — is
   * discarded rather than retried on every launch, and startup proceeds as if
   * there were none.
   */
  async load(): Promise<Session | null> {
    this.snapshotPresent = false;
    const store = this.store;
    if (!store) return null;

    let raw: unknown;
    try {
      raw = await store.get(this.key);
    } catch (err) {
      this.report("auth: reading the native session failed", err);
      return null;
    }
    if (raw === undefined || raw === null) return null;
    this.snapshotPresent = true;

    const snapshot = readSnapshot(raw);
    if (!snapshot) {
      this.report("auth: the native session snapshot is not readable");
      await this.clear();
      return null;
    }
    try {
      return await fromSnapshot(snapshot);
    } catch (err) {
      this.report("auth: the native session snapshot could not be restored", err);
      await this.clear();
      return null;
    }
  }

  /**
   * Put the stored session into a client's own session store, and return its
   * `sub` — the key the client restores by. Never throws.
   */
  async seed(sessionStore: SessionStore): Promise<string | null> {
    const session = await this.load();
    if (!session) return null;
    const sub = session.tokenSet.sub;
    try {
      await sessionStore.set(sub, session);
      return sub;
    } catch (err) {
      this.report("auth: seeding the client's session store failed", err);
      return null;
    }
  }

  /**
   * Mirror a session. Awaited by the client's `setStored`, so the new refresh
   * token is on disk before the old one is spent on a later launch; it still
   * never rejects — a rejected hook reads to the client as a failed store and
   * revokes a session that is fine.
   */
  async save(sub: string, session: Session): Promise<void> {
    const store = this.store;
    if (!store) return;
    await this.bounded(async () => {
      const snapshot = await toSnapshot(sub, session);
      await store.set(this.key, snapshot);
      await store.save();
    }, "auth: writing the native session failed");
  }

  /** Forget the session. Awaited by `delStored`, so a sign-out is durable. */
  async clear(): Promise<void> {
    const store = this.store;
    if (!store) return;
    await this.bounded(async () => {
      await store.delete(this.key);
      await store.save();
    }, "auth: clearing the native session failed");
  }

  /**
   * One record per launch, naming what session restore found. The two ways a
   * session is lost look identical to the user and are fixed differently:
   * nothing left to restore (the webview's storage was evicted) versus a
   * session that was there and could not be used (a token error, which
   * `error-recovery.ts` handles). No token, key or DID is logged.
   *
   * The same facts go to the store as well as the diagnostic sink: a shell has
   * no log a tester can read, and the app shows this record on its sign-in and
   * error screens. Awaited, so the record is on disk before the UI that reads
   * it appears.
   */
  async reportStartup({
    session,
    error,
  }: {
    session: boolean;
    error?: unknown;
  }): Promise<void> {
    this.report(
      `auth: session present=${session ? "yes" : "no"} native snapshot=${this.snapshotPresent ? "yes" : "no"} init error=${errorName(error) ?? "none"}`,
    );
    await recordLaunchDiagnostic(this.store, {
      session,
      nativeSnapshot: this.snapshotPresent,
      error,
    });
  }

  /** Queue a write, wait for it at most {@link WRITE_BOUND_MS}. Never rejects. */
  private async bounded(
    write: () => Promise<void>,
    failure: string,
  ): Promise<void> {
    this.writes = this.writes.then(async () => {
      try {
        await write();
      } catch (err) {
        this.report(failure, err);
      }
    });
    const queued = this.writes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        queued,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, WRITE_BOUND_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * The slice of the browser OAuth client {@link restoreNativeSession} needs.
 * Declared structurally so the ordering it enforces can be asserted without
 * constructing a real client (which needs IndexedDB and a network).
 */
export interface NativeSessionClient {
  init(): Promise<{ session: OAuthSession } | undefined>;
  restore(sub: string): Promise<OAuthSession>;
}

/**
 * The store a `@atproto/oauth-client` client reads its session from.
 *
 * The client takes the store as an option and hands it straight to a
 * `SessionGetter`; it is never assigned to the client itself, and the getter is
 * `protected` in the types. The getter's own `store` is public, which makes it
 * the one handle on the store that decides whether a session restores — and
 * hence the only place a session that is not in it can be put back.
 *
 * `null` when the handle is gone (a dependency changed its shape): that is a
 * cold start, not a failed launch.
 */
export function clientSessionStore(client: unknown): SessionStore | null {
  const store = (client as { sessionGetter?: { store?: SessionStore } })
    .sessionGetter?.store;
  return store ?? null;
}

/**
 * `client.init()`, with the stored session seeded first.
 *
 * The seed has to happen before `init()` because the client restores only what
 * is in its own store; it has to be the stored `sub` because that is the key
 * the client looks itself up by. `init()` still runs afterwards rather than
 * being replaced: it is what processes an OAuth callback, and the seeded row is
 * what makes its own restore path work when the sub it recorded in
 * `localStorage` survived but the IndexedDB row did not.
 *
 * When neither did — `init()` finds no session — the snapshot is restored
 * directly, keyed by its own `sub`, which is the case this module exists for.
 * A restore that fails is the client's own verdict on the session (a refresh
 * token rejected, a revoked grant); the client has already deleted it and
 * fired `onDelete`, so the snapshot is gone with it, and the error propagates
 * to the app's existing recovery path unchanged.
 */
export async function restoreNativeSession(
  client: NativeSessionClient,
  sessionStore: SessionStore | null,
  mirror: NativeSessionMirror,
): Promise<{ session: OAuthSession } | undefined> {
  let sub: string | null = null;
  if (sessionStore) {
    sub = await mirror.seed(sessionStore);
  } else {
    mirror.report("auth: the client's session store is unreachable; starting cold");
  }
  try {
    const result = await client.init();
    if (result?.session) {
      await mirror.reportStartup({ session: true });
      return result;
    }
    if (sub) {
      const session = await client.restore(sub);
      await mirror.reportStartup({ session: true });
      return { session };
    }
    await mirror.reportStartup({ session: false });
    return undefined;
  } catch (err) {
    await mirror.reportStartup({ session: false, error: err });
    throw err;
  }
}
