import { type LexiconDoc } from "@atproto/lexicon";

export const lexicons: LexiconDoc[] = [
  {
    lexicon: 1,
    id: "space.roomy.stream",
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
    id: "space.roomy.stream.dev",
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
    id: "space.roomy.stream.handle",
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
    id: "space.roomy.stream.handle.dev",
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
    id: "space.roomy.upload",
    defs: {
      main: {
        type: "object",
        required: ["image"],
        properties: {
          image: {
            type: "blob",
          },
          alt: { type: "string" },
        },
      },
    },
  },
];
