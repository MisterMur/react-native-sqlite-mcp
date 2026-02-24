#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listDatabases, syncDatabase } from "./locator.js";
import { inspectSchema, queryDb, closeAllConnections } from "./db.js";
import { logger } from "./logger.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// ---------------------------------------------------------------------------
// Process-level guards — prevent silent crashes that cause EOF errors
// ---------------------------------------------------------------------------

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception (process kept alive)", {
    message: error.message,
    stack: error.stack?.slice(0, 500),
  });
  // Do NOT call process.exit() — keep the MCP server alive
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection (process kept alive)", {
    reason: String(reason),
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const READ_ONLY = process.env.READ_ONLY === 'true' || process.env.READ_ONLY === '1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SyncedDB {
  localPath: string;
  dbName: string;
  platform: "ios" | "android";
}

let activeDatabases: SyncedDB[] = [];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "react-native-sqlite-bridge",
    version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// MCP-level transport error handler
server.onerror = (error) => {
  logger.error("MCP transport error", { message: String(error) });
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "sync_database",
        description:
          "Re-runs the adb pull or file-find logic to ensure the AI is looking at the latest data from the emulator/simulator.",
        inputSchema: {
          type: "object",
          properties: {
            dbName: {
              type: "string",
              description:
                "The name of the database file or a glob pattern (e.g., 'my_app.db' or '*.db'). Optional. If omitted, it will select the first discovered database.",
            },
            bundleId: {
              type: "string",
              description:
                "(Android only) The application bundle ID (e.g., 'com.example.app'). Not required for iOS.",
            },
            platform: {
              type: "string",
              description:
                "Optional. Explicitly target 'ios' or 'android'.",
            },
          },
        },
      },
      {
        name: "list_databases",
        description:
          "Lists all available SQLite databases found on the iOS Simulator or Android Emulator.",
        inputSchema: {
          type: "object",
          properties: {
            bundleId: {
              type: "string",
              description:
                "(Android only) The application bundle ID (e.g., 'com.example.app'). Not required for iOS.",
            },
            platform: {
              type: "string",
              description:
                "Optional. Explicitly target 'ios' or 'android'.",
            },
          },
        },
      },
      {
        name: "inspect_schema",
        description:
          "Returns a list of all tables and their column definitions. This gives the AI the 'map' of the database.",
        inputSchema: {
          type: "object",
          properties: {
            dbName: {
              type: "string",
              description:
                "Optional. Target a specific database name. If omitted, uses the active DB or auto-selects.",
            },
            platform: {
              type: "string",
              description:
                "Optional. Explicitly target 'ios' or 'android'. If omitted, uses the active DB or auto-selects.",
            },
          },
          required: [],
        },
      },
      {
        name: "read_table_contents",
        description:
          "Returns rows from a specific table. Equivalent to SELECT * FROM table_name.",
        inputSchema: {
          type: "object",
          properties: {
            tableName: {
              type: "string",
              description: "The name of the table to read.",
            },
            limit: {
              type: "number",
              description:
                "Optional limit to the number of rows returned. Defaults to 100.",
            },
            dbName: {
              type: "string",
              description:
                "Optional. Target a specific database name. If omitted, uses the active DB or auto-selects.",
            },
            platform: {
              type: "string",
              description:
                "Optional. Explicitly target 'ios' or 'android'. If omitted, uses the active DB or auto-selects.",
            },
          },
          required: ["tableName"],
        },
      },
      {
        name: "query_db",
        description:
          "Accepts a raw SQL SELECT string and returns the JSON result set.",
        inputSchema: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "The raw SQL SELECT string to execute.",
            },
            params: {
              type: "array",
              description:
                "Optional arguments to bind to the SQL query. Use this to safely substitute ? placeholders in your SQL string (e.g. ['value', 42]).",
              items: {
                description: "A single bound parameter value.",
              },
            },
            dbName: {
              type: "string",
              description:
                "Optional. Target a specific database name. If omitted, uses the active DB or auto-selects.",
            },
            platform: {
              type: "string",
              description:
                "Optional. Explicitly target 'ios' or 'android'. If omitted, uses the active DB or auto-selects.",
            },
          },
          required: ["sql"],
        },
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanPlatform(raw?: string): "ios" | "android" | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/['"]/g, "").trim().toLowerCase();
  if (cleaned === "ios" || cleaned === "android") return cleaned;
  return undefined;
}

async function ensureDbState(args: any): Promise<SyncedDB> {
  const reqDbName = args?.dbName as string | undefined;
  const reqPlatform = cleanPlatform(args?.platform as string | undefined);

  // If nothing is synced, sync defaults
  if (activeDatabases.length === 0) {
    const envDb = reqDbName || process.env.DB_NAME;
    const envBundle = process.env.ANDROID_BUNDLE_ID;
    activeDatabases = await syncDatabase(envDb, envBundle, reqPlatform);
  }

  let candidates = activeDatabases;
  if (reqPlatform)
    candidates = candidates.filter((db) => db.platform === reqPlatform);
  if (reqDbName)
    candidates = candidates.filter((db) => db.dbName === reqDbName);

  if (candidates.length === 1) return candidates[0];

  if (candidates.length === 0) {
    throw new Error(
      `No synced databases match the criteria (platform: ${reqPlatform || "any"}, dbName: ${reqDbName || "any"}). Try calling sync_database first.`
    );
  }

  const matches = candidates
    .map((c) => `[${c.platform}] ${c.dbName}`)
    .join(", ");
  throw new Error(
    `Multiple databases match the criteria. Please specify 'platform' or 'dbName'. Matches: ${matches}`
  );
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_databases") {
      const bundleId = args?.bundleId as string | undefined;
      const platform = cleanPlatform(args?.platform as string | undefined);
      const results = await listDatabases(bundleId, platform);
      return {
        content: [
          { type: "text", text: JSON.stringify(results, null, 2) },
        ],
      };
    }

    if (name === "sync_database") {
      const dbName = args?.dbName as string | undefined;
      const bundleId = args?.bundleId as string | undefined;
      const platform = cleanPlatform(args?.platform as string | undefined);

      const results = await syncDatabase(dbName, bundleId, platform);
      activeDatabases = results;

      let msg = "Successfully synced databases:\n";
      for (const res of results) {
        msg += `- Platform: ${res.platform} | DB: ${res.dbName}\n  Path: ${res.localPath}\n`;
      }
      return { content: [{ type: "text", text: msg }] };
    }

    if (name === "inspect_schema") {
      const activeDb = await ensureDbState(args);
      const schema = await inspectSchema(activeDb.localPath);
      return {
        content: [
          {
            type: "text",
            text:
              `[Active Platform: ${activeDb.platform} | DB: ${activeDb.dbName}]\n` +
              JSON.stringify(schema, null, 2),
          },
        ],
      };
    }

    if (name === "read_table_contents") {
      const activeDb = await ensureDbState(args);
      const tableName = args?.tableName as string;
      const limit = (args?.limit as number) || 100;

      if (!tableName) {
        throw new Error("Missing required argument: tableName");
      }

      const sql = `SELECT * FROM "${tableName}" LIMIT ?`;
      const results = await queryDb(activeDb.localPath, sql, [limit]);
      return {
        content: [
          {
            type: "text",
            text:
              `[Active Platform: ${activeDb.platform} | DB: ${activeDb.dbName} | Table: ${tableName} | Limit: ${limit}]\n` +
              JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    if (name === "query_db") {
      const activeDb = await ensureDbState(args);
      const sql = args?.sql as string;
      const params = (args?.params as any[]) || [];

      if (!sql) {
        throw new Error("Missing required argument: sql");
      }

      if (READ_ONLY) {
        const normalized = sql.trim().toUpperCase();
        if (!normalized.startsWith("SELECT") && !normalized.startsWith("PRAGMA") && !normalized.startsWith("EXPLAIN")) {
          throw new Error("READ_ONLY mode is enabled. Only SELECT, PRAGMA, and EXPLAIN statements are allowed.");
        }
      }

      const results = await queryDb(activeDb.localPath, sql, params);
      return {
        content: [
          {
            type: "text",
            text:
              `[Active Platform: ${activeDb.platform} | DB: ${activeDb.dbName}]\n` +
              JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error: any) {
    logger.error(`Tool "${name}" failed`, { message: error.message });
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
    await closeAllConnections();
  } catch (e) {
    logger.error("Error during shutdown", { error: String(e) });
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Universal React Native SQLite MCP Server running on stdio");
}

run().catch((error) => {
  logger.error("Server startup error", { message: error.message, stack: error.stack });
  process.exit(1);
});
