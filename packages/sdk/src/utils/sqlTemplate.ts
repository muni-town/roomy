import type { SqlStatement } from "../types";

/** Tagged template that returns a SQL statement for a SQLite query */
export function sql(
  strings: TemplateStringsArray,
  ...params: any[]
): SqlStatement {
  const sql = strings.join("?");
  return {
    sql,
    params: params.length > 0 ? params : undefined,
    cache: true,
  };
}

(globalThis as any).sql = sql;
