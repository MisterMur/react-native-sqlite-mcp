import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

export interface DatabaseLocation {
  platform: 'ios' | 'android';
  databases: string[];
  appDir?: string;
}

export async function listDatabases(bundleId?: string, targetPlatform?: 'ios' | 'android'): Promise<DatabaseLocation[]> {
  const results: DatabaseLocation[] = [];

  if (!targetPlatform || targetPlatform === 'ios') {
    try {
      const udidStr = execSync("xcrun simctl list devices booted | awk -F '[()]' '/Booted/{print $2; exit}'", { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
      if (udidStr) {
        const appDataDir = `${process.env.HOME}/Library/Developer/CoreSimulator/Devices/${udidStr}/data/Containers/Data/Application`;
        if (fs.existsSync(appDataDir)) {
          try {
            const findCmd = `find "${appDataDir}" -type f \\( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \\) -maxdepth 7 -print`;
            const found = execSync(findCmd, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 }).toString().trim();
            if (found) {
              results.push({
                platform: 'ios',
                appDir: appDataDir,
                databases: found.split('\n').map(p => path.basename(p.trim())).filter(Boolean)
              });
            }
          } catch (e) {
            console.error("iOS find failed", e);
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
      execSync("adb get-state", { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 });
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
        const packagesStr = execSync("adb shell pm list packages -3", { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
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
          execSync(`adb shell run-as ${pkg} ls -d ${baseDir}`, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 });
          
          let foundFiles: string[] = [];
          
          try {
            const findCmd = `adb shell "run-as ${pkg} find ${baseDir} -type f \\( -name \\"*.db\\" -o -name \\"*.sqlite\\" -o -name \\"*.sqlite3\\" \\)"`;
            const findOut = execSync(findCmd, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
            if (findOut) {
               foundFiles.push(...findOut.split('\n').map(l => l.trim().replace(/\r/g, '')).filter(Boolean));
            }
          } catch (e) {}
          
           try {
            const lsOut = execSync(`adb shell run-as ${pkg} ls -1p ${baseDir}/databases`, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
            const lsFiles = lsOut.split('\n')
              .map(l => l.trim().replace(/\r/g, ''))
              .filter(Boolean)
              .filter(f => !f.endsWith('/'))
              .filter(f => !f.endsWith('-journal') && !f.endsWith('-wal') && !f.endsWith('-shm'))
              .filter(f => !f.includes('.')) 
              .map(f => `${baseDir}/databases/${f}`);
             foundFiles.push(...lsFiles);
           } catch (e) {}

          // Deduplicate
          foundFiles = [...new Set(foundFiles)];

          if (foundFiles.length > 0) {
             const displayFiles = foundFiles.map(f => f.replace(`${baseDir}/`, ''));
             
             allAndroidDatabases.push(...displayFiles);
             lastSuccessfulAppDir = `${baseDir}::${pkg}`;
             break;
          }
        } catch (e) {
          console.error(`Failed to list databases for app: ${pkg}`);
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

/**
 * Finds the DB file based on platform and a provided/detected filename.
 * If dbNameGlob is empty/undefined, it will auto-select the first discovered database.
 * Prioritizes iOS (simctl), falls back to Android (adb).
 * Returns the local file path (either the iOS original or a pulled Android copy).
 */
export async function syncDatabase(dbNameGlob?: string, bundleId?: string, targetPlatform?: 'ios' | 'android'): Promise<{ localPath: string, dbName: string, platform: 'ios' | 'android' }[]> {
  // First, discover available databases
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
      // Auto-select: find the first .db or .sqlite file in this location
      const preferred = loc.databases.find(d => d.endsWith('.db') || d.endsWith('.sqlite'));
      if (preferred) {
        targetDbNames.push(preferred);
      } else if (loc.databases.length > 0) {
        targetDbNames.push(loc.databases[0]); // fallback to first file
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
        
        // Find the exact path of the targetDbName
        const findCmd = `find "${appDir}" -type f -name "${targetDbName}" -maxdepth 7 -print | head -n 1`;
        try {
          const found = execSync(findCmd, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
          if (found && fs.existsSync(found)) {
            console.error(`Located iOS DB at: ${found}`);
            synced.push({ localPath: found, dbName: targetDbName, platform: 'ios' });
          }
        } catch (e) {
           console.error(`Failed to locate full path for iOS DB: ${targetDbName}`);
        }
        continue;
      }

      // --- Android Logic ---
      if (!appDir || !appDir.includes("::")) {
        console.error(`Invalid Android appDir format: ${appDir}`);
        continue;
      }
      
      const [targetDbDir, targetPkg] = appDir.split("::");
      
      try {
        execSync(`adb shell am force-stop ${targetPkg}`, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 });
      } catch (e) {
        console.error(`Failed to force-stop app: ${targetPkg}`);
      }

      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "rn-sqlite-mcp-"));
      const safeLocalName = targetDbName.replace(/\//g, '_');
      const localDb = path.join(tmpdir, safeLocalName);
      const localWal = `${localDb}-wal`;
      const localShm = `${localDb}-shm`;

      const remoteMain = `${targetDbDir}/${targetDbName}`;
      const remoteWal = `${remoteMain}-wal`;
      const remoteShm = `${remoteMain}-shm`;

   
      const pullOne = (remote: string, local: string) => {
        try {
          const remoteBase = path.basename(remote);
          const tmpRemote = `/data/local/tmp/${targetPkg}_${remoteBase}_${Date.now()}`;
          
          execSync(`adb shell "run-as '${targetPkg}' cat '${remote}' > '${tmpRemote}'"`, { stdio: 'ignore', timeout: 5000 });
          execSync(`adb pull '${tmpRemote}' '${local}'`, { stdio: 'ignore', timeout: 5000 });
          execSync(`adb shell rm '${tmpRemote}'`, { stdio: 'ignore', timeout: 3000 });
          
          return fs.existsSync(local) && fs.statSync(local).size > 0;
        } catch (e) {
          if (fs.existsSync(local)) fs.unlinkSync(local);
          return false;
        }
      };

      if (!pullOne(remoteMain, localDb)) {
        console.error(`Failed to pull main DB file from Android: ${remoteMain}`);
        continue;
      }

      pullOne(remoteWal, localWal);
      pullOne(remoteShm, localShm);

      console.error(`Pulled Android DB to local temp: ${localDb}`);
      synced.push({ localPath: localDb, dbName: targetDbName, platform: 'android' });
    }
  }

  if (synced.length === 0) {
    throw new Error(`Failed to sync any databases matching '${dbNameGlob || 'auto-select'}'.`);
  }

  return synced;
}
