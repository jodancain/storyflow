import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { acquireDataLock } from "../server/data-lock.ts";
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
  const release = acquireDataLock(dataDir, "restore"),
    stage = join(dataDir, `.restore-${randomUUID()}`),
    rollback = join(
      dataDir,
      `.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    );
  let installed = false;
  const old: string[] = [],
    added: string[] = [];
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
    mkdirSync(rollback, { mode: 0o700 });
    for (const name of [
      "storyflow.sqlite",
      "storyflow.sqlite-wal",
      "storyflow.sqlite-shm",
      "files",
      "work",
    ])
      if (existsSync(join(dataDir, name))) {
        renameSync(join(dataDir, name), join(rollback, name));
        old.push(name);
      }
    for (const name of ["storyflow.sqlite", "files"]) {
      renameSync(join(stage, name), join(dataDir, name));
      added.push(name);
    }
    if(existsSync(join(stage,"work"))) renameSync(join(stage,"work"),join(dataDir,"work"));
    else mkdirSync(join(dataDir, "work"), { recursive: true, mode: 0o700 });
    added.push("work");
    installed = true;
    return {
      assets: manifest.assets.length,
      receipts: manifest.receipts?.length || 0,
      createdAt: manifest.createdAt,
      rollback: old.length ? rollback : null,
      restored: true,
      sessionsCleared: true,
    };
  } catch (error) {
    if (!installed) {
      for (const name of added)
        rmSync(join(dataDir, name), { recursive: true, force: true });
      for (const name of old.reverse())
        renameSync(join(rollback, name), join(dataDir, name));
    }
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (!old.length) rmSync(rollback, { recursive: true, force: true });
    release();
  }
}
if (isMain(import.meta.url)) {
  loadDotEnv();
  try {
    const args = cliArgs();
    if (typeof args.input !== "string")
      throw new Error(
        "Usage: npm run restore -- --input /private/storyflow.tar [--data-dir /data] [--replace]",
      );
    console.log(
      JSON.stringify(
        await restore(
          typeof args["data-dir"] === "string"
            ? args["data-dir"]
            : configFromEnv().dataDir,
          args.input,
          args.replace === true,
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
