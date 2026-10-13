import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Store } from "../server/store.ts";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("../", import.meta.url));
const workerPath = fileURLToPath(new URL("./fixtures/process-recovery-worker.ts", import.meta.url));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type EventKind = "submit" | "poll" | "download";
interface LedgerEntry { sequence: number; kind: EventKind; path: string; bodyHash?: string }

function withDeadline<T>(promise: Promise<T>, explanation: string, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(explanation)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startWorker(directory: string, baseUrl: string, mode = "run") {
  // Do not forward .env, provider credentials or NODE_OPTIONS into the fixture.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8" };
  for (const name of ["FFMPEG_PATH", "FFMPEG", "FFPROBE_PATH", "FFPROBE", "TMPDIR", "SYSTEMROOT"])
    if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ["--import", "tsx", workerPath, directory, baseUrl, mode], {
    cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const events = new EventEmitter();
  const messages: any[] = [];
  let diagnostics = "";
  child.stdout!.on("data", data => { diagnostics = (diagnostics + data).slice(-8000); });
  child.stderr!.on("data", data => { diagnostics = (diagnostics + data).slice(-8000); });
  child.on("message", value => { messages.push(value); events.emit("update"); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { resolve({ code, signal }); events.emit("update"); });
  });
  // Prevent an unhandled rejection if process startup fails before a checkpoint.
  void exited.catch(() => {});
  return {
    child,
    async checkpoint(name: string) {
      const promise = new Promise<any>((resolve, reject) => {
        const inspect = () => {
          const message = messages.find(value => value?.checkpoint === name);
          if (message) { events.off("update", inspect); resolve(message); }
          else if (child.exitCode !== null || child.signalCode !== null) {
            events.off("update", inspect);
            reject(new Error(`Worker exited before ${name}: ${diagnostics}`));
          }
        };
        events.on("update", inspect);
        inspect();
      });
      return withDeadline(promise, `Worker did not reach ${name}: ${diagnostics}`);
    },
    async kill() {
      assert.equal(child.kill("SIGKILL"), true, "A live OS process must be killed");
      const result = await withDeadline(exited, "SIGKILL child did not exit");
      assert.equal(result.signal, "SIGKILL");
      assert.equal(result.code, null);
    },
    async complete() {
      const result = await withDeadline(exited, "Recovered worker did not exit");
      assert.equal(result.signal, null, diagnostics);
      assert.equal(result.code, 0, diagnostics);
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.catch(() => {});
    },
  };
}

async function providerFixture(root: string, hold: EventKind | "none") {
  const mediaPath = join(root, "provider-output.mp4");
  await exec(process.env.FFMPEG_PATH || process.env.FFMPEG || "ffmpeg", [
    "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=4",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-t", "4", "-movflags", "+faststart", mediaPath,
  ], { timeout: 15000, maxBuffer: 1024 * 1024 });
  const media = readFileSync(mediaPath);
  const ledgerPath = join(root, "provider-ledger.jsonl");
  const ledger = openSync(ledgerPath, "wx", 0o600);
  const entries: LedgerEntry[] = [];
  const events = new EventEmitter();
  const held = new Set<ServerResponse>();
  const errors: Error[] = [];
  let holdUsed = false;
  let origin = "";
  const append = (kind: EventKind, path: string, body?: Buffer) => {
    const entry: LedgerEntry = { sequence: entries.length + 1, kind, path, ...(body ? { bodyHash: sha256(body) } : {}) };
    writeSync(ledger, `${JSON.stringify(entry)}\n`);
    fsyncSync(ledger);
    entries.push(entry);
    events.emit(kind);
    return entry;
  };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer fixture-not-a-real-credential");
      const path = request.url!;
      let kind: EventKind;
      if (request.method === "POST" && path === "/video/generations") {
        const parts: Buffer[] = [];
        for await (const chunk of request) parts.push(Buffer.from(chunk));
        const body = Buffer.concat(parts);
        assert.equal(JSON.parse(body.toString()).model, "process-recovery-fixture");
        kind = "submit";
        append(kind, path, body);
      } else if (request.method === "GET" && path === "/video/generations/accepted-task-1") {
        kind = "poll";
        append(kind, path);
      } else if (request.method === "GET" && path === "/media/accepted-task-1.mp4") {
        kind = "download";
        append(kind, path);
      } else throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
      if (kind === hold && !holdUsed) {
        holdUsed = true;
        held.add(response);
        response.once("close", () => held.delete(response));
        return; // The child is killed while this actual HTTP request is in flight.
      }
      if (kind === "download") {
        response.writeHead(200, { "content-type": "video/mp4", "content-length": media.length });
        response.end(media);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(kind === "submit"
          ? { task_id: "accepted-task-1", model: "process-recovery-fixture" }
          : { status: "COMPLETED", result_url: `${origin}/media/accepted-task-1.mp4`, model: "process-recovery-fixture" }));
      }
    } catch (error) {
      errors.push(error as Error);
      response.writeHead(500).end("Fixture failure");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, media, mediaPath,
    async saw(kind: EventKind) {
      if (entries.some(entry => entry.kind === kind)) return;
      await withDeadline(new Promise<void>(resolve => events.once(kind, resolve)), `No real HTTP ${kind} reached fixture`);
    },
    records(): LedgerEntry[] {
      // All count assertions read the durable provider-side ledger, not a mock's in-memory count.
      const text = readFileSync(ledgerPath, "utf8").trim();
      return text ? text.split("\n").map(line => JSON.parse(line)) : [];
    },
    assertHealthy() { assert.deepEqual(errors, []); },
    async close() {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      closeSync(ledger);
    },
  };
}

function inspect<T>(directory: string, fn: (store: Store) => T): T {
  const store = new Store(directory);
  try {
    assert.equal((store.db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
    assert.equal((store.db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "wal");
    return fn(store);
  } finally { store.close(); }
}

for (const beforePost of [true, false]) {
  test(`SIGKILL ${beforePost ? "after durable intent before HTTP POST" : "after provider accepted POST before receipt"} stays uncertain across cold restarts`, { timeout: 45000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "storyflow-process-unknown-"));
    const directory = join(root, "database");
    const children: ReturnType<typeof startWorker>[] = [];
    let provider: Awaited<ReturnType<typeof providerFixture>> | undefined;
    try {
      provider = await providerFixture(root, "submit");
      const first = startWorker(directory, provider.origin, beforePost ? "before-post" : "run");
      children.push(first);
      const ready = await first.checkpoint("ready");
      if (beforePost) await first.checkpoint("before-post");
      else await provider.saw("submit");
      inspect(directory, store => {
        const job = store.job(ready.jobId);
        assert.equal(job.state, "running");
        assert.equal(job.stage, "submitting");
        assert.equal(job.attempts, 1);
        assert.equal(job.handle, undefined);
        assert.match(job.result.request.requestHash, /^[a-f0-9]{64}$/);
        if (!beforePost)
          assert.equal(job.result.request.requestHash, provider!.records()[0].bodyHash,
            "The WAL intent must describe the exact HTTP body the provider accepted");
      });
      await first.kill();
      for (let restart = 0; restart < 2; restart++) {
        const recovered = startWorker(directory, provider.origin);
        children.push(recovered);
        assert.equal((await recovered.checkpoint("done")).state, "uncertain");
        await recovered.complete();
        inspect(directory, store => {
          const job = store.job(ready.jobId);
          assert.equal(job.state, "uncertain");
          assert.equal(job.stage, "acceptance_unknown");
          assert.equal(job.attempts, 1);
          assert.equal(store.jobs().length, 1, "Same idempotency key must survive a real process death");
          assert.equal(store.artifacts(ready.projectId).length, 0);
        });
      }
      assert.deepEqual(provider.records().map(entry => entry.kind), beforePost ? [] : ["submit"]);
      provider.assertHealthy();
    } finally {
      for (const child of children) await child.cleanup();
      await provider?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const hold of ["poll", "download"] as const) {
  test(`SIGKILL during HTTP ${hold} resumes persisted handle without a second POST and publishes one matching media artifact`, { timeout: 45000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "storyflow-process-handle-"));
    const directory = join(root, "database");
    const children: ReturnType<typeof startWorker>[] = [];
    let provider: Awaited<ReturnType<typeof providerFixture>> | undefined;
    try {
      provider = await providerFixture(root, hold);
      const first = startWorker(directory, provider.origin);
      children.push(first);
      const ready = await first.checkpoint("ready");
      await provider.saw(hold);
      inspect(directory, store => {
        const job = store.job(ready.jobId);
        assert.equal(job.state, "running");
        assert.equal(job.stage, hold === "poll" ? "polling" : "downloading");
        assert.equal(job.handle?.id, "accepted-task-1");
        assert.equal(job.handle?.baseUrl, provider!.origin);
        assert.equal(job.attempts, 1);
        assert.equal(job.handle?.requestHash, provider!.records()[0].bodyHash);
      });
      await first.kill();
      const recovered = startWorker(directory, provider.origin);
      children.push(recovered);
      assert.equal((await recovered.checkpoint("done")).state, "complete");
      await recovered.complete();
      const completed = inspect(directory, store => {
        const job = store.job(ready.jobId);
        const artifacts = store.artifacts(ready.projectId);
        assert.equal(job.state, "complete");
        assert.equal(job.attempts, 1);
        assert.equal(store.jobs().length, 1);
        assert.equal(artifacts.length, 1);
        const artifact = artifacts[0];
        assert.equal(artifact.jobId, ready.jobId);
        assert.equal(job.result.artifactId, artifact.id);
        assert.equal(artifact.metadata.providerTaskId, "accepted-task-1");
        assert.equal(artifact.metadata.duration, 4);
        const video = artifact.metadata.video as { frames: number; fps: number };
        assert.equal(video.frames, 100);
        assert.equal(video.fps, 25);
        assert(artifact.metadata.audio, "Real FFprobe must see the synthetic audio stream");
        assert.equal(store.file(artifact.fileId).sha256, sha256(provider!.media));
        assert.deepEqual(store.bytes(artifact.fileId), provider!.media);
        return { artifactId: artifact.id, fileId: artifact.fileId, sha256: store.file(artifact.fileId).sha256 };
      });
      const ledgerBefore = provider.records();
      assert.deepEqual(ledgerBefore.map(entry => entry.kind), hold === "poll"
        ? ["submit", "poll", "poll", "download"]
        : ["submit", "poll", "download", "poll", "download"]);
      // A third OS process exercises startup, repeated enqueue and repeated ticks
      // after completion. None may re-poll, re-download or create a candidate.
      const onceMore = startWorker(directory, provider.origin);
      children.push(onceMore);
      assert.equal((await onceMore.checkpoint("done")).state, "complete");
      await onceMore.complete();
      assert.deepEqual(provider.records(), ledgerBefore);
      inspect(directory, store => {
        assert.equal(store.jobs().length, 1);
        const artifacts = store.artifacts(ready.projectId);
        assert.equal(artifacts.length, 1);
        assert.equal(artifacts[0].id, completed.artifactId);
        assert.equal(artifacts[0].fileId, completed.fileId);
        assert.equal(store.file(completed.fileId).sha256, completed.sha256);
      });
      provider.assertHealthy();
    } finally {
      for (const child of children) await child.cleanup();
      await provider?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
