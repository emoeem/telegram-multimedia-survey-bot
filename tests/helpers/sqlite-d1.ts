import { createRequire } from "node:module";

/**
 * Minimal `D1Database` shim backed by an in-process SQLite database.
 *
 * Repository SQL is only interpreted by SQLite at runtime, so statements that
 * are invalid but type-check — an ambiguous `ORDER BY ... id` (json_each also
 * exposes `id`), a misspelled column, a bad join — pass `tsc` and every mocked
 * test, then throw in production. Running the real statements against a real
 * SQLite closes that gap.
 *
 * `node:sqlite` ships unflagged from Node 23.4. CI and `.nvmrc` both pin Node
 * 24, so these tests run for real in the pipeline. The {@link sqliteD1Available}
 * gate only protects a contributor on an older runtime (Node 22 needs
 * `--experimental-sqlite`): they skip rather than fail.
 */
const require = createRequire(import.meta.url);

type SqliteModule = typeof import("node:sqlite");

function loadSqlite(): SqliteModule | null {
  try {
    return require("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

const sqlite = loadSqlite();

export const sqliteD1Available = sqlite !== null;

/** D1 binds booleans as 0/1 and rejects `undefined`; mirror that here. */
function normalizeParams(params: readonly unknown[]): unknown[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}

export function createSqliteD1(schema: string): D1Database {
  if (!sqlite) throw new Error("node:sqlite is unavailable in this runtime");
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(schema);

  function prepare(sql: string): D1PreparedStatement {
    let params: unknown[] = [];
    const statement = {
      // batch() needs the SQL text to tell write statements (whose results
      // must carry meta.changes, like real D1) apart from reads.
      sql,
      bind(...args: unknown[]) {
        params = normalizeParams(args);
        return statement;
      },
      async all<T>() {
        const results = db.prepare(sql).all(...(params as never[])) as T[];
        return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
      },
      async first<T>(column?: string) {
        const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column === undefined ? row : (row[column] ?? null)) as T;
      },
      async run() {
        const info = db.prepare(sql).run(...(params as never[]));
        return {
          success: true,
          meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
        };
      },
    };
    return statement as unknown as D1PreparedStatement;
  }

  return {
    prepare,
    batch: async (statements: D1PreparedStatement[]) =>
      // Real D1 batch returns per-statement meta (including changes) for write
      // statements and rows for reads. The shim's run() carries the write
      // meta while all() hardcodes changes: 0, so route writes through run() —
      // otherwise INSERT OR IGNORE idempotence checks ("was this the call that
      // actually unlocked it?") always read false under the shim.
      Promise.all(
        statements.map((item) =>
          /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test((item as { sql?: string }).sql ?? "")
            ? item.run()
            : item.all(),
        ),
      ),
    exec: async (query: string) => {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
