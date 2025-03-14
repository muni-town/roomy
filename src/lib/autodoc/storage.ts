import type { Doc } from "@automerge/automerge";
// import { next as Automerge } from "@automerge/automerge";
import { encodeBase32 } from "../base32";
import { decrypt, encrypt } from "./encryption";

/** Concatenate Uint8Arrays */
function concat(uint8arrays: Uint8Array[]) {
  const totalLength = uint8arrays.reduce(
    (total, uint8array) => total + uint8array.byteLength,
    0,
  );
  const result = new Uint8Array(totalLength);
  let offset = 0;
  uint8arrays.forEach((uint8array) => {
    result.set(uint8array, offset);
    offset += uint8array.byteLength;
  });
  return result;
}

/** Get the sha256 hash of the given data. */
async function sha256Base32(data: Uint8Array): Promise<string> {
  return encodeBase32(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))),
  );
}

type StorageKey = string[];
export interface StorageInterface {
  load(key: StorageKey): Promise<Uint8Array | undefined>;
  save(key: StorageKey, data: Uint8Array): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  loadRange(
    key: StorageKey,
  ): Promise<{ key: StorageKey; data: Uint8Array | undefined }[]>;
  removeRange(key: StorageKey): Promise<void>;
}

type ChunkInfo = {
  kind: "snapshot" | "incremental";
  hash: string;
  size: number;
};
type Chunk = { data: Uint8Array } & ChunkInfo;

export class StorageManager {
  /** The backing storage interface for this storage manager. */
  storage: StorageInterface;

  constructor(storage: StorageInterface) {
    this.storage = storage;
  }

  /** The chunks that we most-recently loaded from storage. */
  loadedChunks: ChunkInfo[] = [];
  /** The heads that we most-recently loaded from storage. */
  loadedHeads: Automerge.Heads = [];

  async loadFromStorage<T>(): Promise<Doc<T> | undefined> {
    // Load chunks from storage
    const chunks: Chunk[] = (await this.storage.loadRange(["data"]))
      .filter((x) => !!x.data)
      .map(({ key, data }) => {
        return {
          kind: key[key.length - 2] == "snapshot" ? "snapshot" : "incremental",
          hash: key[key.length - 1],
          size: data!.length,
          data: data!,
        };
      });

    // Concatenate the fragments
    let binary = concat(chunks.map((x) => x.data));

    // If there is no data, just return the old doc;
    if (binary.length == 0) return;

    // Load the doc data from storage
    const loadedDoc = Automerge.loadIncremental<any>(Automerge.init(), binary);

    // Update loaded chunks & heads
    this.loadedChunks = chunks.map((x) => ({ ...x, data: undefined }));
    this.loadedHeads = Automerge.getHeads(loadedDoc);

    // Return the loaded doc
    return loadedDoc;
  }

  async saveToStorage<T>(doc: Doc<T>) {
    if (!this.storage) return;

    // NOTE: copying the loaded chunks, immediately at the time of triggering the save, is very
    // important to make sure that a concurrent call to loadFromStorage doesn't change the loaded
    // chunks and cause us to delete chunks that we have just loaded and not included in the data
    // being saved in this function.
    let toDelete = [...this.loadedChunks];

    // Get the heads of the current version of the document
    const heads = Automerge.getHeads(doc);

    // Check whether the current version is newer than the last version we loaded from storage.
    const needsSave = Automerge.diff(doc, this.loadedHeads, heads).length > 0;

    // Skip saving if it's already up-to-date
    if (!needsSave) {
      return;
    }

    // Export and hash the document
    const binary = Automerge.save(doc);

    // TODO: do we only need to hash the document heads and not the binary data?
    const hash = await sha256Base32(binary);

    // Just in case, make sure we don't delete the file we're about to create.
    toDelete = toDelete.filter((x) => x.hash !== hash);

    // Safe the document to storage
    await this.storage.save(["data", "snapshot", hash], binary);

    // Delete previously loaded chunks that we no longer need from storage
    for (const chunk of toDelete) {
      await this.storage!.remove(["data", chunk.kind, chunk.hash]);
    }

    // Update our list of loaded chunks to the snapshot we just exported.
    this.loadedChunks = [
      {
        hash,
        kind: "snapshot",
        size: binary.length,
      },
    ];
    this.loadedHeads = heads;
  }
}

/** Takes a storage adapter and creates a sub-adapter by with the given namespace. */
export function namespacedSubstorage(
  storage: StorageInterface,
  ...namespaces: string[]
): StorageInterface {
  return {
    load(key) {
      return storage.load([...namespaces, ...key]);
    },
    async loadRange(key) {
      const result = await storage.loadRange([...namespaces, ...key]);
      return result.map((x) => ({
        key: x.key.slice(namespaces.length),
        data: x.data,
      }));
    },
    remove(key) {
      return storage.remove([...namespaces, ...key]);
    },
    removeRange(key) {
      return storage.removeRange([...namespaces, ...key]);
    },
    save(key, value) {
      return storage.save([...namespaces, ...key], value);
    },
  };
}

/** Takes a storage adapter and creates a sub-adapter that encrypts the contents with the given key. */
export function encryptedStorage(
  encryptionKey: Uint8Array,
  storage: StorageInterface,
): StorageInterface {
  return {
    async load(key) {
      const encrypted = await storage.load(key);
      return encrypted && decrypt(encryptionKey, encrypted);
    },
    async loadRange(key) {
      const result = await storage.loadRange(key);
      return result.map((x) => ({
        key: x.key,
        data: x.data && decrypt(encryptionKey, x.data),
      }));
    },
    remove(key) {
      return storage.remove(key);
    },
    removeRange(key) {
      return storage.removeRange(key);
    },
    save(key, value) {
      return storage.save(key, encrypt(encryptionKey, value));
    },
  };
}
