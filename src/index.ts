#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listDatabases, syncDatabase } from "./locator.js";
import { inspectSchema, queryDb } from "./db.js";

// Keep track of the currently active databases
interface SyncedDB {
  localPath: string;
  dbName: string;
  platform: 'ios' | 'android';
}

let activeDatabases: SyncedDB[] = [];

const server = new Server(
  {
    name: "react-native-sqlite-bridge",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "sync_database",
        description: "Re-runs the adb pull or file-find logic to ensure the AI is looking at the latest data from the emulator/simulator.",
        inputSchema: {
          type: "object",
          properties: {
            dbName: {
              type: "string",
              description: "The name of the database file or a glob pattern (e.g., 'my_app.db' or '*.db'). Optional. If omitted, it will select the first discovered database."
            },
            bundleId: {
              type: "string",
              description: "(Android only) The application bundle ID (e.g., 'com.example.app'). Not required for iOS."
            },
            platform: {
              type: "string",
              description: "Optional. Explicitly target 'ios' or 'android'."
            }
          }
        }
      },
      {
        name: "list_databases",
        description: "Lists all available SQLite databases found on the iOS Simulator or Android Emulator.",
        inputSchema: {
          type: "object",
          properties: {
            bundleId: {
              type: "string",
              description: "(Android only) The application bundle ID (e.g., 'com.example.app'). Not required for iOS."
            },
            platform: {
              type: "string",
              description: "Optional. Explicitly target 'ios' or 'android'."
            }
          }
        }
      },
      {
        name: "inspect_schema",
        description: "Returns a list of all tables and their column definitions. This gives the AI the 'map' of the database.",
        inputSchema: {
          type: "object",
          properties: {
            dbName: {
              type: "string",
              description: "Optional. Target a specific database name. If omitted, uses the active DB or auto-selects."
            },
            platform: {
              type: "string",
              description: "Optional. Explicitly target 'ios' or 'android'. If omitted, uses the active DB or auto-selects."
            }
          },
          required: []
        }
      },
      {
        name: "read_table_contents",
        description: "Returns rows from a specific table. Equivalent to SELECT * FROM table_name.",
        inputSchema: {
          type: "object",
          properties: {
            tableName: {
              type: "string",
              description: "The name of the table to read."
            },
            limit: {
              type: "number",
              description: "Optional limit to the number of rows returned. Defaults to 100."
            },
            dbName: {
              type: "string",
              description: "Optional. Target a specific database name. If omitted, uses the active DB or auto-selects."
            },
            platform: {
              type: "string",
              description: "Optional. Explicitly target 'ios' or 'android'. If omitted, uses the active DB or auto-selects."
            }
          },
          required: ["tableName"]
        }
      },
      {
        name: "query_db",
        description: "Accepts a raw SQL SELECT string and returns the JSON result set.",
        inputSchema: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "The raw SQL SELECT string to execute."
            },
            params: {
              type: "array",
              description: "Optional arguments to bind to the SQL query. Use this to safely substitute ? placeholders in your SQL string (e.g. ['value', 42]).",
              items: {
                type: ["string", "number", "boolean", "null"],
                description: "A single bound parameter value."
              }
            },
            dbName: {
              type: "string",
              description: "Optional. Target a specific database name. If omitted, uses the active DB or auto-selects."
            },
            platform: {
              type: "string",
              description: "Optional. Explicitly target 'ios' or 'android'. If omitted, uses the active DB or auto-selects."
            }
          },
          required: ["sql"]
        }
      }
    ]
  };
});

// Helper to sanitize platform input if any
function cleanPlatform(raw?: string): 'ios' | 'android' | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/['"]/g, '').trim().toLowerCase();
  if (cleaned === 'ios' || cleaned === 'android') return cleaned;
  return undefined; // If they pass garbage, just let locator try both
}

// Helper to ensure database is synced based on provided args
async function ensureDbState(args: any): Promise<SyncedDB> {
  const reqDbName = args?.dbName as string | undefined;
  const reqPlatform = cleanPlatform(args?.platform as string | undefined);
  
  // If nothing is synced, sync defaults
  if (activeDatabases.length === 0) {
    const envDb = reqDbName || process.env.DB_NAME;
    const envBundle = process.env.ANDROID_BUNDLE_ID;
    activeDatabases = await syncDatabase(envDb, envBundle, reqPlatform);
  }

  // Filter based on explicit requirements
  let candidates = activeDatabases;
  if (reqPlatform) candidates = candidates.filter(db => db.platform === reqPlatform);
  if (reqDbName) candidates = candidates.filter(db => db.dbName === reqDbName);

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error(`No synced databases match the criteria (platform: ${reqPlatform || 'any'}, dbName: ${reqDbName || 'any'}). Try calling sync_database first.`);
  }

  const matches = candidates.map(c => `[${c.platform}] ${c.dbName}`).join(", ");
  throw new Error(`Multiple databases match the criteria. Please specify 'platform' or 'dbName'. Matches: ${matches}`);
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_databases") {
      const bundleId = args?.bundleId as string | undefined;
      const platform = cleanPlatform(args?.platform as string | undefined);
      const results = await listDatabases(bundleId, platform);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
      };
    }

    if (name === "sync_database") {
      const dbName = args?.dbName as string | undefined;
      const bundleId = args?.bundleId as string | undefined;
      const platform = cleanPlatform(args?.platform as string | undefined);

      const results = await syncDatabase(dbName, bundleId, platform);
      
      activeDatabases = results; // Replace the active list

      let msg = "Successfully synced databases:\n";
      for (const res of results) {
        msg += `- Platform: ${res.platform} | DB: ${res.dbName}\n  Path: ${res.localPath}\n`;
      }

      return {
        content: [{ type: "text", text: msg }]
      };
    }

    if (name === "inspect_schema") {
      const activeDb = await ensureDbState(args);
      const schema = await inspectSchema(activeDb.localPath);
      return {
        content: [{ type: "text", text: `[Active Platform: ${activeDb.platform} | DB: ${activeDb.dbName}]\n` + JSON.stringify(schema, null, 2) }]
      };
    }

    if (name === "read_table_contents") {
      const activeDb = await ensureDbState(args);
      
      const tableName = args?.tableName as string;
      const limit = args?.limit as number || 100;
      
      if (!tableName) {
        throw new Error("Missing required argument: tableName");
      }

      const sql = `SELECT * FROM "${tableName}" LIMIT ?`;
      const results = await queryDb(activeDb.localPath, sql, [limit]);
      return {
        content: [{ type: "text", text: `[Active Platform: ${activeDb.platform} | DB: ${activeDb.dbName} | Table: ${tableName} | Limit: ${limit}]\n` + JSON.stringify(results, null, 2) }]
      };
    }

    if (name === "query_db") {
      const activeDb = await ensureDbState(args);
      
      const sql = args?.sql as string;
      const params = (args?.params as any[]) || [];
      
      if (!sql) {
        throw new Error("Missing required argument: sql");
      }

      const results = await queryDb(activeDb.localPath, sql, params);
      return {
        content: [{ type: "text", text: `[Active Platform: ${activeDb.platform} | DB: ${activeDb.dbName}]\n` + JSON.stringify(results, null, 2) }]
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`
        }
      ],
      isError: true
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Universal React Native SQLite MCP Server running on stdio");
}

run().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
