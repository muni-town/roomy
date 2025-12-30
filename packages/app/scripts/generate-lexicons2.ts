/// <reference types="node" />

/**
 * Lexicon Generator
 *
 * Converts ArkType schemas to ATProto lexicon JSON.
 *
 * Run with: npx tsx scripts/generate-lexicons.ts
 *
 * This is intentionally lossy - ArkType can express things lexicons can't.
 * The goal is valid, interoperable lexicons, not perfect fidelity.
 */

import { writeFileSync, mkdirSync } from "fs";
import { eventLexicons } from "../src/lib/schema/lexiconGen";

// Output directory for generated lexicons
const OUTPUT_DIR = "./lexicons";

// Main execution
function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const doc of eventLexicons) {
    const filename = `${OUTPUT_DIR}/${doc.id}.json`;
    writeFileSync(filename, JSON.stringify(doc, null, 2));
    console.log(`Generated: ${filename}`);
  }

  const filename = `${OUTPUT_DIR}/all.json`;
  writeFileSync(filename, JSON.stringify(eventLexicons, null, 2));
  console.log(`Generated: ${filename}`);

  console.log(
    `\nGenerated ${eventLexicons.length} lexicons and the all.json file with them all bundled.`,
  );
}

main();
