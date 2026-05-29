/**
 * Param parsing helpers for XRPC handlers.
 *
 * Raw params are `string | string[] | undefined`. These helpers narrow that to
 * what handlers actually want, throwing `XrpcError(400)` with consistent
 * shapes.
 */

import { XrpcError } from "./errors.ts";
import type { QueryParams } from "./types.ts";

export function requireString(params: QueryParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Missing or empty required param: ${key}`,
    );
  }
  return value;
}

export function optionalString(
  params: QueryParams,
  key: string,
): string | undefined {
  const value = params[key];
  if (typeof value !== "string" || value === "") return undefined;
  return value;
}

export function optionalInt(
  params: QueryParams,
  key: string,
  opts: { min?: number; max?: number; default?: number } = {},
): number | undefined {
  const raw = optionalString(params, key);
  if (raw === undefined) return opts.default;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Param ${key} must be an integer, got: ${raw}`,
    );
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Param ${key} must be ≥ ${opts.min}, got: ${n}`,
    );
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Param ${key} must be ≤ ${opts.max}, got: ${n}`,
    );
  }
  return n;
}
