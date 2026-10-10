import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  createReadStream,
  statSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export type Entry = { path: string; sha256: string; bytes: number };
export type Manifest = {
  format: "storyflow-private-backup";
  version: 1;
  createdAt: string;
  database: Entry;
  assets: Entry[];
  receipts?: Entry[];
  excluded: string[];
};
export function inside(root: string, path: string) {
  const r = relative(resolve(root), resolve(path));
  return (
    r === "" ||
    (!isAbsolute(r) &&
      r !== ".." &&
      !r.startsWith(".." + (process.platform === "win32" ? "\\" : "/")))
  );
}
export async function digest(path: string) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("Backup entries must be regular files");
  const hash = createHash("sha256");
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest("hex");
}
export async function entry(root: string, path: string): Promise<Entry> {
  const file = join(root, path);
  return { path, sha256: await digest(file), bytes: statSync(file).size };
}
export function databaseAssets(path: string): Entry[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      (db.prepare("PRAGMA integrity_check").get() as any)?.integrity_check !==
      "ok"
    )
      throw new Error("SQLite integrity check failed");
    if (![1, 2].includes((db.prepare("PRAGMA user_version").get() as any)?.user_version))
      throw new Error("Unsupported database schema");
    const assets = new Map<string, Entry>();
    for (const row of db.prepare("SELECT json FROM files").all() as any[]) {
      const f = JSON.parse(row.json);
      if (
        !/^files\/[a-f0-9]{64}$/.test(f.relativePath) ||
        f.relativePath !== `files/${f.sha256}` ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 0
      )
        throw new Error("Invalid asset record");
      const old = assets.get(f.relativePath);
      if (old && old.bytes !== f.bytes)
        throw new Error("Conflicting asset records");
      assets.set(f.relativePath, {
        path: f.relativePath,
        sha256: f.sha256,
        bytes: f.bytes,
      });
    }
    return [...assets.values()].sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    db.close();
  }
}
/** These response receipts are durable task evidence, not disposable rendering cache. */
export function databaseImageReceipts(path: string): {path:string;required:boolean}[] {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    return (db.prepare("SELECT json FROM jobs").all() as any[]).flatMap(row=>{
      const job=JSON.parse(row.json);
      if(job.kind !== "image") return [];
      if(!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error("Invalid image job identity");
      return [{path:`work/${job.id}/image-receipt.json`,required:job.result?.imageReceiptStored === true && !["complete","cancelled"].includes(job.state)}];
    });
  } finally { db.close(); }
}
export async function verifyEntry(root: string, item: Entry) {
  if (
    !item ||
    !Number.isSafeInteger(item.bytes) ||
    item.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(item.sha256)
  )
    throw new Error("Invalid backup manifest");
  const actual = await entry(root, item.path);
  if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256)
    throw new Error(`Backup hash or size mismatch: ${item.path}`);
}
export async function verifyArchive(root: string): Promise<Manifest> {
  const m = JSON.parse(
    readFileSync(join(root, "manifest.json"), "utf8"),
  ) as Manifest;
  if (
    m.format !== "storyflow-private-backup" ||
    m.version !== 1 ||
    m.database?.path !== "storyflow.sqlite" ||
    !Array.isArray(m.assets) ||
    m.assets.length > 100000
  )
    throw new Error("Unsupported backup manifest");
  await verifyEntry(root, m.database);
  const records = databaseAssets(join(root, "storyflow.sqlite"));
  if (records.length !== m.assets.length)
    throw new Error("Backup asset inventory mismatch");
  const names = new Set<string>();
  for (const item of m.assets) {
    if (!/^files\/[a-f0-9]{64}$/.test(item.path) || names.has(item.path))
      throw new Error("Invalid backup asset path");
    names.add(item.path);
    const record = records.find((r) => r.path === item.path);
    if (!record || record.sha256 !== item.sha256 || record.bytes !== item.bytes)
      throw new Error("Database and backup asset mismatch");
    await verifyEntry(root, item);
  }
  const receipts=m.receipts || [];
  if(!Array.isArray(receipts) || receipts.length>100000) throw new Error("Invalid receipt inventory");
  const expectedReceipts=databaseImageReceipts(join(root,"storyflow.sqlite"));
  const receiptNames=new Set<string>();
  for(const item of receipts) {
    if(!/^work\/[a-f0-9-]{36}\/image-receipt\.json$/.test(item.path) || item.bytes>64*1024*1024 || receiptNames.has(item.path) || !expectedReceipts.some(r=>r.path===item.path)) throw new Error("Invalid image receipt path or owner");
    receiptNames.add(item.path); await verifyEntry(root,item);
  }
  if(expectedReceipts.some(r=>r.required && !receiptNames.has(r.path))) throw new Error("Backup is missing an accepted image response receipt; refusing a restore that cannot resume safely");
  try {
    for(const directory of readdirSync(join(root,"work"))) {
      const folder=join(root,"work",directory);
      if(!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw new Error("Invalid receipt directory");
      for(const name of readdirSync(folder)) if(!receiptNames.has(`work/${directory}/${name}`)) throw new Error("Archive contains unreferenced work files");
    }
  } catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let entries: string[] = [];
  try {
    entries = readdirSync(join(root, "files"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    entries.length !== m.assets.length ||
    entries.some((name) => !names.has(`files/${name}`))
  )
    throw new Error("Archive contains unreferenced assets");
  return m;
}
export async function archive(
  mode: "pack" | "unpack",
  archivePath: string,
  directory: string,
) {
  await new Promise<void>((resolvePromise, reject) => {
    const p = spawn(
      process.env.PYTHON || "python3",
      [
        fileURLToPath(new URL("./archive_io.py", import.meta.url)),
        mode,
        archivePath,
        directory,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    p.stderr.on("data", (b) => (errors = (errors + b).slice(-3000)));
    p.once("error", reject);
    p.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(errors || "Archive process failed")),
    );
  });
}
export function cliArgs(args = process.argv.slice(2)) {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--replace") result.replace = true;
    else if (["--output", "--input", "--data-dir"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      result[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}
export const isMain = (url: string) =>
  Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url));
