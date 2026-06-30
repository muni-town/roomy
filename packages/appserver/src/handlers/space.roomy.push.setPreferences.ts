/**
 * XRPC: space.roomy.push.setPushPreferences (procedure).
 *
 * Sets the user-wide default notification level and/or a per-space override.
 *   - `spaceId` omitted → set the user-wide default (`body.default`).
 *   - `spaceId` present  → set/override the per-space level (`body.level`).
 * At least one of `default` / `level` must be provided. When `spaceId` is
 * present, `level` is required. Authenticated via `parseUserDid`.
 *
 * On `joinSpace`: the join flow sends the chosen `level` via this endpoint
 * immediately after `joinSpace` returns, keeping join atomic and preferences
 * a separate concern on a separate endpoint.
 */

import { openDb } from "../db/db.ts";
import { isLevel, type Level } from "../push/level.ts";
import { setSpaceLevel, setUserDefault } from "../queries/pushPreferences.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface SetPreferencesBody {
  default?: unknown;
  spaceId?: unknown;
  level?: unknown;
}

export const setPreferencesHandler: ProcedureHandler<
  SetPreferencesBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: SetPreferencesBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const hasDefault = body.default !== undefined;
  const hasLevel = body.level !== undefined;
  const hasSpaceId = body.spaceId !== undefined;

  if (!hasDefault && !hasLevel) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "At least one of 'default' or 'level' must be provided",
    );
  }

  // Validate `default`.
  let defaultLevel: Level | undefined;
  if (hasDefault) {
    if (!isLevel(body.default)) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Field 'default' must be one of silent|quiet|engaged|busy",
      );
    }
    defaultLevel = body.default;
  }

  // Validate `spaceId` / `level` pairing.
  let spaceId: string | undefined;
  let level: Level | undefined;
  if (hasSpaceId) {
    if (typeof body.spaceId !== "string" || body.spaceId === "") {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Field 'spaceId' must be a non-empty string",
      );
    }
    spaceId = body.spaceId;
    if (!hasLevel || !isLevel(body.level)) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Setting a per-space override requires 'level' (silent|quiet|engaged|busy)",
      );
    }
    level = body.level;
  } else if (hasLevel) {
    // `level` without `spaceId` is ambiguous — reject so the client is explicit
    // about whether it's setting the default or a per-space override.
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'level' requires 'spaceId' (use 'default' to set the user-wide default)",
    );
  }

  const db = openDb();
  if (defaultLevel !== undefined) {
    setUserDefault(db, userDid, defaultLevel);
  }
  if (spaceId !== undefined && level !== undefined) {
    setSpaceLevel(db, userDid, spaceId, level);
  }
};