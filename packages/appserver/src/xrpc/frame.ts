import { encode } from "@atcute/cbor";
import type { Frame } from "./types.ts";

export function encodeFrame(frame: Frame): Uint8Array {
  const headerBytes = encode(frame.header);
  const bodyBytes = encode(frame.body);
  const out = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
  out.set(headerBytes, 0);
  out.set(bodyBytes, headerBytes.byteLength);
  return out;
}

export function messageFrame(eventType: string, body: Record<string, unknown>): Frame {
  return { header: { op: 1, t: eventType }, body };
}

export function errorFrame(error: string, message: string): Frame {
  return { header: { op: -1, t: "#error" }, body: { error, message } };
}
