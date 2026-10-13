import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { Store } from "../server/store.ts";
import { acquireDataLock } from "../server/data-lock.ts";
import { backup } from "../scripts/backup.ts";
import { restore, recoverRestore } from "../scripts/restore.ts";
import { archive, cliArgs } from "../scripts/maintenance.ts";
import { RESTORE_JOURNAL } from "../server/restore-journal.ts";

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

function killRestore(data: string, input: string, point: string) {
  const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import path from 'node:path';
const data=${JSON.stringify(data)},point=${JSON.stringify(point)},orig=fs.renameSync;
fs.renameSync=function(a,b){orig(a,b);const old=String(a)===path.join(data,'storyflow.sqlite');
const fresh=String(a).includes('/.restore-') && !String(a).includes('/.before-restore-');
if((point==='old-db' && old)||(point==='new-db' && fresh && String(b)===path.join(data,'storyflow.sqlite'))||(point==='new-files' && fresh && String(b)===path.join(data,'files')))process.kill(process.pid,'SIGKILL');};
syncBuiltinESMExports();const {restore}=await import(${JSON.stringify(new URL("../scripts/restore.ts", import.meta.url).href)});await restore(data,${JSON.stringify(input)},true);`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.signal, "SIGKILL", result.stderr);
  assert.equal(result.error, undefined);
}

test("real SIGKILL at three restore rename windows blocks startup and explicit rollback preserves original bytes", async () => {
  for (const point of ["old-db", "new-db", "new-files"]) {
    const f = fixture();
    try {
      const input = join(f.root, "snapshot.tar");
      await backup(f.data, input);
      const original = readFileSync(join(f.data, "storyflow.sqlite"));
      killRestore(f.data, input, point);
      assert.ok(existsSync(join(f.data, RESTORE_JOURNAL)));
      const before = readdirSync(f.data).sort();
      assert.throws(() => new Store(f.data), (e: any) => e.code === "RESTORE_INCOMPLETE");
      assert.deepEqual(readdirSync(f.data).sort(), before, "Store must not create missing DB/files/work");
      for (const role of ["runtime", "backup", "restore"] as const)
        assert.throws(() => acquireDataLock(f.data, role), (e: any) => e.code === "RESTORE_INCOMPLETE");
      // Exercise the real CLI rather than only calling the recovery function.
      const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/restore.ts", "--recover", "rollback", "--data-dir", f.data], { encoding: "utf8" }));
      assert.equal(result.recovered, true);
      assert.deepEqual(readFileSync(join(f.data, "storyflow.sqlite")), original);
      assert.deepEqual(readFileSync(join(f.data, "files", f.sha256)), f.bytes);
      assert.ok(existsSync(join(result.preservedReplacement, "storyflow.sqlite")));
      assert.ok(existsSync(join(result.preservedReplacement, "files", f.sha256)));
      assert.ok(existsSync(join(result.preservedReplacement, "recovery-journal.json")));
      assert.equal(existsSync(join(f.data, RESTORE_JOURNAL)), false);
      const db = new Store(f.data);
      assert.equal(db.setting("test"), "preserved");
      assert.equal((db.db.prepare("SELECT count(*) AS n FROM sessions").get() as any).n, 1, "rollback preserves original session state");
      db.close();
    } finally { f.clean(); }
  }
});

test("interrupted restore rejects changed evidence, journal hash/path tampering and symlinks without deleting copies", async () => {
  for (const kind of ["changed", "hash", "path", "link"]) {
    const f = fixture();
    try {
      const input = join(f.root, "snapshot.tar"); await backup(f.data, input);
      killRestore(f.data, input, "new-db");
      const journalPath = join(f.data, RESTORE_JOURNAL), bytes = readFileSync(journalPath);
      const envelope = JSON.parse(bytes.toString()), j = envelope.payload;
      const oldDb = join(f.data, j.rollback, "storyflow.sqlite"), oldBytes = readFileSync(oldDb);
      if (kind === "changed") writeFileSync(join(f.data, "storyflow.sqlite"), "changed installed database");
      if (kind === "hash") writeFileSync(journalPath, JSON.stringify({ ...envelope, sha256: "0".repeat(64) }));
      if (kind === "path") {
        j.stage = "../outside"; envelope.sha256 = createHash("sha256").update(JSON.stringify(j)).digest("hex");
        writeFileSync(journalPath, JSON.stringify(envelope));
      }
      if (kind === "link") { rmSync(journalPath); const target = join(f.root, "journal.json"); writeFileSync(target, bytes); symlinkSync(target, journalPath); }
      assert.throws(() => recoverRestore(f.data));
      assert.throws(() => new Store(f.data), (e: any) => e.code === "RESTORE_INCOMPLETE");
      assert.deepEqual(readFileSync(oldDb), oldBytes);
      assert.deepEqual(readFileSync(join(f.data, envelope.payload.rollback, "files", f.sha256)), f.bytes);
      assert.ok(existsSync(journalPath));
    } finally { f.clean(); }
  }
});

test("explicit rollback interrupted by a second SIGKILL resumes from evidence without losing either tree", async () => {
  for (const point of ["save-replacement", "restore-original"]) {
    const f = fixture();
    try {
      const input = join(f.root, "snapshot.tar"); await backup(f.data, input);
      const original = readFileSync(join(f.data, "storyflow.sqlite"));
      killRestore(f.data, input, "new-files");
      const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import path from 'node:path';
const data=${JSON.stringify(f.data)},point=${JSON.stringify(point)},orig=fs.renameSync;
fs.renameSync=function(a,b){orig(a,b);if((point==='save-replacement'&&String(a)===path.join(data,'storyflow.sqlite'))||(point==='restore-original'&&String(a).includes('/.before-restore-')&&String(b)===path.join(data,'storyflow.sqlite')))process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();
const {recoverRestore}=await import(${JSON.stringify(new URL("../scripts/restore.ts", import.meta.url).href)});recoverRestore(data);`;
      const crash = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000 });
      assert.equal(crash.signal, "SIGKILL", crash.stderr);
      assert.throws(() => new Store(f.data), (e: any) => e.code === "RESTORE_INCOMPLETE");
      const result = recoverRestore(f.data);
      assert.deepEqual(readFileSync(join(f.data, "storyflow.sqlite")), original);
      assert.deepEqual(readFileSync(join(f.data, "files", f.sha256)), f.bytes);
      assert.ok(existsSync(join(result.preservedReplacement, "storyflow.sqlite")));
      assert.ok(existsSync(join(result.preservedReplacement, "files", f.sha256)));
      const db = new Store(f.data); assert.equal(db.setting("test"), "preserved"); db.close();
    } finally { f.clean(); }
  }
});

test("legacy interrupted replacement cannot silently initialize an empty Store; recovery arguments stay explicit", () => {
  const f = fixture();
  try {
    const rollback = join(f.data, ".before-restore-legacy"); mkdirSync(rollback);
    execFileSync(process.execPath, ["-e", "require('fs').renameSync(process.argv[1],process.argv[2])", join(f.data, "storyflow.sqlite"), join(rollback, "storyflow.sqlite")]);
    assert.throws(() => new Store(f.data), /legacy restore rollback/);
    assert.equal(existsSync(join(f.data, "storyflow.sqlite")), false);
    assert.equal(cliArgs(["--recover", "rollback", "--data-dir", f.data]).recover, "rollback");
    assert.throws(() => cliArgs(["--recover"]), /Missing value/);
  } finally { f.clean(); }
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

test("schema 2 backup preserves review submissions and accepted image receipts so restore downloads without a second POST",async()=>{
 const {Jobs}=await import("../server/jobs.ts"),{Providers}=await import("../server/providers.ts");
 const {fixture:ontologyFixture,requirements,mockMedia}=await import("./helpers.ts");
 const root=mkdtempSync(join(tmpdir(),"storyflow-receipt-backup-")),data=join(root,"data");
 let store=new Store(data);let posts=0,gets=0,offline=true;
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeYAAAAASUVORK5CYII=","base64");
 const providers=new Providers({imageBase:"http://fixture.invalid/v1",imageKey:"test-only",seedanceBase:"",seedanceKey:"",seedanceModel:"",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true},{fetchImpl:(async(_url:any,options:any)=>{
  if(options.method==="POST"){posts++;return new Response(JSON.stringify({data:[{url:"http://fixture.invalid/image.png"}]}));}
  gets++;if(offline)throw new Error("offline");return new Response(png);
 }) as any});
 try {
  const o=ontologyFixture();o.assets.push({id:"ref",label:"测试人物",kind:"image",purpose:"production",gap:true});
  const project=store.create("backup",requirements,o),jobs=new Jobs(store,providers,mockMedia());jobs.stopped=true;
  const job=jobs.enqueueImages(project.id,1,"backup-image",[{assetId:"ref"}]).jobs[0];
  jobs.stopped=false;await jobs.tick();jobs.stopped=true;
  assert.equal(store.job(job.id).state,"failed");assert.equal(posts,1);assert.equal(gets,1);
  store.recordReviewSubmission({id:"history-1",projectId:project.id,baseRevision:1,createdAt:new Date().toISOString(),items:[]});
  writeFileSync(join(store.workDir(job.id),"unneeded-render-cache.png"),"cache");
  store.close();
  const tar=join(root,"backup.tar"),copied=await backup(data,tar);assert.equal(copied.receipts,1);
  const destination=join(root,"restored"),restored=await restore(destination,tar);assert.equal(restored.receipts,1);
  assert.equal(existsSync(join(destination,"work",job.id,"unneeded-render-cache.png")),false);
  store=new Store(destination);assert.equal(store.reviewSubmissions(project.id)[0].id,"history-1");
  const runner=new Jobs(store,providers,mockMedia());runner.stopped=true;offline=false;
  runner.retry(job.id,"download-after-restore");runner.stopped=false;await runner.tick();runner.stopped=true;
  assert.equal(store.job(job.id).state,"complete");assert.equal(posts,1);assert.equal(gets,2);
  store.close();
  const unpacked=join(root,"unpacked");mkdirSync(unpacked);await archive("unpack",tar,unpacked);
  writeFileSync(join(unpacked,"work",job.id,"image-receipt.json"),"tampered");
  const bad=join(root,"tampered.tar");await archive("pack",bad,unpacked);
  await assert.rejects(restore(destination,bad,true),/mismatch/);
  // A missing durable receipt must fail before either losing task evidence or replacing destination data.
  rmSync(join(data,"work",job.id,"image-receipt.json"));
  await assert.rejects(backup(data,join(root,"incomplete.tar")),/receipt is missing/);
 }finally{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});}
});
