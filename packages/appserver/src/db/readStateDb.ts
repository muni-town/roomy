/**
 * Read-state schema version constant.
 *
 * The read-state database lifecycle is now managed by the SQLite worker
 * (see worker.ts). This module exists solely to export the version constant
 * so that db.ts can pass it to the worker during init.
 *
 * Bump whenever readStateSchema.sql changes.
 * Uses a separate versioning namespace from the materialisation DB.
 */
export const READSTATE_SCHEMA_VERSION = "2";
