import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { acquireDataLock } from "../server/data-lock.ts";
import {
  RESTORE_JOURNAL, RESTORE_NAMES, captureRestoreEntry, clearRestoreJournal,
  durableRename, inspectRestore, pathExists, readRestoreJournal,
  restoreRecoveryError, syncDirectory, writeRestoreJournal,
  type RestoreJournal,
} from "../server/restore-journal.ts";
import { configFromEnv, loadDotEnv } from "../server/config.ts";
import {
  archive,
  cliArgs,
  inside,
  isMain,
  verifyArchive,
} from "./maintenance.ts";

export async function restore(dataDir: string, input: string, replace = false) {
  dataDir = resolve(dataDir);
  input = resolve(input);
  if (inside(dataDir, input))
    throw new Error("Restore archive must be outside the data directory");
  const release = acquireDataLock(dataDir, "restore"), id = randomUUID(),
    stageName = `.restore-${id}`,
    rollbackName = `.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    stage = join(dataDir, stageName),
    rollback = join(
      dataDir,
      rollbackName,
    );
  let committed = false, journal: RestoreJournal | undefined;
  try {
    const existing =
      existsSync(join(dataDir, "storyflow.sqlite")) ||
      ["files", "work"].some(
        (name) =>
          existsSync(join(dataDir, name)) &&
          readdirSync(join(dataDir, name)).length > 0,
      );
    if (existing && !replace)
      throw new Error(
        "Target has data; stop the server and pass --replace explicitly. Existing data will be kept in a rollback directory.",
      );
    mkdirSync(stage, { mode: 0o700 });
    await archive("unpack", input, stage);
    const manifest = await verifyArchive(stage);
    mkdirSync(join(stage, "files"), { recursive: true, mode: 0o700 });
    // Backup includes private password hash, but old login sessions must not survive restore.
    const db = new DatabaseSync(join(stage, "storyflow.sqlite"));
    try {
      db.exec("DELETE FROM sessions; PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    mkdirSync(join(stage, "work"), { recursive: true, mode: 0o700 });
    mkdirSync(rollback, { mode: 0o700 });
    journal = {
      version: 1, id, createdAt: new Date().toISOString(), stage: stageName, rollback: rollbackName,
      old: RESTORE_NAMES.filter(name => pathExists(join(dataDir, name))).map(name => captureRestoreEntry(dataDir, name, true)),
      replacement: (["storyflow.sqlite", "files", "work"] as const).map(name => captureRestoreEntry(stage, name, true)),
    };
    syncDirectory(stage);
    syncDirectory(rollback);
    writeRestoreJournal(dataDir, journal);
    // From this point, all error/kill paths retain both trees and the journal.
    // Startup refuses to open a mixed tree or silently create an empty DB.
    for (const entry of journal.old) durableRename(join(dataDir, entry.name), join(rollback, entry.name));
    for (const entry of journal.replacement) durableRename(join(stage, entry.name), join(dataDir, entry.name));
    const installed = inspectRestore(dataDir, journal);
    if (installed.some(item => (item.oldAt && item.oldAt !== "rollback") || (item.newAt && item.newAt !== "live")))
      throw restoreRecoveryError("Restore installation did not reach its complete state");
    clearRestoreJournal(dataDir);
    committed = true;
    return {
      assets: manifest.assets.length,
      receipts: manifest.receipts?.length || 0,
      createdAt: manifest.createdAt,
      rollback: journal.old.length ? rollback : null,
      restored: true,
      sessionsCleared: true,
    };
  } catch (error) {
    if (pathExists(join(dataDir, RESTORE_JOURNAL)))
      throw restoreRecoveryError(`Restore interrupted (${error instanceof Error ? error.message : String(error)})`);
    throw error;
  } finally {
    try {
      // Never erase the only copy of old/new data after an interrupted rename.
      if (committed || !pathExists(join(dataDir, RESTORE_JOURNAL))) {
        rmSync(stage, { recursive: true, force: true });
        if (!journal?.old.length) rmSync(rollback, { recursive: true, force: true });
      }
    } finally { release(); }
  }
}

/** Explicit operator action; both the failed replacement and journal are retained. */
export function recoverRestore(dataDir: string) {
  dataDir = resolve(dataDir);
  const release = acquireDataLock(dataDir, "restore-recovery");
  try {
    const journal = readRestoreJournal(dataDir);
    const states = inspectRestore(dataDir, journal);
    const stage = join(dataDir, journal.stage), rollback = join(dataDir, journal.rollback);
    for (const item of states)
      if (item.newAt === "live") durableRename(join(dataDir, item.name), join(stage, item.name));
    for (const item of states)
      if (item.oldAt === "rollback") durableRename(join(rollback, item.name), join(dataDir, item.name));
    const recovered = inspectRestore(dataDir, journal);
    if (recovered.some(item => (item.oldAt && item.oldAt !== "live") || (item.newAt && item.newAt !== "stage")))
      throw restoreRecoveryError("Rollback did not reach its complete state");
    durableRename(join(dataDir, RESTORE_JOURNAL), join(stage, "recovery-journal.json"));
    return { recovered: true, action: "rollback", dataDir, preservedReplacement: stage, preservedRollback: rollback };
  } finally { release(); }
}

if (isMain(import.meta.url)) {
  loadDotEnv();
  try {
    const args = cliArgs();
    if (args.recover && (args.recover !== "rollback" || args.input || args.replace))
      throw new Error("Recovery requires --recover rollback without --input or --replace");
    if (!args.recover && typeof args.input !== "string")
      throw new Error(
        "Usage: npm run restore -- --input /private/storyflow.tar [--data-dir /data] [--replace]; interrupted restore: npm run restore -- --recover rollback --data-dir /data",
      );
    const dataDir = typeof args["data-dir"] === "string" ? args["data-dir"] : configFromEnv().dataDir;
    console.log(
      JSON.stringify(
        args.recover ? recoverRestore(dataDir) : await restore(dataDir, args.input as string, args.replace === true),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
