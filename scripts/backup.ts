import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { acquireDataLock } from "../server/data-lock.ts";
import { configFromEnv, loadDotEnv } from "../server/config.ts";
import {
  archive,
  cliArgs,
  databaseAssets,
  entry,
  inside,
  isMain,
  verifyEntry,
  type Manifest,
} from "./maintenance.ts";

export async function backup(dataDir: string, output: string) {
  dataDir = resolve(dataDir);
  output = resolve(output);
  if (inside(dataDir, output))
    throw new Error("Write backups outside the active data directory");
  if (existsSync(output)) throw new Error("Backup destination already exists");
  if (!existsSync(join(dataDir, "storyflow.sqlite")))
    throw new Error("StoryFlow database does not exist");
  const release = acquireDataLock(dataDir, "backup"),
    stage = join(dataDir, `.backup-${randomUUID()}`),
    temporary = join(dirname(output), `.storyflow-backup-${randomUUID()}.tar`);
  try {
    mkdirSync(join(stage, "files"), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(output), { recursive: true });
    const db = new DatabaseSync(join(dataDir, "storyflow.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=0");
      const checkpoint = db
        .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
        .get() as any;
      if (checkpoint.busy)
        throw new Error(
          "Database has a writer outside the StoryFlow maintenance lock",
        );
      db.prepare("VACUUM INTO ?").run(join(stage, "storyflow.sqlite"));
    } finally {
      db.close();
    }
    chmodSync(join(stage, "storyflow.sqlite"), 0o600);
    const assets = databaseAssets(join(stage, "storyflow.sqlite"));
    for (const asset of assets) {
      await verifyEntry(dataDir, asset);
      copyFileSync(join(dataDir, asset.path), join(stage, asset.path));
      chmodSync(join(stage, asset.path), 0o600);
    }
    const manifest: Manifest = {
      format: "storyflow-private-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      database: await entry(stage, "storyflow.sqlite"),
      assets,
      excluded: [
        "environment and provider credentials",
        "work render cache",
        "process mutex",
        "prior restore rollback directories",
      ],
    };
    writeFileSync(
      join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    await archive("pack", temporary, stage);
    chmodSync(temporary, 0o600);
    if (existsSync(output))
      throw new Error("Backup destination appeared during maintenance");
    renameSync(temporary, output);
    return {
      output,
      assets: assets.length,
      bytes: manifest.database.bytes + assets.reduce((n, a) => n + a.bytes, 0),
      databaseHash: manifest.database.sha256,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(temporary, { force: true });
    release();
  }
}
if (isMain(import.meta.url)) {
  loadDotEnv();
  try {
    const args = cliArgs();
    if (typeof args.output !== "string")
      throw new Error(
        "Usage: npm run backup -- --output /private/storyflow.tar [--data-dir /data]",
      );
    console.log(
      JSON.stringify(
        await backup(
          typeof args["data-dir"] === "string"
            ? args["data-dir"]
            : configFromEnv().dataDir,
          args.output,
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
