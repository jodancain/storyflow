import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { Store } from "../server/store.ts";
import { acquireDataLock } from "../server/data-lock.ts";
import { backup } from "../scripts/backup.ts";
import { restore } from "../scripts/restore.ts";
import { archive } from "../scripts/maintenance.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "storyflow-maint-")),
    data = join(root, "data"),
    store = new Store(data),
    bytes = Buffer.from("approved doctor audio fixture"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  store.setSetting("test", "preserved");
  store.db
    .prepare("INSERT INTO files VALUES(?,?,?)")
    .run(
      "file-1",
      "project-1",
      JSON.stringify({
        relativePath: `files/${sha256}`,
        sha256,
        bytes: bytes.length,
      }),
    );
  writeFileSync(join(data, "files", sha256), bytes);
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?)")
    .run("old-session", Date.now() + 100000);
  store.close();
  return {
    root,
    data,
    sha256,
    bytes,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("process lock refuses overlapping runtime and maintenance without stealing", () => {
  const root = mkdtempSync(join(tmpdir(), "storyflow-lock-"));
  try {
    const release = acquireDataLock(root, "runtime");
    assert.throws(
      () => acquireDataLock(root, "backup"),
      (e: any) => e.code === "DATA_LOCKED",
    );
    release();
    release();
    const next = acquireDataLock(root, "restore");
    next();
    assert.ok(existsSync(join(root, ".storyflow-lock.sqlite")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite process mutex releases after SIGKILL despite stale diagnostic file", async () => {
  const root = mkdtempSync(join(tmpdir(), "storyflow-lock-crash-"));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {acquireDataLock} from ${JSON.stringify(new URL("../server/data-lock.ts", import.meta.url).href)};const release=acquireDataLock(${JSON.stringify(root)},'runtime');console.log('ready');setInterval(()=>void release,1000)`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error("Child lock process exited before ready");
      }),
    ]);
    assert.throws(
      () => acquireDataLock(root, "backup"),
      (e: any) => e.code === "DATA_LOCKED",
    );
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.ok(existsSync(join(root, ".storyflow.lock")));
    const release = acquireDataLock(root, "backup");
    release();
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup and restore refuse active server; snapshot preserves asset hashes and clears sessions", async () => {
  const f = fixture();
  try {
    const output = join(f.root, "backup.tar"),
      release = acquireDataLock(f.data, "runtime");
    await assert.rejects(
      backup(f.data, output),
      (e: any) => e.code === "DATA_LOCKED",
    );
    await assert.rejects(
      restore(f.data, output, true),
      (e: any) => e.code === "DATA_LOCKED",
    );
    release();
    const result = await backup(f.data, output);
    assert.equal(result.assets, 1);
    await assert.rejects(backup(f.data, output), /already exists/);
    const dest = join(f.root, "restored");
    const restored = await restore(dest, output);
    assert.equal(restored.assets, 1);
    assert.equal(restored.rollback, null);
    const db = new Store(dest);
    assert.equal(db.setting("test"), "preserved");
    assert.equal(
      (db.db.prepare("SELECT count(*) AS n FROM sessions").get() as any).n,
      0,
    );
    assert.deepEqual(readFileSync(join(dest, "files", f.sha256)), f.bytes);
    db.close();
    await assert.rejects(restore(dest, output), /--replace/);
    const replaced = await restore(dest, output, true);
    assert.ok(
      replaced.rollback &&
        existsSync(join(replaced.rollback, "storyflow.sqlite")),
    );
  } finally {
    f.clean();
  }
});

test("tampered backup fails before replacing existing database", async () => {
  const f = fixture();
  try {
    const output = join(f.root, "good.tar");
    await backup(f.data, output);
    const stage = join(f.root, "unpacked");
    mkdirSync(stage);
    await archive("unpack", output, stage);
    writeFileSync(join(stage, "files", f.sha256), "tampered");
    const bad = join(f.root, "bad.tar");
    await archive("pack", bad, stage);
    await assert.rejects(restore(f.data, bad, true), /mismatch/);
    const db = new Store(f.data);
    assert.equal(db.setting("test"), "preserved");
    db.close();
    assert.deepEqual(readFileSync(join(f.data, "files", f.sha256)), f.bytes);
  } finally {
    f.clean();
  }
});

test("archive extraction rejects traversal and symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "storyflow-archive-"));
  try {
    for (const kind of ["traversal", "symlink"]) {
      const path = join(root, `${kind}.tar`);
      execFileSync(process.env.PYTHON || "python3", [
        "-c",
        `import io,tarfile,sys
with tarfile.open(sys.argv[1],'w') as t:
 i=tarfile.TarInfo('../escaped' if sys.argv[2]=='traversal' else 'files/'+'a'*64)
 if sys.argv[2]=='symlink': i.type=tarfile.SYMTYPE; i.linkname='/etc/passwd'; t.addfile(i)
 else: i.size=1; t.addfile(i,io.BytesIO(b'x'))
`,
        path,
        kind,
      ]);
      const target = join(root, kind);
      mkdirSync(target);
      await assert.rejects(archive("unpack", path, target), /Unsafe/);
      assert.equal(existsSync(join(root, "escaped")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
