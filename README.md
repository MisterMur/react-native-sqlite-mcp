# Universal React Native SQLite MCP

A Model Context Protocol (MCP) server that connects LLMs (Claude, Cursor, etc.) to your local React Native SQLite databases running on an iOS Simulator or Android Emulator.

This essentially acts as a "Database Inspector" for AI agents, allowing them to automatically view your DB schema and execute queries against the live app database without you having to manually export or describe tables.

## Requirements
* NodeJS
* iOS: `xcrun simctl` (available with Xcode)
* Android: `adb` (available with Android Studio / Android SDK)

## Installation

```bash
git clone <your-repo> react-native-sqlite-mcp
cd react-native-sqlite-mcp
npm install
npm run build
```

## Adding to Claude Desktop

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rn-sqlite-bridge": {
      "command": "node",
      "args": ["/path/to/react-native-sqlite-mcp/dist/index.js"],
      "env": {
        "DB_NAME": "my_database.db",
        "ANDROID_BUNDLE_ID": "com.mycompany.myapp"
      }
    }
  }
}
```

*Note: Replace `/path/to/react-native-sqlite-mcp` with the absolute path to where you cloned this repository. Replace `my_database.db` and `com.mycompany.myapp` with your app's actual values.*

### Environment Variables
- `DB_NAME`: The filename of your database (e.g., `my_app.db`) or a glob pattern (`*.db`).
- `ANDROID_BUNDLE_ID`: Only required for Android. The application ID/package name of your app (e.g., `com.mycompany.app`). Optional: If omitted, the MCP will scan all third-party apps on the emulator for SQLite databases.

## Features

This MCP provides four core tools:

- **`list_databases`**: Discovers and returns a list of all SQLite databases currently available. You can optionally pass `platform` ('ios' or 'android') to explicitly target one environment.
- **`sync_database`**: Pulls a local copy of a database from the active device so the AI can inspect it, and sets it as the active database. `dbName`, `bundleId`, and `platform` are all optional; if omitted, it will automatically select the first discovered default database across all running emulators.
- **`inspect_schema`**: Returns the `CREATE TABLE` and column information for the currently active synced database. Gives the AI the map of your database. Optionally accepts `tableName`, `dbName`, and `platform` to skip explicit syncing.
- **`read_table_contents`**: Returns all rows from a specified table. Equivalent to `SELECT * FROM table_name`, limited to 100 rows by default.
- **`query_db`**: Accepts a raw SQL query and returns the results for the currently active database. Optionally accepts `dbName` and `platform` to skip explicit syncing.

## How it Works

1. **Auto-Detect Platform**: By default, the tool will scan **both** iOS and Android environments. It locates booted iOS Simulators using `simctl` and active Android Emulators using `adb`. 
2. **Auto-Locate Database**: 
  - For iOS, the simulator's app sandbox files are directly accessed without needing root.
  - For Android, it uses `adb exec-out run-as com.pkg.name cat ...` to copy the database file, along with `-wal` and `-shm` temp files, bypassing strict root permission boundaries on debug profiles.
3. **Platform Switching**: The MCP server maintains a single active database connection. If you want to switch between iOS and Android, the AI simply calls `sync_database` targeting the desired platform.
4. **Execution**: Wraps arbitrary requests allowing the LLM to learn the schema and query live data.