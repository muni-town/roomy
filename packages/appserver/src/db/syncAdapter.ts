import type { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { DbLike } from "./types.ts";

/** Cast unknown[] to SQLQueryBindings[] for bun:sqlite. */
function toBindings(...params: unknown[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[];
}

/** Normalise lastInsertRowid (number | bigint) to number | undefined. */
function normaliseRowid(
  rowid: number | bigint | undefined,
): number | undefined {
  if (rowid === undefined || rowid === null) return undefined;
  return Number(rowid);
}

/**
 * Wraps a synchronous `Database` to implement the async `DbLike` interface.
 * Each method returns `Promise.resolve(...)`.
 * Used during migration so existing synchronous callers can be converted
 * incrementally without breaking tests.
 */
export function toAsyncDb(db: Database): DbLike {
  return {
    query(sql: string) {
      const stmt = db.query(sql);
      return {
        all<T>(...params: unknown[]): Promise<T[]> {
          return Promise.resolve(stmt.all(...toBindings(...params)) as T[]);
        },
        get<T>(...params: unknown[]): Promise<T | null> {
          return Promise.resolve(
            (stmt.get(...toBindings(...params)) ?? null) as T | null,
          );
        },
      };
    },
    async prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        all<T>(...params: unknown[]): Promise<T[]> {
          return Promise.resolve(stmt.all(...toBindings(...params)) as T[]);
        },
        get<T>(...params: unknown[]): Promise<T | null> {
          return Promise.resolve(
            (stmt.get(...toBindings(...params)) ?? null) as T | null,
          );
        },
        run(
          ...params: unknown[]
        ): Promise<{ changes: number; lastInsertRowid?: number }> {
          const result = stmt.run(...toBindings(...params));
          return Promise.resolve({
            changes: result.changes,
            lastInsertRowid: normaliseRowid(result.lastInsertRowid),
          });
        },
      };
    },
    exec(sql: string): Promise<void> {
      db.exec(sql);
      return Promise.resolve();
    },
    run(
      sql: string,
      ...params: unknown[]
    ): Promise<{ changes: number; lastInsertRowid?: number }> {
      const result = db.run(sql, ...toBindings(...params));
      return Promise.resolve({
        changes: result.changes,
        lastInsertRowid: normaliseRowid(result.lastInsertRowid),
      });
    },
    transaction<T>(
      steps: Array<{
        type: "query" | "run" | "exec";
        sql: string;
        params?: unknown[];
      }>,
    ): Promise<T> {
      let lastResult: unknown = undefined;
      const run = db.transaction(() => {
        for (const step of steps) {
          switch (step.type) {
            case "query":
              lastResult = db.prepare(step.sql).all(
                ...toBindings(...(step.params ?? [])),
              );
              break;
            case "run":
              lastResult = db.run(step.sql, ...toBindings(...(step.params ?? [])));
              break;
            case "exec":
              db.exec(step.sql);
              lastResult = undefined;
              break;
          }
        }
      });
      return Promise.resolve(run() as T);
    },
    close(): Promise<void> {
      db.close();
      return Promise.resolve();
    },
  };
}
