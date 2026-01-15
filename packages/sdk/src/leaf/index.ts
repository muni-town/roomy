import { type } from "arktype";
import { StreamIndex, UserDid } from "../schema";
import { SqlRows } from "@muni-town/leaf-client";
import { EncodedStreamEvent } from "../connection";

export { createLeafClient, type LeafConfig } from "./client";

const encodedStreamEvent = type({
  idx: { $type: "'muni.town.sqliteValue.integer'", value: StreamIndex },
  user: { $type: "'muni.town.sqliteValue.text'", value: "string" },
  payload: {
    $type: "'muni.town.sqliteValue.blob'",
    value: type.instanceOf(Uint8Array),
  },
});

export function parseEvents(rows: SqlRows): EncodedStreamEvent[] {
  return rows.map((row) => {
    const result = encodedStreamEvent(row);

    if (result instanceof type.errors) {
      console.error("Could not parse event", result);
      throw new Error("Invalid column names for events response");
    }

    return {
      idx: Number(result.idx.value) as StreamIndex,
      user: UserDid.assert(result.user!.value),
      payload: result.payload?.value,
    };
  });
}
