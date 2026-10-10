import { configFromEnv, loadDotEnv } from "./config.ts";
import { Store } from "./store.ts";
import { Jobs } from "./jobs.ts";
import { Providers } from "./providers.ts";
import { createApp } from "./app.ts";
import { acquireDataLock } from "./data-lock.ts";
loadDotEnv();
const config = configFromEnv();
const release = acquireDataLock(config.dataDir, "runtime");
const store = new Store(config.dataDir);
if (config.adminPassword && !store.hasPassword())
  store.setPassword(config.adminPassword);
if (config.publicReviewProjectIds.length && !store.hasPassword()) {
  store.close(); release();
  throw new Error("Publishing review projects requires an existing administrator password or STORYFLOW_ADMIN_PASSWORD.");
}
const jobs = new Jobs(store, new Providers(config.providers));
const app = createApp(store, jobs, { publicBaseUrl: config.publicBaseUrl, publicReviewProjectIds: config.publicReviewProjectIds, publicReviewApiBase: config.publicReviewApiBase });
const server = app.listen(config.port, config.host, () => {
  jobs.start();
  console.log(`StoryFlow ready: http://${config.host}:${config.port}`);
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  jobs.stop();
  server.close();
  const deadline = Date.now() + 15000;
  while (jobs.busy && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  if (jobs.busy) {
    console.log(
      "Shutdown: active request will be reconciled from its persisted intent on restart.",
    );
    process.exit(0);
  }
  store.checkpoint();
  store.close();
  release();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
