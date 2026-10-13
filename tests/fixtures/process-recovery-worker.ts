/** Actual isolated scheduler process used by process-recovery.test.ts.
 * No provider environment/configuration is loaded: every request is restricted
 * to the parent test's loopback HTTP server and uses a synthetic credential.
 */
import assert from "node:assert/strict";
import { Jobs } from "../../server/jobs.ts";
import { Providers } from "../../server/providers.ts";
import { Store } from "../../server/store.ts";
import type { Job } from "../../shared/types.ts";
import { fixture, requirements } from "../helpers.ts";

const [directory, baseUrl, mode] = process.argv.slice(2);
assert(directory && baseUrl && ["run", "before-post"].includes(mode));
const endpoint = new URL(baseUrl);
assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(endpoint.protocol, "http:");
assert(process.send, "This fixture requires the test's IPC channel");

function send(value: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send!(value, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve());
  });
}

const store = new Store(directory);
let jobs: Jobs | undefined;
// Keep the process alive at a deliberately suspended pre-POST fault point.
const alive = setInterval(() => {}, 60000);
try {
  const providers = new Providers({
    seedanceBase: baseUrl,
    seedanceKey: "fixture-not-a-real-credential",
    seedanceModel: "process-recovery-fixture",
    falKey: "", falBase: "", opusBase: "", opusKey: "", opusModel: "",
    allowPrivate: true,
  }, {
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, endpoint.origin, "Fixture must never contact a real provider");
      if (mode === "before-post" && init?.method === "POST") {
        // Providers already awaited Jobs' durable intent callback. The only
        // injected behavior is pausing before the real network syscall.
        await send({ checkpoint: "before-post" });
        await new Promise<never>(() => {});
      }
      return fetch(input, init);
    }) as typeof fetch,
  });
  jobs = new Jobs(store, providers);
  jobs.stop();
  if (!store.list().length) {
    const ontology = fixture();
    ontology.spec.width = 160;
    ontology.spec.height = 96;
    const project = store.create("Process recovery fixture", { ...requirements, aspect: "16:9" }, ontology);
    store.review(project.id, "s1", "pass", "Synthetic fixture only");
  }
  assert.equal(store.list().length, 1);
  const project = store.project(store.list()[0].id);
  jobs.recover();
  const key = "process-recovery-single-submit";
  const first = jobs.enqueueRun(project.id, project.revision, key);
  const repeated = jobs.enqueueRun(project.id, project.revision, key);
  assert.deepEqual(repeated.jobs.map((job: Job) => job.id), first.jobs.map((job: Job) => job.id));
  assert.equal(first.jobs.length, 1);
  await send({ checkpoint: "ready", projectId: project.id, jobId: first.jobs[0].id });
  for (let attempt = 0; attempt < 4; attempt++) {
    jobs.stopped = false;
    await jobs.tick();
    jobs.stop();
  }
  const job = store.job(first.jobs[0].id);
  if (job.state === "uncertain") {
    assert.throws(() => jobs!.retry(job.id, "must-not-retry-unknown"), /受理不明/);
  }
  await send({ checkpoint: "done", jobId: job.id, state: job.state });
} finally {
  jobs?.stop();
  clearInterval(alive);
  store.close();
  process.disconnect?.();
}
