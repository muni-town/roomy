import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import "@atproto/lexicon";
import "base32-encode";
import dec from "base32-decode";
function decodeBase32(data) {
  return new Uint8Array(dec(data, "Crockford"));
}
const scope = "atproto transition:generic transition:chat.bsky";
let oauth = void 0;
const atproto = {
  /** The scope required by the app when logging in. */
  scope,
  get oauth() {
    return oauth;
  },
  async init() {
    if (this.oauth) return;
    const baseUrl = new URL(globalThis.location.href);
    baseUrl.hash = "";
    baseUrl.pathname = "/";
    baseUrl.href + "oauth/callback";
    let clientMetadata;
    {
      const resp = await fetch("/oauth-client.json", {
        headers: [["accept", "application/json"]]
      });
      clientMetadata = await resp.json();
    }
    oauth = new BrowserOAuthClient({
      responseMode: "query",
      handleResolver: "https://resolver.roomy.chat",
      clientMetadata
    });
  }
};
const lexicons = [
  {
    lexicon: 1,
    id: "chat.roomy.v0.key",
    description: "Get your keypair from the keyserver.",
    defs: {
      main: {
        type: "query",
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              publicKey: {
                type: "string"
              },
              privateKey: {
                type: "string"
              }
            }
          }
        }
      }
    }
  },
  {
    lexicon: 1,
    id: "chat.roomy.v0.key.public",
    description: "Get the public for the given user from the keyserver.",
    defs: {
      main: {
        type: "query",
        parameters: {
          type: "params",
          properties: {
            did: {
              type: "string"
            }
          }
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              publicKey: { type: "string" }
            }
          }
        }
      }
    }
  },
  {
    lexicon: 1,
    id: "chat.roomy.v1.store",
    defs: {
      main: {
        type: "record",
        record: {
          type: "object",
          properties: {
            key: {
              type: "array",
              items: {
                type: "string"
              }
            },
            data: {
              type: "blob"
            }
          }
        }
      }
    }
  },
  {
    lexicon: 1,
    id: "chat.roomy.v0.router.token",
    description: "Get an auth token for connecting to the router.",
    defs: {
      main: {
        type: "query",
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              token: {
                type: "string"
              }
            }
          }
        }
      }
    }
  },
  {
    lexicon: 1,
    id: "chat.roomy.v0.space.sync.peers",
    defs: {
      main: {
        type: "query",
        parameters: {
          type: "params",
          properties: {
            docId: { type: "string" }
          }
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              peers: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  },
  {
    lexicon: 1,
    id: "chat.roomy.v0.space.update",
    defs: {
      main: {
        type: "procedure",
        parameters: {
          type: "params",
          properties: {
            docId: { type: "string" }
          }
        },
        input: {
          encoding: "application/json"
          // TODO: input schema
        },
        output: {
          encoding: "application/json"
          // TODO: output schema
        }
      }
    }
  }
];
let session = void 0;
let agent = void 0;
let profile = (() => {
  let data = void 0;
  if (session && agent) {
    agent.getProfile({ actor: agent.assertDid }).then((res) => {
      data = res.data;
    });
  }
  return {
    get data() {
      return data;
    }
  };
})();
let keypair = (() => {
  let value = void 0;
  if (session && agent) {
    agent.call("chat.roomy.v0.key", void 0, void 0, {
      headers: {
        "atproto-proxy": "did:web:keyserver.roomy.chat#roomy_keyserver"
      }
    }).then((resp) => {
      value = {
        publicKey: new Uint8Array(decodeBase32(resp.data.publicKey)),
        privateKey: new Uint8Array(decodeBase32(resp.data.privateKey))
      };
    });
  }
  return {
    get value() {
      return value;
    }
  };
})();
let storage = (() => {
  if (!session) return;
  const did = session.did;
  return new IndexedDBStorageAdapter(did, "autodoc");
})();
const user = {
  get agent() {
    return agent;
  },
  get session() {
    return session;
  },
  set session(newSession) {
    session = newSession;
    if (newSession) {
      localStorage.setItem("did", newSession.did);
      agent = new Agent(newSession);
      lexicons.forEach((l) => agent.lex.add(l));
    } else {
      agent = void 0;
      localStorage.removeItem("did");
    }
  },
  get profile() {
    return profile;
  },
  get storage() {
    return storage;
  },
  get keypair() {
    return keypair;
  },
  get repo() {
    return storage;
  },
  async init() {
    globalThis.user = this;
    await atproto.init();
    const storedDid = localStorage.getItem("did");
    if (!session && storedDid) {
      atproto.oauth.restore(storedDid).then((s) => this.session = s);
    }
  },
  async loginWithHandle(handle) {
    localStorage.setItem("redirectAfterAuth", window.location.pathname);
    const url = await atproto.oauth.authorize(handle, { scope: atproto.scope });
    window.location.href = url.href;
    await new Promise((_resolve, reject) => {
      setTimeout(reject, 1e4, new Error("User navigated back from the authorization page"));
    });
  },
  async uploadBlob(blob) {
    if (!agent) return Promise.reject("No agent available");
    const resp = await agent.com.atproto.repo.uploadBlob(blob);
    const blobRef = resp.data.blob;
    console.log(resp.data.blob.toJSON());
    const record = {
      $type: "chat.roomy.v0.images",
      image: blobRef,
      alt: "User uploaded image"
      // You might want to make this parameter configurable
    };
    const putResponse = await agent.com.atproto.repo.putRecord({
      repo: agent.did,
      collection: "chat.roomy.v0.images",
      rkey: `${Date.now()}`,
      // Using timestamp as a unique key
      record
    });
    const url = `https://cdn.bsky.app/img/feed_thumbnail/plain/${agent.did}/${blobRef.ipld().ref}`;
    return {
      blob: blobRef,
      uri: putResponse.data.uri,
      cid: putResponse.data.cid,
      url
    };
  },
  logout() {
    localStorage.removeItem("did");
    session = void 0;
  }
};
export {
  user as u
};
