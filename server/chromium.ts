import { existsSync } from "node:fs";
import { chromium } from "playwright";
import type { LaunchOptions } from "playwright";
export function chromiumOptions(): LaunchOptions {
  const base: LaunchOptions = {
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu"],
  };
  if (process.env.CHROMIUM_PATH)
    return { ...base, executablePath: process.env.CHROMIUM_PATH };
  if (process.env.STORYFLOW_BROWSER_CHANNEL)
    return { ...base, channel: process.env.STORYFLOW_BROWSER_CHANNEL };
  if (existsSync(chromium.executablePath())) return base;
  if (
    process.platform === "darwin" &&
    existsSync("/Applications/Google Chrome.app")
  )
    return { ...base, channel: "chrome" };
  return base;
}
