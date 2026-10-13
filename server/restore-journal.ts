import { createHash } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const RESTORE_JOURNAL = ".storyflow-restore.json";
export const RESTORE_NAMES = ["storyflow.sqlite", "storyflow.sqlite-wal", "storyflow.sqlite-shm", "files", "work"] as const;
type Name = typeof RESTORE_NAMES[number];
export type RestoreEntry = { name: Name; dev: number; ino: number; kind: "file" | "directory"; sha256: string };
export type RestoreJournal = {
  version: 1; id: string; createdAt: string; stage: string; rollback: string;
  old: RestoreEntry[]; replacement: RestoreEntry[];
};
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function pathExists(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function syncDirectory(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Do not follow links in either a journal or a candidate recovery tree. */
function treeHash(path: string, durable: boolean): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
    throw new Error("Restore evidence must contain only regular files and directories");
  if (info.isFile()) {
    const h = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024), fd = openSync(path, "r");
    try {
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) h.update(buffer.subarray(0, count));
      if (durable) fsyncSync(fd);
    } finally { closeSync(fd); }
    return h.digest("hex");
  }
  const entries = readdirSync(path).sort().map(name => {
    const child = join(path, name);
    return [name, lstatSync(child).isDirectory() ? "directory" : "file", treeHash(child, durable)];
  });
  if (durable) syncDirectory(path);
  return hash(JSON.stringify(entries));
}

export function captureRestoreEntry(root: string, name: Name, durable = false): RestoreEntry {
  const path = join(root, name), stat = lstatSync(path);
  return { name, dev: stat.dev, ino: stat.ino, kind: stat.isDirectory() ? "directory" : "file", sha256: treeHash(path, durable) };
}

export function restoreRecoveryError(detail = "Interrupted restore detected") {
  return Object.assign(new Error(`${detail}. StoryFlow will not open or initialize this data directory. Stop all StoryFlow processes, preserve the journal and its stage/rollback directories, then run: npm run restore -- --recover rollback --data-dir <this-data-directory>`), { code: "RESTORE_INCOMPLETE" });
}

/** Called before Store can create files, and again while holding the process mutex. */
export function assertNoInterruptedRestore(root: string) {
  if (pathExists(join(root, RESTORE_JOURNAL))) throw restoreRecoveryError();
  if (pathExists(root) && !pathExists(join(root, "storyflow.sqlite")) &&
      readdirSync(root).some(name => name.startsWith(".before-restore-") && pathExists(join(root, name, "storyflow.sqlite"))))
    throw restoreRecoveryError("A legacy restore rollback exists but the active database is missing; no journal is available for automatic recovery");
}

export function writeRestoreJournal(root: string, journal: RestoreJournal) {
  assertNoInterruptedRestore(root);
  const path = join(root, RESTORE_JOURNAL);
  // An exclusive durable file is installed before the first data rename. A torn
  // journal remains a startup blocker rather than permitting an empty database.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ payload: journal, sha256: hash(JSON.stringify(journal)) }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(root);
}

export function readRestoreJournal(root: string): RestoreJournal {
  const path = join(root, RESTORE_JOURNAL), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024)
    throw restoreRecoveryError("Unsafe restore journal");
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw restoreRecoveryError("Unreadable restore journal; manual forensic recovery required"); }
  const j = parsed.payload as RestoreJournal;
  if (!j || parsed.sha256 !== hash(JSON.stringify(j)) || j.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(j.id) || j.stage !== `.restore-${j.id}` ||
      !/^\.before-restore-[0-9TZ-]+-[a-f0-9-]{36}$/.test(j.rollback) ||
      !Array.isArray(j.old) || !Array.isArray(j.replacement))
    throw restoreRecoveryError("Invalid restore journal hash or paths");
  for (const list of [j.old, j.replacement]) {
    if (list.length > RESTORE_NAMES.length || new Set(list.map(item => item?.name)).size !== list.length)
      throw restoreRecoveryError("Invalid restore inventory");
    for (const item of list)
      if (!item || !RESTORE_NAMES.includes(item.name) || !["file", "directory"].includes(item.kind) ||
          !Number.isSafeInteger(item.dev) || !Number.isSafeInteger(item.ino) ||
          !/^[a-f0-9]{64}$/.test(item.sha256) ||
          (item.kind === "directory") !== ["files", "work"].includes(item.name))
        throw restoreRecoveryError("Invalid restore entry");
  }
  if (j.replacement.length !== 3 || !["storyflow.sqlite", "files", "work"].every(name => j.replacement.some(item => item.name === name)))
    throw restoreRecoveryError("Incomplete replacement inventory");
  const identities = [...j.old, ...j.replacement].map(item => `${item.dev}:${item.ino}`);
  if (new Set(identities).size !== identities.length)
    throw restoreRecoveryError("Restore source and replacement identities overlap");
  for (const name of [j.stage, j.rollback]) {
    const stat = lstatSync(join(root, name));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw restoreRecoveryError("Unsafe restore evidence directory");
  }
  return j;
}

function matches(root: string, entry: RestoreEntry) {
  if (!pathExists(join(root, entry.name))) return false;
  const observed = captureRestoreEntry(root, entry.name);
  return observed.dev === entry.dev && observed.ino === entry.ino && observed.kind === entry.kind && observed.sha256 === entry.sha256;
}

/** Classify all locations before moving anything; never overwrite ambiguous data. */
export function inspectRestore(root: string, j: RestoreJournal) {
  const stage = join(root, j.stage), rollback = join(root, j.rollback);
  const states: { name: Name; oldAt?: "live" | "rollback"; newAt?: "live" | "stage" }[] = [];
  for (const name of RESTORE_NAMES) {
    const previous = j.old.find(entry => entry.name === name), next = j.replacement.find(entry => entry.name === name);
    const liveExists = pathExists(join(root, name)), oldExists = pathExists(join(rollback, name)), newExists = pathExists(join(stage, name));
    const liveOld = previous ? matches(root, previous) : false;
    const savedOld = previous ? matches(rollback, previous) : false;
    const liveNew = next ? matches(root, next) : false;
    const stagedNew = next ? matches(stage, next) : false;
    if ((liveExists && !liveOld && !liveNew) || (oldExists && !savedOld) || (newExists && !stagedNew) ||
        (previous && Number(liveOld) + Number(savedOld) !== 1) ||
        (next && Number(liveNew) + Number(stagedNew) !== 1))
      throw restoreRecoveryError(`Ambiguous or changed restore evidence for ${name}; no files moved`);
    states.push({ name, ...(previous ? { oldAt: liveOld ? "live" as const : "rollback" as const } : {}), ...(next ? { newAt: liveNew ? "live" as const : "stage" as const } : {}) });
  }
  return states;
}

export function durableRename(from: string, to: string) {
  if (pathExists(to)) throw restoreRecoveryError("Recovery destination already exists");
  renameSync(from, to);
  syncDirectory(dirname(from));
  if (dirname(to) !== dirname(from)) syncDirectory(dirname(to));
}

export function clearRestoreJournal(root: string) {
  rmSync(join(root, RESTORE_JOURNAL));
  syncDirectory(root);
}
