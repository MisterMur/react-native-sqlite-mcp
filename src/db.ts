import sqlite3 from "sqlite3";

export class Database {
  private db: sqlite3.Database;

  constructor(filename: string) {
    this.db = new sqlite3.Database(filename);
  }

  public all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as Array<T>);
      });
    });
  }

  public get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row as T | undefined);
      });
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Executes a simple query on the database.
 */
export async function queryDb(dbPath: string, sql: string, params: any[] = []): Promise<any[]> {
  const db = new Database(dbPath);
  try {
    return await db.all(sql, params);
  } finally {
    await db.close();
  }
}

/**
 * Returns a detailed schema of all tables in the database.
 */
export async function inspectSchema(dbPath: string): Promise<any> {
  const db = new Database(dbPath);
  try {
    // Get all table names
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
    );

    const schemaInfo: Record<string, any> = {};

    for (const table of tables) {
      // For each table, get column definitions
      const columns = await db.all(
        `PRAGMA table_info("${table.name}");`
      );
      
      // Get table creation SQL
      const createSql = await db.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, 
        [table.name]
      );

      schemaInfo[table.name] = {
        columns,
        createSql: createSql?.sql
      };
    }

    return schemaInfo;
  } finally {
    await db.close();
  }
}
