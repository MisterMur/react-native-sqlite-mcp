import fs from "fs";
import path from "path";
import os from "os";
import { shell } from "./shell.js";
import { logger } from "./logger.js";

export interface DatabaseLocation {
  platform: 'ios' | 'android';
  databases: string[];
  appDir?: string;
}

export async function listDatabases(bundleId?: string, targetPlatform?: 'ios' | 'android'): Promise<DatabaseLocation[]> {
  const results: DatabaseLocation[] = [];

  if (!targetPlatform || targetPlatform === 'ios') {
    try {
      const udidStr = await shell(
        "xcrun simctl list devices booted | awk -F '[()]' '/Booted/{print $2; exit}'",
        { timeout: 5_000, label: "xcrun-simctl-booted" }
      );

      if (udidStr) {
        const appDataDir = `${process.env.HOME}/Library/Developer/CoreSimulator/Devices/${udidStr}/data/Containers/Data/Application`;
        if (fs.existsSync(appDataDir)) {
          try {
            const found = await shell(
              `find "${appDataDir}" -type f \\( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \\) -maxdepth 7 -print`,
              { timeout: 15_000, label: "ios-find-dbs" }
            );
            if (found) {
              results.push({
                platform: 'ios',
                appDir: appDataDir,
                databases: found.split('\n').map(p => path.basename(p.trim())).filter(Boolean)
              });
            }
          } catch (e) {
            logger.warn("iOS find failed", { error: String(e) });
          }
        }
      } else if (targetPlatform === 'ios') {
        throw new Error("No booted iOS Simulator found (simctl returned empty).");
      }
    } catch (e: any) {
      if (targetPlatform === 'ios' && !e.message?.includes("find failed")) {
        throw new Error("No booted iOS Simulator found or xcrun failed.");
      }
    }
  }

  if (!targetPlatform || targetPlatform === 'android') {
    try {
      await shell("adb get-state", { timeout: 5_000, label: "adb-get-state" });
    } catch (e) {
      if (targetPlatform === 'android') {
        throw new Error("No booted Android Emulator found or adb is unresponsive.");
      }
      if (results.length === 0) {
        throw new Error("No booted iOS Simulator or Android Emulator device found.");
      }
      return results;
    }

    // if we have a specific bundleId-use it otherwise hunt
    let packagesToScan: string[] = [];
    if (bundleId) {
      packagesToScan = [bundleId];
    } else {
      try {
        const packagesStr = await shell(
          "adb shell pm list packages -3",
          { timeout: 8_000, label: "adb-list-packages", retries: 1, retryDelay: 1_000 }
        );
        packagesToScan = packagesStr.split('\n')
          .map(line => line.replace('package:', '').trim())
          .filter(Boolean);
      } catch (e) {
        if (results.length === 0) {
          throw new Error("Could not list packages on Android Emulator to discover databases. Is it fully booted?");
        }
        return results;
      }
    }

    const allAndroidDatabases: string[] = [];
    let lastSuccessfulAppDir: string | undefined;

    for (const pkg of packagesToScan) {
      const baseDirs = [`/data/user/0/${pkg}`, `/data/data/${pkg}`];
      for (const baseDir of baseDirs) {
        try {
          await shell(
            `adb shell run-as ${pkg} ls -d ${baseDir}`,
            { timeout: 3_000, label: `adb-ls-${pkg}` }
          );

          let foundFiles: string[] = [];

          // find .db / .sqlite / .sqlite3 files recursively
          const findOut = await shell(
            `adb shell "run-as ${pkg} find ${baseDir} -type f \\( -name \\"*.db\\" -o -name \\"*.sqlite\\" -o -name \\"*.sqlite3\\" \\)"`,
            { timeout: 8_000, ignoreErrors: true, label: `adb-find-${pkg}` }
          );
          if (findOut) {
            foundFiles.push(...findOut.split('\n').map(l => l.trim().replace(/\r/g, '')).filter(Boolean));
          }

          // also check for extensionless files in /databases
          const lsOut = await shell(
            `adb shell run-as ${pkg} ls -1p ${baseDir}/databases`,
            { timeout: 3_000, ignoreErrors: true, label: `adb-ls-dbs-${pkg}` }
          );
          if (lsOut) {
            const lsFiles = lsOut.split('\n')
              .map(l => l.trim().replace(/\r/g, ''))
              .filter(Boolean)
              .filter(f => !f.endsWith('/'))
              .filter(f => !f.endsWith('-journal') && !f.endsWith('-wal') && !f.endsWith('-shm'))
              .filter(f => !f.includes('.'))
              .map(f => `${baseDir}/databases/${f}`);
            foundFiles.push(...lsFiles);
          }

          // Deduplicate
          foundFiles = [...new Set(foundFiles)];

          if (foundFiles.length > 0) {
            const displayFiles = foundFiles.map(f => f.replace(`${baseDir}/`, ''));
            allAndroidDatabases.push(...displayFiles);
            lastSuccessfulAppDir = `${baseDir}::${pkg}`;
            break;
          }
        } catch (e) {
          logger.debug(`Failed to list databases for app: ${pkg}`);
        }
      }
    }

    if (allAndroidDatabases.length > 0) {
      results.push({
        platform: 'android',
        appDir: lastSuccessfulAppDir,
        databases: allAndroidDatabases
      });
    } else if (targetPlatform === 'android') {
      throw new Error(`Android Emulator is booted, but no SQLite databases were found in any debuggable third-party packages.`);
    }
  }

  return results;
}


export async function syncDatabase(dbNameGlob?: string, bundleId?: string, targetPlatform?: 'ios' | 'android'): Promise<{ localPath: string, dbName: string, platform: 'ios' | 'android' }[]> {
  const locations = await listDatabases(bundleId, targetPlatform);

  if (locations.length === 0) {
    if (targetPlatform) {
      throw new Error(`No SQLite databases found for platform '${targetPlatform}'.`);
    }
    throw new Error(`No SQLite databases found on any platform.`);
  }

  const synced: { localPath: string, dbName: string, platform: 'ios' | 'android' }[] = [];

  for (const loc of locations) {
    if (targetPlatform && loc.platform !== targetPlatform) continue;
    let targetDbNames: string[] = [];

    if (!dbNameGlob) {
      const preferred = loc.databases.find(d => d.endsWith('.db') || d.endsWith('.sqlite'));
      if (preferred) {
        targetDbNames.push(preferred);
      } else if (loc.databases.length > 0) {
        targetDbNames.push(loc.databases[0]);
      }
    } else {
      const globRegex = new RegExp('^' + dbNameGlob.replace(/\*/g, '.*') + '$');
      targetDbNames = loc.databases.filter(name => globRegex.test(name));
    }

    for (const targetDbName of targetDbNames) {
      const { platform, appDir } = loc;

      // --- iOS Logic ---
      if (platform === 'ios') {
        if (!appDir) continue;

        try {
          const found = await shell(
            `find "${appDir}" -type f -name "${targetDbName}" -maxdepth 7 -print | head -n 1`,
            { timeout: 8_000, label: `ios-find-${targetDbName}` }
          );
          if (found && fs.existsSync(found)) {
            logger.info(`Located iOS DB at: ${found}`);
            synced.push({ localPath: found, dbName: targetDbName, platform: 'ios' });
          }
        } catch (e) {
          logger.warn(`Failed to locate full path for iOS DB: ${targetDbName}`);
        }
        continue;
      }

      // --- Android Logic ---
      if (!appDir || !appDir.includes("::")) {
        logger.warn(`Invalid Android appDir format: ${appDir}`);
        continue;
      }

      const [targetDbDir, targetPkg] = appDir.split("::");

      await shell(
        `adb shell am force-stop ${targetPkg}`,
        { timeout: 5_000, ignoreErrors: true, label: `adb-force-stop-${targetPkg}` }
      );

      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "rn-sqlite-mcp-"));
      const safeLocalName = targetDbName.replace(/\//g, '_');
      const localDb = path.join(tmpdir, safeLocalName);
      const localWal = `${localDb}-wal`;
      const localShm = `${localDb}-shm`;

      const remoteMain = `${targetDbDir}/${targetDbName}`;
      const remoteWal = `${remoteMain}-wal`;
      const remoteShm = `${remoteMain}-shm`;

      const pullOne = async (remote: string, local: string): Promise<boolean> => {
        try {
          const remoteBase = path.basename(remote);
          const tmpRemote = `/data/local/tmp/${targetPkg}_${remoteBase}_${Date.now()}`;

          await shell(
            `adb shell "run-as '${targetPkg}' cat '${remote}' > '${tmpRemote}'"`,
            { timeout: 10_000, retries: 1, retryDelay: 1_000, label: `adb-cat-${remoteBase}` }
          );
          await shell(
            `adb pull '${tmpRemote}' '${local}'`,
            { timeout: 10_000, label: `adb-pull-${remoteBase}` }
          );
          await shell(
            `adb shell rm '${tmpRemote}'`,
            { timeout: 5_000, ignoreErrors: true, label: `adb-rm-tmp-${remoteBase}` }
          );

          return fs.existsSync(local) && fs.statSync(local).size > 0;
        } catch (e) {
          if (fs.existsSync(local)) fs.unlinkSync(local);
          return false;
        }
      };

      if (!(await pullOne(remoteMain, localDb))) {
        logger.warn(`Failed to pull main DB file from Android: ${remoteMain}`);
        continue;
      }

      // WAL and SHM are best-effort
      await pullOne(remoteWal, localWal);
      await pullOne(remoteShm, localShm);

      logger.info(`Pulled Android DB to local temp: ${localDb}`);
      synced.push({ localPath: localDb, dbName: targetDbName, platform: 'android' });
    }
  }

  if (synced.length === 0) {
    throw new Error(`Failed to sync any databases matching '${dbNameGlob || 'auto-select'}'.`);
  }

  return synced;
}
