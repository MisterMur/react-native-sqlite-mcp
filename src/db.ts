import sqlite3 from "sqlite3";
import { logger } from "./logger.js";

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

interface CachedConnection {
  db: Database;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

const CACHE_TTL_MS = 60_000; // close idle connections after 60s
const connectionCache = new Map<string, CachedConnection>();

function getCachedDb(dbPath: string): Database {
  const existing = connectionCache.get(dbPath);

  if (existing) {
    clearTimeout(existing.timer);
    existing.lastUsed = Date.now();
    existing.timer = setTimeout(() => evictConnection(dbPath), CACHE_TTL_MS);
    return existing.db;
  }

  const db = new Database(dbPath);
  const timer = setTimeout(() => evictConnection(dbPath), CACHE_TTL_MS);

  connectionCache.set(dbPath, { db, lastUsed: Date.now(), timer });
  logger.debug(`Opened DB connection: ${dbPath}`);
  return db;
}

async function evictConnection(dbPath: string): Promise<void> {
  const entry = connectionCache.get(dbPath);
  if (!entry) return;

  connectionCache.delete(dbPath);
  try {
    await entry.db.close();
    logger.debug(`Closed idle DB connection: ${dbPath}`);
  } catch (e) {
    logger.warn(`Error closing DB: ${dbPath}`, { error: String(e) });
  }
}

export async function closeAllConnections(): Promise<void> {
  const paths = [...connectionCache.keys()];
  for (const p of paths) {
    await evictConnection(p);
  }
  logger.info(`Closed ${paths.length} cached DB connection(s)`);
}

const QUERY_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Query timed out after ${ms}ms: ${label}`));
    }, ms);

    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

export async function queryDb(dbPath: string, sql: string, params: any[] = []): Promise<any[]> {
  const db = getCachedDb(dbPath);
  return withTimeout(db.all(sql, params), QUERY_TIMEOUT_MS, sql.slice(0, 80));
}

export async function inspectSchema(dbPath: string): Promise<any> {
  const db = getCachedDb(dbPath);

  const tables = await withTimeout(
    db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"),
    QUERY_TIMEOUT_MS,
    "inspect_schema:tables"
  );

  const schemaInfo: Record<string, any> = {};

  for (const table of tables) {
    const columns = await db.all(`PRAGMA table_info("${table.name}");`);
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
}
