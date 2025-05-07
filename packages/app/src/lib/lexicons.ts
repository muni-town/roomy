import { type LexiconDoc } from "@atproto/lexicon";

export const lexicons: LexiconDoc[] = [
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
                type: "string",
              },
              privateKey: {
                type: "string",
              },
            },
          },
        },
      },
    },
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
              type: "string",
            },
          },
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              publicKey: { type: "string" },
            },
          },
        },
      },
    },
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
                type: "string",
              },
            },
            data: {
              type: "blob",
            },
          },
        },
      },
    },
  },

  {
    lexicon: 1,
    id: "chat.roomy.01JPNX7AA9BSM6TY2GWW1TR5V7.catalog",
    defs: {
      main: {
        type: "record",
        record: {
          type: "object",
          properties: {
            id: {
              type: "string",
            },
          },
        },
      },
    },
  },

  {
    lexicon: 1,
    id: "chat.roomy.v0.sync.token",
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
                type: "string",
              },
            },
          },
        },
      },
    },
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
            docId: { type: "string" },
          },
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            properties: {
              peers: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
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
            docId: { type: "string" },
          },
        },
        input: {
          encoding: "application/json",
          // TODO: input schema
        },
        output: {
          encoding: "application/json",
          // TODO: output schema
        },
      },
    },
  },
];
