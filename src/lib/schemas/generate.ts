// deno-lint-ignore-file no-unused-vars

import * as Automerge from "npm:@automerge/automerge";
import type { Catalog, Channel } from "./types.ts";

async function exportSchema<T>(name: string, init: (doc: T) => void) {
  const doc = Automerge.init<T>({
    actor: "init"
      .split("")
      .map((x) => x.charCodeAt(0).toString(16))
      .join(""),
  });
  const initDoc = Automerge.change(doc, init);
  const initDocData = Automerge.save(initDoc);
  await Deno.writeFile(`./src/lib/schemas/${name}.bin`, initDocData);
}

// NOTE: we use this file to schema initializers for automerge documents. You can run `deno run
// generate-schemas` to run this generator and create a schema file.
//
// The code below is commented out because it is a **breaking change** to re-generate a schema.
//
// Even with the same code the initial schema has some different data and changing it will cause
// existing documents using that schema to end up with "duplicate seq" or something similar.
//
// So for now the strategy is to add code here to generate schemas when we have new ones and then
// to comment the code out so that it doesn't overwrite our previous schemas with incompatible ones.
//
// This is something we may need to find a better strategy for in the future.

// exportSchema<Catalog>("catalog", (doc) => {
//   doc.dms = {};
// });

// exportSchema<Channel>("channel", (doc) => {
//   doc.name = "";
//   doc.description = "";
//   doc.messages = {};
//   doc.threads = {};
//   doc.timeline = [];
// });
