import { loadDotEnv, configFromEnv } from "../server/config.ts";
import { acquireDataLock } from "../server/data-lock.ts";
import { Store } from "../server/store.ts";
loadDotEnv();
const config = configFromEnv(),
  release = acquireDataLock(config.dataDir, "runtime");
try {
  const store = new Store(config.dataDir);
  try {
    if (config.adminPassword && !store.hasPassword())
      store.setPassword(config.adminPassword);
    console.log(
      JSON.stringify({
        initialized: true,
        schemaVersion: 1,
        adminConfigured: store.hasPassword(),
      }),
    );
    store.checkpoint();
  } finally {
    store.close();
  }
} finally {
  release();
}
