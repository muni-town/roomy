import type { FunctionOptions, SqlValue } from "@sqlite.org/sqlite-wasm";
import { patchApply, patchFromText } from "diff-match-patch-es";
import { decodeTime, ulid, isValid as isValidUlid } from "ulidx";

export const udfs: {
  name: string;
  f: (ctx: number, ...args: SqlValue[]) => SqlValue;
  opts?: FunctionOptions;
}[] = [
  // decode text blob to string
  {
    name: "text",
    f: (_ctx, blob) => {
      if (blob instanceof Uint8Array) {
        return new TextDecoder().decode(blob);
      } else {
        return blob;
      }
    },
  },
  {
    name: "print",
    f: (_ctx, ...args) => {
      console.log("%c[sqlite log]", "color: green", ...args);
      return null;
    },
    opts: { arity: -1, deterministic: false },
  },
  {
    name: "is_ulid",
    f: (_ctx, id) => {
      if (typeof id == "string") {
        return isValidUlid(id) ? 1 : 0;
      } else {
        return 0;
      }
    },
  },
  {
    name: "ulid_timestamp",
    f: (_ctx, id) => {
      if (typeof id == "string") {
        return decodeTime(id);
      } else {
        return id;
      }
    },
  },
  // Create a ULID from a timestamp (for range queries using the index)
  {
    name: "timestamp_to_ulid",
    f: (_ctx, timestamp) => {
      if (typeof timestamp === "number") {
        // Create a ULID with the given timestamp
        return ulid(timestamp);
      }
      return null;
    },
  },
  {
    name: "apply_dmp_patch",
    f: (_ctx, content, patch) => {
      if (!(typeof content == "string" && typeof patch == "string"))
        throw "Expected two string arguments to apply_dpm_patch()";

      const [patched, _successful] = patchApply(
        patchFromText(patch),
        content,
      ) as [string, boolean[]];

      return patched;
    },
  },
];
