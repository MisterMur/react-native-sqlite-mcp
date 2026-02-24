import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import fs from "fs";
import { logger } from "./logger.js";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!SQL) {
    SQL = await initSqlJs();
    logger.debug("sql.js WASM engine initialized");
  }
  return SQL;
}

interface CachedConnection {
  db: SqlJsDatabase;
  dbPath: string;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

const CACHE_TTL_MS = 60_000;
const connectionCache = new Map<string, CachedConnection>();

async function getCachedDb(dbPath: string): Promise<SqlJsDatabase> {
  const existing = connectionCache.get(dbPath);

  if (existing) {
    clearTimeout(existing.timer);
    existing.lastUsed = Date.now();
    existing.timer = setTimeout(() => evictConnection(dbPath), CACHE_TTL_MS);
    return existing.db;
  }

  const sqlJs = await getSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new sqlJs.Database(buffer);

  const timer = setTimeout(() => evictConnection(dbPath), CACHE_TTL_MS);
  connectionCache.set(dbPath, { db, dbPath, lastUsed: Date.now(), timer });
  logger.debug(`Opened DB connection: ${dbPath}`);
  return db;
}

function evictConnection(dbPath: string): void {
  const entry = connectionCache.get(dbPath);
  if (!entry) return;

  connectionCache.delete(dbPath);
  try {
    entry.db.close();
    logger.debug(`Closed idle DB connection: ${dbPath}`);
  } catch (e) {
    logger.warn(`Error closing DB: ${dbPath}`, { error: String(e) });
  }
}

export async function closeAllConnections(): Promise<void> {
  const paths = [...connectionCache.keys()];
  for (const p of paths) {
    evictConnection(p);
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

function runQuery(db: SqlJsDatabase, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

export async function queryDb(dbPath: string, sql: string, params: any[] = []): Promise<any[]> {
  const db = await getCachedDb(dbPath);
  return withTimeout(
    Promise.resolve(runQuery(db, sql, params)),
    QUERY_TIMEOUT_MS,
    sql.slice(0, 80)
  );
}

export async function inspectSchema(dbPath: string): Promise<any> {
  const db = await getCachedDb(dbPath);

  const tables = runQuery(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");

  const schemaInfo: Record<string, any> = {};

  for (const table of tables) {
    const columns = runQuery(db, `PRAGMA table_info("${table.name}");`);
    const createSqlRows = runQuery(
      db,
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [table.name]
    );

    schemaInfo[table.name] = {
      columns,
      createSql: createSqlRows[0]?.sql
    };
  }

  return schemaInfo;
}
