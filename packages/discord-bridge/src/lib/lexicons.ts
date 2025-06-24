import { type LexiconDoc } from "@atproto/lexicon";

export const lexicons: LexiconDoc[] = [
  {
    lexicon: 1,
    id: "chat.roomy.v1.passphrase",
    description: "Get your Jazz passpharase from the keyserver.",
    defs: {
      main: {
        type: "query",
        output: {
          encoding: "utf-8",
        },
      },
    },
  },
];
