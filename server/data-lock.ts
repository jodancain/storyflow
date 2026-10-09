import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

/** Process mutex: SQLite releases this lock even after SIGKILL. Never unlink its DB. */
export function acquireDataLock(
  directory: string,
  role: "runtime" | "backup" | "restore",
): () => void {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, ".storyflow-lock.sqlite"));
  const token = randomUUID(),
    marker = join(root, ".storyflow.lock");
  let held = false;
  try {
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS mutex(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE",
    );
    held = true;
    writeFileSync(
      marker,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        role,
        token,
        startedAt: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600 },
    );
  } catch (error) {
    if (held)
      try {
        db.exec("ROLLBACK");
      } catch {}
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    if (/locked|busy/i.test(message))
      throw Object.assign(
        new Error(
          "StoryFlow data is in use. Stop its server and wait for active work to stop before maintenance.",
        ),
        { code: "DATA_LOCKED" },
      );
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (JSON.parse(readFileSync(marker, "utf8")).token === token)
        rmSync(marker);
    } catch {}
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  };
}
