import enc from "base32-encode";
import dec from "base32-decode";

export function encodeBase32(data: Uint8Array): string {
  return enc(data, "Crockford").toLowerCase();
}

export function decodeBase32(data: string): Uint8Array {
  return new Uint8Array(dec(data, "Crockford"));
}
