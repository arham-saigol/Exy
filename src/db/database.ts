import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS } from "./schema.js";

export interface ExyDatabaseOptions {
  readonly?: boolean;
}

/** A small owner for Node's synchronous SQLite connection and migrations. */
export class ExyDatabase {
  readonly connection: DatabaseSync;
  readonly path: string;

  constructor(path: string, options: ExyDatabaseOptions = {}) {
    if (path.trim() === "") throw new Error("Database path must not be empty");

    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:" && !options.readonly) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }

    this.connection = new DatabaseSync(this.path, {
      readOnly: options.readonly ?? false,
      allowExtension: false,
    });
    this.connection.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

    if (!options.readonly) {
      if (this.path !== ":memory:") {
        this.connection.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        chmodSync(this.path, 0o600);
      }
      this.migrate();
    }
  }

  migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);

    const isApplied = this.connection.prepare(
      "SELECT 1 AS applied FROM schema_migrations WHERE version = ?",
    );
    const insert = this.connection.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const migration of MIGRATIONS) {
      this.transaction(() => {
        // Re-check while holding the write lock. Another gateway may have
        // completed this migration after this process opened the database.
        if (isApplied.get(migration.version) !== undefined) return;
        this.connection.exec(migration.sql);
        insert.run(migration.version, migration.name, Date.now());
      });
    }
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the original error; SQLite may already have rolled back.
      }
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}

export function openExyDatabase(path: string): ExyDatabase {
  return new ExyDatabase(path);
}
