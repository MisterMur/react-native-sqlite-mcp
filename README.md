# 🚀 Universal React Native SQLite MCP

**TL;DR:** A Model Context Protocol (MCP) server that gives your favorite LLM (Claude, Cursor, Antigravity, etc.) X-ray vision into your local React Native SQLite databases. 

No more flying blind. No more manually exporting `.db` files from emulators to figure out why your app is broken. Just ask your AI: *"Hey, what does the `users` table look like on my Android emulator?"* and watch the magic happen. ✨

---

## 🤔 Why did I build this?

Honestly? I was tired of jumping through hoops to inspect local databases while building React Native apps. Extracting SQLite files from an iOS Simulator or bypassing root permissions on an Android Emulator just to run a `SELECT *` was ruining my flow state. 

I wanted my AI assistant to just *know* what my database looked like and query it in real-time. So I built this bridge. It's mobile development less painful.


## 📦 Quick Start (The Magic Way)

You don't even need to clone this repo. The easiest way to get rolling is via `npx`.

Toss this bad boy into your `mcp.json` (or your Claude/Cursor/agent settings):

```json
{
  "mcpServers": {
    "rn-sqlite-bridge": {
      "command": "npx",
      "args": ["-y", "react-native-sqlite-mcp"],
      "env": {
        "DB_NAME": "my_database.db",
        "ANDROID_BUNDLE_ID": "com.mycompany.myapp"
      }
    }
  }
}
```

Boom. You're connected. 🤝

## 🛠️ Manual Installation (For the brave)

Prefer to tinker with the source code yourself? I respect it. 

```bash
git clone https://github.com/your-username/react-native-sqlite-mcp.git
cd react-native-sqlite-mcp
npm install
npm run build
```

Then point your MCP client to your local build:

```json
{
  "mcpServers": {
    "rn-sqlite-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/react-native-sqlite-mcp/dist/index.js"],
      "env": {
        "DB_NAME": "my_database.db",
        "ANDROID_BUNDLE_ID": "com.mycompany.myapp"
      }
    }
  }
}
```

## 🎛️ Environment Variables (The Knobs)

- `DB_NAME`: The filename of your database (e.g., `my_app.db`). You can also use a glob pattern (`*.db`) if you're feeling adventurous.
- `ANDROID_BUNDLE_ID`: *(Android Only)* The application ID/package name of your app (e.g., `com.mycompany.app`). 
  - **Pro-Tip:** If you leave this out, the MCP will go rogue and scan *all* third-party apps on your emulator for SQLite databases. Use with caution/glee.

## 🦸‍♂️ Features (What this bad boy can do)

This MCP arms your AI with four super-powered tools:

- 🕵️‍♂️ **`list_databases`**: Scours the device and returns a list of all available SQLite databases. Toss in `platform` ('ios' or 'android') to narrow the search.
- 🔄 **`sync_database`**: Yanks a copy of a database from your active device into the MCP's working directory so the AI can inspect it to its heart's content. Leave the arguments blank, and it'll just grab the first default database it finds.
- 🗺️ **`inspect_schema`**: The holy grail. Returns the `CREATE TABLE` and column info for your synced database. It literally gives the AI the map to your data.
- 📖 **`read_table_contents`**: Dumps all rows from a specific table (capped at 100 rows so we don't blow up the context window). 
- 🤖 **`query_db`**: Lets the AI fire raw SQL queries right at the database and get the results back. 

## ⚙️ How it Actually Works (Under the hood)

1. **Auto-Detect Platform**: It scans **both** iOS and Android environments simultaneously. It hunts down booted iOS Simulators using `simctl` and active Android Emulators using `adb`. 
2. **Auto-Locate Database**: 
  - **iOS:** We dive straight into the simulator's app sandbox. No root needed.
  - **Android:** We do a sneaky `adb exec-out run-as com.pkg.name cat ...` to copy the database file, along with its `-wal` and `-shm` sidekicks, completely bypassing the strict root permission boundaries on debug profiles.
3. **Platform Switching**: The server keeps one active database connection open. Want to switch from iOS to Android? The AI just calls `sync_database` for the other platform. Simple.
4. **Execution**: It wraps all this up nicely so the LLM can learn your schema and query live data without bothering you.

## 🤝 Contributing (Yes, please!)

Got an idea to make this objectively cooler? Found a bug where it accidentally queried your smart fridge? 

I am **all in** on community contributions. Whether you're fixing a typo, optimizing the ADB scripts, or adding support for Windows Phone (please don't), I want your PRs.

Check out the [CONTRIBUTING.md](./CONTRIBUTING.md) guide to see how we party.

## 📜 License

This project is licensed under the **MIT License**.

See the [LICENSE](./LICENSE) file for the legal jargon.